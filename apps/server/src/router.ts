import { initTRPC } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  assignStablePorts,
  createSub2ApiClient,
  enumeratePorts,
  findOccupiedPorts,
  groupAssignmentChangesByProxy,
  parsePortRange,
  parseSubscription,
  planSub2ApiAssignments,
  renderMihomoConfig,
  mapWithConcurrency,
  resolveProxyTestTargets,
  testProxyTarget
} from "@mihomo-hive/core";
import { exportSub2Api, previewSub2ApiExport } from "@mihomo-hive/exporters";
import { readMihomoStatus, reloadMihomo, startMihomo, stopMihomo } from "@mihomo-hive/mihomo";
import {
  sub2ApiAccountFiltersSchema,
  sub2ApiAssignmentApplyResultSchema,
  sub2ApiAssignmentOptionsSchema,
  sub2ApiConnectionConfigSchema,
  sub2ApiExportRequestSchema,
  sub2ApiProtectedProxyRuleSchema
} from "@mihomo-hive/schemas";
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
    previewSub2api: protectedProcedure.input(sub2ApiExportRequestSchema).query(({ ctx, input }) =>
      previewSub2ApiExport(ctx.repo.listNodes(), {
        host: input.host ?? ctx.config.exportHost,
        selectedHashes: input.selectedHashes
      })
    ),
    writeSub2api: protectedProcedure
      .input(
        sub2ApiExportRequestSchema.extend({
          output: z.string().optional()
        })
      )
      .mutation(async ({ ctx, input }) => {
        const payload = exportSub2Api(ctx.repo.listNodes(), {
          host: input.host ?? ctx.config.exportHost,
          selectedHashes: input.selectedHashes
        });
        const output = input.output ?? `${ctx.config.generatedDir}/sub2api-proxies.json`;
        await writeGenerated(output, `${JSON.stringify(payload, null, 2)}\n`);
        return { output, proxies: payload.proxies.length };
      })
  }),
  sub2api: t.router({
    config: t.router({
      get: protectedProcedure.query(({ ctx }) => ctx.repo.getSafeSub2ApiConnection()),
      save: protectedProcedure
        .input(
          sub2ApiConnectionConfigSchema.extend({
            adminApiKey: z.string().optional()
          })
        )
        .mutation(({ ctx, input }) => {
        const current = ctx.repo.getSub2ApiConnection();
        if (!input.adminApiKey && !current?.adminApiKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "请填写 Sub2API 管理员 API Key。" });
        }
        ctx.repo.setSub2ApiConnection({
          ...input,
          adminApiKey: input.adminApiKey || current?.adminApiKey || ""
        });
        return ctx.repo.getSafeSub2ApiConnection();
      }),
      test: protectedProcedure.mutation(async ({ ctx }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        return client.testConnection();
      })
    }),
    proxies: t.router({
      list: protectedProcedure.query(async ({ ctx }) => createConfiguredSub2ApiClient(ctx.repo).listAllProxies()),
      saveProtectedRule: protectedProcedure.input(sub2ApiProtectedProxyRuleSchema).mutation(({ ctx, input }) => {
        ctx.repo.setSub2ApiProtectedRule(input);
        return ctx.repo.getSub2ApiProtectedRule();
      }),
      protectedRule: protectedProcedure.query(({ ctx }) => ctx.repo.getSub2ApiProtectedRule())
    }),
    accounts: t.router({
      list: protectedProcedure
        .input(sub2ApiAccountFiltersSchema.optional())
        .query(async ({ ctx, input }) =>
          createConfiguredSub2ApiClient(ctx.repo).listAllAccounts(sub2ApiAccountFiltersSchema.parse(input ?? {}))
        )
    }),
    assign: t.router({
      preview: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).query(async ({ ctx, input }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const [proxies, accounts] = await Promise.all([
          client.listAllProxies(),
          client.listAllAccounts(input.filters)
        ]);
        return planSub2ApiAssignments({ proxies, accounts, options: input });
      }),
      applyChanges: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).mutation(async ({ ctx, input }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const [proxies, accounts] = await Promise.all([
          client.listAllProxies(),
          client.listAllAccounts(input.filters)
        ]);
        const preview = planSub2ApiAssignments({ proxies, accounts, options: input });
        if (preview.errors.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: preview.errors.join("；") });
        }

        const results = [];
        const successIds: number[] = [];
        const failedIds: number[] = [];
        for (const batch of groupAssignmentChangesByProxy(preview.changes)) {
          const result = await client.bulkUpdateProxy(batch.accountIds, batch.proxyId);
          successIds.push(...result.successIds);
          failedIds.push(...result.failedIds);
          for (const item of result.results) {
            results.push({ ...item, proxyId: batch.proxyId });
          }
          for (const id of result.successIds) {
            if (!results.some((item) => item.accountId === id)) {
              results.push({ accountId: id, proxyId: batch.proxyId, success: true });
            }
          }
          for (const id of result.failedIds) {
            if (!results.some((item) => item.accountId === id)) {
              results.push({ accountId: id, proxyId: batch.proxyId, success: false });
            }
          }
        }

        const finalSuccessIds = Array.from(new Set([...successIds, ...results.filter((item) => item.success).map((item) => item.accountId)]));
        const finalFailedIds = Array.from(new Set([...failedIds, ...results.filter((item) => !item.success).map((item) => item.accountId)]));
        return sub2ApiAssignmentApplyResultSchema.parse({
          preview,
          success: finalSuccessIds.length,
          failed: finalFailedIds.length,
          successIds: finalSuccessIds,
          failedIds: finalFailedIds,
          results
        });
      })
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

function createConfiguredSub2ApiClient(repo: HiveRepository) {
  const connection = repo.getSub2ApiConnection();
  if (!connection) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 地址和管理员 API Key。" });
  }
  return createSub2ApiClient(connection);
}
