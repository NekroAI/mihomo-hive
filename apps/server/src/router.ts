import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
  assignStablePorts,
  enumeratePorts,
  findOccupiedPorts,
  parsePortRange,
  parseSubscription,
  renderMihomoConfig
} from "@mihomo-hive/core";
import { exportSub2Api } from "@mihomo-hive/exporters";
import { readMihomoStatus, reloadMihomo, startMihomo, stopMihomo } from "@mihomo-hive/mihomo";
import type { HiveRepository } from "@mihomo-hive/db";
import type { RuntimeConfig, SubscriptionSource } from "@mihomo-hive/schemas";

export interface RouterContext {
  config: RuntimeConfig;
  repo: HiveRepository;
}

const t = initTRPC.context<RouterContext>().create();

export const appRouter = t.router({
  runtime: t.router({
    config: t.procedure.query(({ ctx }) => ctx.config),
    status: t.procedure.query(async ({ ctx }) => readMihomoStatus(ctx.config))
  }),
  subscriptions: t.router({
    list: t.procedure.query(({ ctx }) => ctx.repo.listSubscriptions().map(summarizeSubscription)),
    fetch: t.procedure.mutation(async ({ ctx }) => {
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
    list: t.procedure.query(({ ctx }) => ctx.repo.listNodes()),
    import: t.procedure.mutation(async ({ ctx }) => {
      let imported = 0;
      for (const source of ctx.repo.listSubscriptions().filter((item) => item.enabled)) {
        const content = source.lastContent ?? (await ctx.repo.fetchSubscriptionContent(source));
        const nodes = parseSubscription(content, source.id);
        ctx.repo.upsertNodes(nodes);
        imported += nodes.length;
      }
      return { imported };
    }),
    assignPorts: t.procedure
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
      })
  }),
  mihomo: t.router({
    render: t.procedure.mutation(({ ctx }) => renderMihomoConfig(ctx.repo.listNodes(), ctx.config)),
    start: t.procedure.mutation(({ ctx }) => startMihomo(ctx.config)),
    stop: t.procedure.mutation(({ ctx }) => stopMihomo(ctx.config)),
    reload: t.procedure.mutation(({ ctx }) => reloadMihomo(ctx.config))
  }),
  exports: t.router({
    sub2api: t.procedure
      .input(z.object({ host: z.string().optional() }).optional())
      .query(({ ctx, input }) => exportSub2Api(ctx.repo.listNodes(), { host: input?.host ?? ctx.config.exportHost }))
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
