import { initTRPC } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  assignStablePorts,
  buildNodeDeletionPlan,
  buildSubscriptionImportPreview,
  createSub2ApiClient,
  enumeratePorts,
  filterPreviewImportableNodes,
  filteredExistingNodeHashes,
  findOccupiedPorts,
  groupAssignmentChangesByProxy,
  mapLocalNodesToSub2ApiProxies,
  mapWithConcurrency,
  parsePortRange,
  planSub2ApiAssignments,
  planSub2ApiManagedMaintenance,
  renderMihomoConfig,
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
import type {
  OperationJob,
  OperationJobStatus,
  ProxyNode,
  RuntimeConfig,
  Sub2ApiAccountRecord,
  Sub2ApiProtectedProxyRule,
  Sub2ApiProxyRecord,
  SubscriptionSource
} from "@mihomo-hive/schemas";

export interface RouterContext {
  config: RuntimeConfig;
  repo: HiveRepository;
  authenticated: boolean;
}

const t = initTRPC.context<RouterContext>().create();
const operationJobs = new Map<string, OperationJob>();

const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.authenticated) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next();
});

export const appRouter = t.router({
  runtime: t.router({
    config: protectedProcedure.query(({ ctx }) => ctx.config),
    status: protectedProcedure.query(async ({ ctx }) => readMihomoStatus(ctx.config)),
    publish: protectedProcedure.mutation(async ({ ctx }) => {
      const job = createJob("runtime.publish", "正在发布出口池", "生成 Mihomo 配置并应用到运行进程。", [
        "渲染配置",
        "应用进程"
      ]);
      try {
        updateJobStep(job.id, 0, "running", "正在渲染 Mihomo 配置。");
        const current = await readMihomoStatus(ctx.config);
        const range = { start: ctx.config.portRangeStart, end: ctx.config.portRangeEnd };
        const occupied = current.running ? new Set<number>() : await findOccupiedPorts(ctx.config.listenHost, enumeratePorts(range));
        const assignedNodes = assignStablePorts({
          nodes: ctx.repo.listNodes(),
          range,
          occupiedPorts: occupied,
          preserveExisting: true
        });
        ctx.repo.saveNodes(assignedNodes);
        const rendered = renderMihomoConfig(assignedNodes, ctx.config);
        await writeGenerated(ctx.config.mihomoConfigPath, rendered.yaml);
        await writeGenerated(`${ctx.config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
        updateJobStep(job.id, 0, "success", `生成 ${rendered.egressMap.length} 个 listener。`);

        updateJobStep(job.id, 1, "running", "正在启动或重载 Mihomo。");
        const status = current.running ? await reloadMihomo(ctx.config) : await startMihomo(ctx.config);
        updateJobStep(job.id, 1, "success", status.running ? "Mihomo 已运行。" : "未确认 Mihomo 运行状态。");
        finishJob(job.id, "success", "出口池发布完成。");
        return { job: operationJobs.get(job.id), listeners: rendered.egressMap.length, status };
      } catch (error) {
        finishJob(job.id, "failed", error instanceof Error ? error.message : "未知错误");
        throw error;
      }
    })
  }),

  subscriptions: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.repo.listSubscriptions().map(summarizeSubscription)),
    previewImport: protectedProcedure
      .input(
        z.object({
          id: z.string().optional(),
          name: z.string().min(1).optional(),
          url: z.string().url().optional(),
          excludeKeywords: z.array(z.string()).default([])
        })
      )
      .mutation(async ({ ctx, input }) => {
        const source = resolvePreviewSource(ctx.repo, input);
        const content = await fetchSourceContent(ctx.repo, source);
        return buildSubscriptionImportPreview({
          source,
          content,
          existingNodes: ctx.repo.listNodes(),
          excludeKeywords: input.excludeKeywords.length > 0 ? input.excludeKeywords : source.excludeKeywords
        });
      }),
    applyImport: protectedProcedure
      .input(
        z.object({
          id: z.string().optional(),
          name: z.string().min(1),
          url: z.string().url(),
          excludeKeywords: z.array(z.string()).default([])
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = input.id ? ctx.repo.listSubscriptions().find((item) => item.id === input.id) : undefined;
        const source =
          existing ??
          ctx.repo.addSubscription({
            id: input.id ?? randomUUID(),
            name: input.name,
            kind: "url",
            value: input.url
          });
        const filteredSource = ctx.repo.updateSubscriptionFilters(source.id, input.excludeKeywords);
        const content = await ctx.repo.fetchSubscriptionContent(filteredSource);
        ctx.repo.updateSubscriptionContent(filteredSource.id, content);
        const nodes = filterPreviewImportableNodes({
          source: filteredSource,
          content,
          existingNodes: ctx.repo.listNodes(),
          excludeKeywords: filteredSource.excludeKeywords
        }).map((node) => ({
          ...node,
          lifecycleStatus: "candidate" as const,
          schedulable: false
        }));
        const deleteHashes = filteredExistingNodeHashes({
          source: filteredSource,
          content,
          existingNodes: ctx.repo.listNodes(),
          excludeKeywords: filteredSource.excludeKeywords
        });
        const deletedByFilter = ctx.repo.deleteNodes(deleteHashes);
        ctx.repo.upsertNodes(nodes);
        return { imported: nodes.length, deletedByFilter, sourceId: filteredSource.id };
      }),
    add: protectedProcedure
      .input(z.object({ name: z.string().min(1), url: z.string().url() }))
      .mutation(({ ctx, input }) =>
        summarizeSubscription(ctx.repo.addSubscription({ id: randomUUID(), name: input.name, kind: "url", value: input.url }))
      ),
    fetch: protectedProcedure.mutation(async ({ ctx }) => {
      const results = [];
      for (const source of ctx.repo.listSubscriptions().filter((item) => item.enabled)) {
        const content = await ctx.repo.fetchSubscriptionContent(source);
        ctx.repo.updateSubscriptionContent(source.id, content);
        results.push({ id: source.id, name: source.name, bytes: content.length });
      }
      return results;
    }),
    updateFilters: protectedProcedure
      .input(z.object({ id: z.string().min(1), excludeKeywords: z.array(z.string()).default([]) }))
      .mutation(({ ctx, input }) => summarizeSubscription(ctx.repo.updateSubscriptionFilters(input.id, input.excludeKeywords))),
    delete: protectedProcedure.input(z.object({ id: z.string().min(1) })).mutation(({ ctx, input }) => {
      ctx.repo.deleteSubscription(input.id);
      return { ok: true };
    })
  }),

  nodes: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.repo.listNodes()),
    setLifecycle: protectedProcedure
      .input(
        z.object({
          hashes: z.array(z.string().min(8)).min(1),
          lifecycleStatus: z.enum(["candidate", "testing", "schedulable", "disabled", "draining", "cooling_down", "retired"])
        })
      )
      .mutation(({ ctx, input }) => {
        const nodes = ctx.repo.markNodesLifecycle(input.hashes, input.lifecycleStatus);
        return { updated: nodes.length, nodes };
      }),
    previewDelete: protectedProcedure.input(z.object({ hashes: z.array(z.string().min(8)).min(1) })).query(async ({ ctx, input }) => {
      const nodes = selectNodes(ctx.repo.listNodes(), input.hashes);
      const snapshot = await loadSub2ApiSnapshot(ctx.repo);
      return buildNodeDeletionPlan({ nodes, proxies: snapshot.proxies, accounts: snapshot.accounts, exportHost: ctx.config.exportHost });
    }),
    applyDelete: protectedProcedure
      .input(z.object({ hashes: z.array(z.string().min(8)).min(1), forceLocal: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        const nodes = selectNodes(ctx.repo.listNodes(), input.hashes);
        const snapshot = await loadSub2ApiSnapshot(ctx.repo);
        const plan = buildNodeDeletionPlan({ nodes, proxies: snapshot.proxies, accounts: snapshot.accounts, exportHost: ctx.config.exportHost });
        if (!plan.canDeleteNow && !input.forceLocal) {
          throw new TRPCError({ code: "BAD_REQUEST", message: plan.message });
        }
        if (snapshot.client && plan.canDeleteNow) {
          const mappings = mapLocalNodesToSub2ApiProxies({ nodes, proxies: snapshot.proxies, exportHost: ctx.config.exportHost });
          for (const mapping of mappings) {
            await snapshot.client.deleteProxy(mapping.proxyId);
          }
        }
        return { deleted: ctx.repo.deleteNodes(input.hashes), plan };
      }),
    import: protectedProcedure.mutation(async ({ ctx }) => {
      let imported = 0;
      for (const source of ctx.repo.listSubscriptions().filter((item) => item.enabled)) {
        const content = source.lastContent ?? (await ctx.repo.fetchSubscriptionContent(source));
        const nodes = filterPreviewImportableNodes({
          source,
          content,
          existingNodes: ctx.repo.listNodes(),
          excludeKeywords: source.excludeKeywords
        });
        ctx.repo.upsertNodes(nodes);
        imported += nodes.length;
      }
      return { imported };
    }),
    assignPorts: protectedProcedure
      .input(z.object({ range: z.string().optional(), skipPortCheck: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        const mihomoStatus = await readMihomoStatus(ctx.config);
        if (mihomoStatus.running) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Mihomo 运行中不能重新分配端口，请先停止 Mihomo。" });
        }
        const range = input.range ? parsePortRange(input.range) : { start: ctx.config.portRangeStart, end: ctx.config.portRangeEnd };
        const occupied = input.skipPortCheck ? new Set<number>() : await findOccupiedPorts(ctx.config.listenHost, enumeratePorts(range));
        const nodes = assignStablePorts({ nodes: ctx.repo.listNodes(), range, occupiedPorts: occupied, preserveExisting: false });
        ctx.repo.saveNodes(nodes);
        return { assigned: nodes.filter((node) => node.assignedPort).length, occupied: occupied.size };
      }),
    enableAllCandidates: protectedProcedure.mutation(({ ctx }) => {
      // 把所有 untested/candidate 节点显式提升为 schedulable；触发后 assignPorts/publish 才会
      // 把它们纳入端口池。明确动作避免之前 assignPorts 隐式 setAllUntestedActive 让用户无感
      // 启用所有节点造成的"为什么所有节点都占了端口"的困惑。
      ctx.repo.setAllUntestedActive();
      const nodes = ctx.repo.listNodes();
      return {
        promoted: nodes.filter((node) => node.lifecycleStatus === "schedulable" && !node.assignedPort).length,
        total: nodes.length
      };
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
        const candidates = ctx.repo.listNodes().filter((node) => node.assignedPort && node.lifecycleStatus !== "retired");
        const tested = await mapWithConcurrency(candidates, input.concurrency, async (node) => {
          const results = [];
          for (const target of targets) {
            results.push(await testProxyTarget({ host, port: Number(node.assignedPort), target, timeoutMs: input.timeoutMs }));
          }
          const passed = results.every((result) => result.ok);
          return {
            ...node,
            status: passed ? ("active" as const) : ("failed" as const),
            lifecycleStatus: passed ? ("schedulable" as const) : ("cooling_down" as const),
            schedulable: passed,
            qualityScore: passed ? 100 : 25,
            lastTestStatus: results.map((result) => `${result.targetId}:${result.httpStatus ?? result.message}`).join(","),
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
        selectedHashes: input.selectedHashes,
        failedNodeStatus: input.failedNodeStatus,
        namePrefix: ctx.repo.getSub2ApiConnection()?.managedProxyPrefix
      })
    ),
    writeSub2api: protectedProcedure
      .input(sub2ApiExportRequestSchema.extend({ output: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const payload = exportSub2Api(ctx.repo.listNodes(), {
          host: input.host ?? ctx.config.exportHost,
          selectedHashes: input.selectedHashes,
          failedNodeStatus: input.failedNodeStatus,
          namePrefix: ctx.repo.getSub2ApiConnection()?.managedProxyPrefix
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
        .input(sub2ApiConnectionConfigSchema.extend({ adminApiKey: z.string().optional() }))
        .mutation(({ ctx, input }) => {
          const current = ctx.repo.getSub2ApiConnection();
          if (!input.adminApiKey && !current?.adminApiKey) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "请填写 Sub2API 管理员 API Key。" });
          }
          ctx.repo.setSub2ApiConnection({ ...input, adminApiKey: input.adminApiKey || current?.adminApiKey || "" });
          return ctx.repo.getSafeSub2ApiConnection();
        }),
      test: protectedProcedure.mutation(async ({ ctx }) => createConfiguredSub2ApiClient(ctx.repo).testConnection())
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
        .query(async ({ ctx, input }) => createConfiguredSub2ApiClient(ctx.repo).listAllAccounts(sub2ApiAccountFiltersSchema.parse(input ?? {})))
    }),
    assign: t.router({
      preview: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).query(async ({ ctx, input }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(input.filters)]);
        return planSub2ApiAssignments({ proxies, accounts, options: input });
      }),
      applyChanges: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).mutation(async ({ ctx, input }) => applySub2ApiAssignment(ctx.repo, input))
    }),
    sync: protectedProcedure.mutation(async ({ ctx }) => {
      const client = createConfiguredSub2ApiClient(ctx.repo);
      const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({}))]);
      const mappings = mapLocalNodesToSub2ApiProxies({ nodes: ctx.repo.listNodes(), proxies, exportHost: ctx.config.exportHost });
      ctx.repo.updateSub2ApiProxyMappings(mappings);
      const protectedRule = ctx.repo.getSub2ApiProtectedRule();
      return {
        proxies: proxies.length,
        accounts: accounts.length,
        matchedLocalNodes: mappings.length,
        protectedProxies: proxies.filter((proxy) => matchesProtectedProxyLike(proxy, protectedRule)).length
      };
    }),
    maintenance: t.router({
      preview: protectedProcedure.query(async ({ ctx }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const connection = ctx.repo.getSub2ApiConnection();
        const [proxies, accounts] = await Promise.all([
          client.listAllProxies(),
          client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
        ]);
        return planSub2ApiManagedMaintenance({
          proxies,
          accounts,
          protectedRule: ctx.repo.getSub2ApiProtectedRule(),
          managedProxyPrefix: connection?.managedProxyPrefix ?? "MH-"
        });
      }),
      drainManaged: protectedProcedure.mutation(async ({ ctx }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const connection = ctx.repo.getSub2ApiConnection();
        const [proxies, accounts] = await Promise.all([
          client.listAllProxies(),
          client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
        ]);
        const preview = planSub2ApiManagedMaintenance({
          proxies,
          accounts,
          protectedRule: ctx.repo.getSub2ApiProtectedRule(),
          managedProxyPrefix: connection?.managedProxyPrefix ?? "MH-"
        });
        if (preview.risks.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: preview.risks.join("；") });
        }
        const results = [];
        for (const batch of groupAssignmentChangesByProxy(preview.drainPlan.changes)) {
          results.push(await client.bulkUpdateProxy(batch.accountIds, batch.proxyId));
        }
        return {
          preview,
          reassigned: results.reduce((sum, item) => sum + item.success, 0),
          failedReassign: results.reduce((sum, item) => sum + item.failed, 0),
          deletedProxies: 0,
          failedDeleteProxies: []
        };
      }),
      cleanupEmpty: protectedProcedure.mutation(async ({ ctx }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const connection = ctx.repo.getSub2ApiConnection();
        const [proxies, accounts] = await Promise.all([
          client.listAllProxies(),
          client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
        ]);
        const preview = planSub2ApiManagedMaintenance({
          proxies,
          accounts,
          protectedRule: ctx.repo.getSub2ApiProtectedRule(),
          managedProxyPrefix: connection?.managedProxyPrefix ?? "MH-"
        });
        let deletedProxies = 0;
        const failedDeleteProxies = [];
        for (const proxy of preview.emptyManagedProxies) {
          try {
            await client.deleteProxy(proxy.id);
            deletedProxies += 1;
          } catch (error) {
            failedDeleteProxies.push({
              proxyId: proxy.id,
              name: proxy.name,
              message: error instanceof Error ? error.message : "未知错误"
            });
          }
        }
        return { preview, reassigned: 0, failedReassign: 0, deletedProxies, failedDeleteProxies };
      })
    }),
    automation: t.router({
      syncManagedProxies: protectedProcedure
        .input(z.object({ selectedHashes: z.array(z.string().min(8)).optional() }).default({}))
        .mutation(async ({ ctx, input }) => {
          const connection = ctx.repo.getSub2ApiConnection();
          if (!connection) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先配置 Sub2API 连接。" });
          }
          const job = createJob(
            "sub2api.automation.sync",
            "正在同步 Hive 节点到 Sub2API",
            "用 importProxyData 把本地 schedulable + active 节点推到 Sub2API，并回填 proxy_id。",
            ["整理本地节点", "推送 Sub2API", "回填 proxy_id"]
          );
          try {
            updateJobStep(job.id, 0, "running", "整理待同步节点。");
            const localNodes = ctx.repo.listNodes();
            const exportPayload = exportSub2Api(localNodes, {
              host: ctx.config.exportHost,
              namePrefix: connection.managedProxyPrefix,
              ...(input.selectedHashes ? { selectedHashes: input.selectedHashes } : {})
            });
            const proxies = exportPayload.proxies.filter((proxy) => proxy.status === "active");
            updateJobStep(job.id, 0, "success", `准备 ${proxies.length} 个 active 代理。`);
            if (proxies.length === 0) {
              finishJob(job.id, "success", "没有可同步的 active 节点。");
              return {
                operationId: job.id,
                summary: { proxy_created: 0, proxy_reused: 0, proxy_failed: 0, account_created: 0, account_failed: 0 },
                synced: 0,
                mappedNodes: 0
              };
            }

            updateJobStep(job.id, 1, "running", "调用 Sub2API importProxyData。");
            const client = createSub2ApiClient(connection);
            const summary = await client.importProxyData({ proxies });
            updateJobStep(
              job.id,
              1,
              "success",
              `新增 ${summary.proxy_created}，复用 ${summary.proxy_reused}，失败 ${summary.proxy_failed}。`
            );

            updateJobStep(job.id, 2, "running", "回填本地节点的 proxy_id 映射。");
            const liveProxies = await client.listAllProxies();
            const mappings = mapLocalNodesToSub2ApiProxies({
              nodes: localNodes,
              proxies: liveProxies,
              exportHost: ctx.config.exportHost
            });
            ctx.repo.updateSub2ApiProxyMappings(mappings);
            updateJobStep(job.id, 2, "success", `匹配 ${mappings.length} 个本地节点。`);

            finishJob(
              job.id,
              "success",
              `同步完成：新增 ${summary.proxy_created} / 复用 ${summary.proxy_reused} / 失败 ${summary.proxy_failed}。`
            );
            return {
              operationId: job.id,
              summary,
              synced: proxies.length,
              mappedNodes: mappings.length
            };
          } catch (error) {
            finishJob(job.id, "failed", error instanceof Error ? error.message : "未知错误");
            throw error;
          }
        })
    }),
    reconcile: t.router({
      preview: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).query(async ({ ctx, input }) => {
        const client = createConfiguredSub2ApiClient(ctx.repo);
        const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(input.filters)]);
        const preview = planSub2ApiAssignments({ proxies, accounts, options: input });
        return { ...preview, mode: "steady_balance" as const, affectedNodeHashes: [], risks: preview.errors };
      }),
      applyChanges: protectedProcedure.input(sub2ApiAssignmentOptionsSchema).mutation(async ({ ctx, input }) => {
        const operationId = createJob("sub2api.reconcile", "正在协调 Sub2API 账号绑定", "重新读取账号与代理后执行确定性绑定。").id;
        try {
          const result = await applySub2ApiAssignment(ctx.repo, input);
          finishJob(operationId, "success", `成功 ${result.success} 个，失败 ${result.failed} 个。`);
          return { ...result, operationId };
        } catch (error) {
          finishJob(operationId, "failed", error instanceof Error ? error.message : "未知错误");
          throw error;
        }
      })
    }),
    jobs: t.router({
      list: protectedProcedure.query(() => Array.from(operationJobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
      get: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(({ input }) => operationJobs.get(input.id))
    })
  })
});

export type AppRouter = typeof appRouter;

async function applySub2ApiAssignment(repo: HiveRepository, input: z.infer<typeof sub2ApiAssignmentOptionsSchema>) {
  const client = createConfiguredSub2ApiClient(repo);
  const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(input.filters)]);
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
}

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

function resolvePreviewSource(
  repo: HiveRepository,
  input: { id?: string | undefined; name?: string | undefined; url?: string | undefined }
): SubscriptionSource {
  if (input.id) {
    const source = repo.listSubscriptions().find((item) => item.id === input.id);
    if (!source) {
      throw new TRPCError({ code: "NOT_FOUND", message: "订阅源不存在。" });
    }
    return source;
  }
  if (!input.name || !input.url) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "请填写订阅名称和 URL。" });
  }
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: input.name,
    kind: "url",
    value: input.url,
    enabled: true,
    excludeKeywords: [],
    createdAt: now,
    updatedAt: now
  };
}

async function fetchSourceContent(repo: HiveRepository, source: SubscriptionSource): Promise<string> {
  return repo.fetchSubscriptionContent(source);
}

function selectNodes(nodes: ProxyNode[], hashes: string[]): ProxyNode[] {
  const wanted = new Set(hashes);
  const selected = nodes.filter((node) => wanted.has(node.hash));
  if (selected.length !== hashes.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "部分节点不存在。" });
  }
  return selected;
}

async function loadSub2ApiSnapshot(repo: HiveRepository): Promise<{
  client?: ReturnType<typeof createSub2ApiClient>;
  proxies: Sub2ApiProxyRecord[];
  accounts: Sub2ApiAccountRecord[];
}> {
  const connection = repo.getSub2ApiConnection();
  if (!connection) {
    return { proxies: [], accounts: [] };
  }
  const client = createSub2ApiClient(connection);
  const [proxies, accounts] = await Promise.all([client.listAllProxies(), client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))]);
  return { client, proxies, accounts };
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

function matchesProtectedProxyLike(proxy: Sub2ApiProxyRecord, rule: Sub2ApiProtectedProxyRule): boolean {
  return (
    rule.proxyIds.includes(proxy.id) ||
    includesText(proxy.name, rule.nameIncludes) ||
    includesText(proxy.host, rule.hostIncludes) ||
    (Boolean(rule.port) && proxy.port === rule.port) ||
    includesText(proxy.country ?? "", rule.countryIncludes) ||
    includesText(proxy.region ?? "", rule.regionIncludes) ||
    (rule.status.length > 0 && proxy.status === rule.status)
  );
}

function includesText(value: string, expected: string): boolean {
  return expected.length > 0 && value.toLowerCase().includes(expected.toLowerCase());
}

function createJob(type: string, title: string, detail: string, stepNames: string[] = []): OperationJob {
  const now = new Date().toISOString();
  const job: OperationJob = {
    id: randomUUID(),
    type,
    title,
    detail,
    status: "running",
    steps: stepNames.map((name) => ({ name, status: "queued", detail: "" })),
    createdAt: now,
    updatedAt: now
  };
  operationJobs.set(job.id, job);
  return job;
}

function updateJobStep(id: string, index: number, status: OperationJobStatus, detail: string): void {
  const job = operationJobs.get(id);
  if (!job?.steps[index]) {
    return;
  }
  job.steps[index] = { ...job.steps[index], status, detail };
  job.updatedAt = new Date().toISOString();
  operationJobs.set(id, job);
}

function finishJob(id: string, status: OperationJobStatus, detail: string): void {
  const job = operationJobs.get(id);
  if (!job) {
    return;
  }
  job.status = status;
  job.detail = detail;
  job.updatedAt = new Date().toISOString();
  operationJobs.set(id, job);
}
