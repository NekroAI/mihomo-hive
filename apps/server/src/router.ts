import { initTRPC } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  assignStablePorts,
  enumeratePorts,
  findOccupiedPorts,
  parsePortRange,
  parseSubscription,
  renderMihomoConfig,
  mapWithConcurrency,
  resolveProxyTestTargets,
  testProxyTarget
} from "@mihomo-hive/core";
import { exportSub2Api } from "@mihomo-hive/exporters";
import { readMihomoStatus, reloadMihomo, startMihomo, stopMihomo } from "@mihomo-hive/mihomo";
import type { HiveRepository } from "@mihomo-hive/db";
import type { RuntimeConfig, SubscriptionSource } from "@mihomo-hive/schemas";

export interface RouterContext {
  config: RuntimeConfig;
  repo: HiveRepository;
  authenticated: boolean;
}

const t = initTRPC.context<RouterContext>().create();
const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.authenticated) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next();
});

export const appRouter = t.router({
  runtime: t.router({
    config: protectedProcedure.query(({ ctx }) => ctx.config),
    status: protectedProcedure.query(async ({ ctx }) => readMihomoStatus(ctx.config))
  }),
  subscriptions: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.repo.listSubscriptions().map(summarizeSubscription)),
    add: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          url: z.string().url()
        })
      )
      .mutation(({ ctx, input }) =>
        summarizeSubscription(
          ctx.repo.addSubscription({
            id: randomUUID(),
            name: input.name,
            kind: "url",
            value: input.url
          })
        )
      ),
    fetch: protectedProcedure.mutation(async ({ ctx }) => {
      const results = [];
      for (const source of ctx.repo.listSubscriptions().filter((item) => item.enabled)) {
        const content = await ctx.repo.fetchSubscriptionContent(source);
        ctx.repo.updateSubscriptionContent(source.id, content);
        results.push({ id: source.id, name: source.name, bytes: content.length });
      }
      return results;
    })
  }),
  nodes: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.repo.listNodes()),
    import: protectedProcedure.mutation(async ({ ctx }) => {
      let imported = 0;
      for (const source of ctx.repo.listSubscriptions().filter((item) => item.enabled)) {
        const content = source.lastContent ?? (await ctx.repo.fetchSubscriptionContent(source));
        const nodes = parseSubscription(content, source.id);
        ctx.repo.upsertNodes(nodes);
        imported += nodes.length;
      }
      return { imported };
    }),
    assignPorts: protectedProcedure
      .input(z.object({ range: z.string().optional(), skipPortCheck: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        ctx.repo.setAllUntestedActive();
        const range = input.range
          ? parsePortRange(input.range)
          : { start: ctx.config.portRangeStart, end: ctx.config.portRangeEnd };
        const occupied = input.skipPortCheck
          ? new Set<number>()
          : await findOccupiedPorts(ctx.config.listenHost, enumeratePorts(range));
        const nodes = assignStablePorts({
          nodes: ctx.repo.listNodes(),
          range,
          occupiedPorts: occupied
        });
        ctx.repo.saveNodes(nodes);
        return { assigned: nodes.filter((node) => node.assignedPort).length, occupied: occupied.size };
      }),
    test: protectedProcedure
      .input(
        z.object({
          targets: z.array(z.string()).default(["openai", "claude"]),
          host: z.string().optional(),
          timeoutMs: z.number().int().positive().default(15_000),
          concurrency: z.number().int().positive().max(32).default(8)
        })
      )
      .mutation(async ({ ctx, input }) => {
        const targets = resolveProxyTestTargets(input.targets);
        const host = input.host ?? ctx.config.listenHost;
        const candidates = ctx.repo.listNodes().filter((node) => node.assignedPort);
        const tested = await mapWithConcurrency(candidates, input.concurrency, async (node) => {
          const results = [];
          for (const target of targets) {
            results.push(
              await testProxyTarget({
                host,
                port: Number(node.assignedPort),
                target,
                timeoutMs: input.timeoutMs
              })
            );
          }
          const passed = results.every((result) => result.ok);
          return {
            ...node,
            status: passed ? ("active" as const) : ("failed" as const),
            lastTestStatus: results
              .map((result) => `${result.targetId}:${result.httpStatus ?? result.message}`)
              .join(","),
            lastTestLatencyMs: Math.max(...results.map((result) => result.latencyMs))
          };
        });
        ctx.repo.saveNodes(tested);
        return {
          tested: tested.length,
          passed: tested.filter((node) => node.status === "active").length,
          failed: tested.filter((node) => node.status === "failed").length
        };
      })
  }),
  mihomo: t.router({
    render: protectedProcedure.mutation(async ({ ctx }) => {
      const rendered = renderMihomoConfig(ctx.repo.listNodes(), ctx.config);
      await writeGenerated(ctx.config.mihomoConfigPath, rendered.yaml);
      await writeGenerated(`${ctx.config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
      return { listeners: rendered.egressMap.length };
    }),
    start: protectedProcedure.mutation(({ ctx }) => startMihomo(ctx.config)),
    stop: protectedProcedure.mutation(({ ctx }) => stopMihomo(ctx.config)),
    reload: protectedProcedure.mutation(({ ctx }) => reloadMihomo(ctx.config))
  }),
  exports: t.router({
    sub2api: protectedProcedure
      .input(z.object({ host: z.string().optional() }).optional())
      .query(({ ctx, input }) => exportSub2Api(ctx.repo.listNodes(), { host: input?.host ?? ctx.config.exportHost })),
    writeSub2api: protectedProcedure
      .input(z.object({ host: z.string().optional(), output: z.string().optional() }).optional())
      .mutation(async ({ ctx, input }) => {
        const payload = exportSub2Api(ctx.repo.listNodes(), { host: input?.host ?? ctx.config.exportHost });
        const output = input?.output ?? `${ctx.config.generatedDir}/sub2api-proxies.json`;
        await writeGenerated(output, `${JSON.stringify(payload, null, 2)}\n`);
        return { output, proxies: payload.proxies.length };
      })
  })
});

export type AppRouter = typeof appRouter;

function summarizeSubscription(source: SubscriptionSource) {
  const { lastContent, ...safeSource } = source;
  return {
    ...safeSource,
    value: source.kind === "url" ? redactUrl(source.value) : source.value,
    fetched: Boolean(lastContent),
    ...(lastContent ? { lastContentBytes: lastContent.length } : {})
  };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = url.search ? "?..." : "";
    return url.toString();
  } catch {
    return "<redacted>";
  }
}

async function writeGenerated(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
