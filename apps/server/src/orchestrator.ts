import { randomUUID } from "node:crypto";
import {
  createSub2ApiClient,
  filterPreviewImportableNodes,
  filteredExistingNodeHashes,
  reconcile,
  type ProxyHealthSignal,
  type ReconcileSkippedReason,
  type Sub2ApiClient
} from "@mihomo-hive/core";
import { HiveRepository } from "@mihomo-hive/db";
import {
  reconcileObservedSummarySchema,
  reconcileTickSchema,
  sub2ApiAccountFiltersSchema,
  type OrchestrationSpec,
  type ProxyNode,
  type ReconcileNodeIntent,
  type ReconcileTick,
  type RuntimeConfig,
  type Sub2ApiAccountRecord
} from "@mihomo-hive/schemas";

// 关闭 idempotent 调度的安全句柄。
export interface ReconcileSchedulerHandle {
  triggerNow: () => Promise<ReconcileTick>;
  stop: () => void;
}

/**
 * 启动后台 reconcile 调度器（ADR 0003 阶段 A）：
 *  - 周期触发（spec.reconcileIntervalMs）
 *  - paused 时仍跑前 4 步，仅 step 5 跳过（dry-run）
 *  - 单实例锁，避免并发 tick 互踩
 *  - 每个 tick 持久化到 reconcile_ticks
 */
export function startReconcileScheduler(input: {
  repo: HiveRepository;
  config: RuntimeConfig;
}): ReconcileSchedulerHandle {
  const { repo } = input;
  let stopped = false;
  let inFlight = false;
  let nextTimer: NodeJS.Timeout | undefined;

  async function tick(): Promise<ReconcileTick> {
    if (inFlight) {
      // 上一次还没跑完，跳过这一拍，避免并发；返回一个 placeholder tick
      return placeholderTick({ skipped: "no_change" });
    }
    inFlight = true;
    const startedAt = new Date();
    try {
      const spec = repo.getOrchestrationSpec();
      const connection = repo.getSub2ApiConnection();

      if (!connection) {
        const tick = persistTick({
          startedAt,
          finishedAt: new Date(),
          enabled: spec.enabled,
          plannedTotal: 0,
          appliedTotal: 0,
          skippedReason: "no_change",
          observedSummary: emptyObservedSummary(),
          nodeIntents: [],
          plannedChanges: [],
          appliedChanges: []
        });
        return tick;
      }

      const client: Sub2ApiClient = createSub2ApiClient(connection);
      const [proxies, accounts] = await Promise.all([
        client.listAllProxies(),
        client.listAllAccounts(sub2ApiAccountFiltersSchema.parse({ status: "" }))
      ]);
      const healthSignals = await fetchHealthSignals(client, accounts, spec).catch((err) => {
        console.warn("upstream-errors fetch failed; reconcile will proceed without health signals:", err);
        return new Map<number, ProxyHealthSignal>();
      });
      const localNodes = repo.listNodes();

      const result = reconcile({
        now: startedAt,
        spec,
        localNodes,
        remoteProxies: proxies,
        remoteAccounts: accounts,
        managedProxyPrefix: connection.managedProxyPrefix,
        healthSignals
      });

      let executedTotal = 0;
      let errorMessage: string | undefined;
      let executedChanges = result.appliedChanges;

      if (result.appliedChanges.length > 0) {
        const groups = new Map<number, number[]>();
        for (const change of result.appliedChanges) {
          const list = groups.get(change.toProxyId) ?? [];
          list.push(change.accountId);
          groups.set(change.toProxyId, list);
        }
        try {
          for (const [toProxyId, accountIds] of groups) {
            await client.bulkUpdateProxy(accountIds, toProxyId);
            executedTotal += accountIds.length;
          }
        } catch (err) {
          errorMessage = err instanceof Error ? err.message : "未知错误";
          // 失败时只记录已成功的那部分（取消未执行的）
          executedChanges = result.appliedChanges.slice(0, executedTotal);
        }
      }

      // 把 nodeIntents 写回本地节点（更新 intent_role / backoff / health_score）
      writeBackNodeIntents(repo, result.nodeIntents, localNodes);
      // 退役计时：长期 evicted 节点 → lifecycleStatus = retired
      retireOldEvicted(repo, spec, startedAt);
      // 每 24h 清理一次过老 tick，避免表无限膨胀
      maybePruneTicks(repo, startedAt);

      const tickResult: ReconcileSkippedReason = errorMessage
        ? "applied" // 即便错也算 applied（部分），让 errorMessage 解释
        : result.skippedReason;

      return persistTick({
        startedAt,
        finishedAt: new Date(),
        enabled: spec.enabled,
        plannedTotal: result.plannedChanges.length,
        appliedTotal: executedTotal,
        skippedReason: errorMessage ? "error" : tickResult,
        observedSummary: result.observedSummary,
        nodeIntents: result.nodeIntents,
        plannedChanges: result.plannedChanges,
        appliedChanges: executedChanges,
        ...(errorMessage ? { errorMessage } : {})
      });
    } catch (err) {
      // Sub2API listAll / 任意上游异常 → 写错误 tick，不挂调度器
      const message = err instanceof Error ? err.message : "未知错误";
      return persistTick({
        startedAt,
        finishedAt: new Date(),
        enabled: repo.getOrchestrationSpec().enabled,
        plannedTotal: 0,
        appliedTotal: 0,
        skippedReason: "error",
        observedSummary: emptyObservedSummary(),
        nodeIntents: [],
        plannedChanges: [],
        appliedChanges: [],
        errorMessage: message
      });
    } finally {
      inFlight = false;
    }
  }

  function persistTick(input: {
    startedAt: Date;
    finishedAt: Date;
    enabled: boolean;
    plannedTotal: number;
    appliedTotal: number;
    skippedReason: string;
    observedSummary: ReconcileTick["observedSummary"];
    nodeIntents: ReconcileTick["nodeIntents"];
    plannedChanges: ReconcileTick["plannedChanges"];
    appliedChanges: ReconcileTick["appliedChanges"];
    errorMessage?: string | undefined;
  }): ReconcileTick {
    const tick: ReconcileTick = reconcileTickSchema.parse({
      id: randomUUID(),
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
      enabled: input.enabled,
      observedSummary: input.observedSummary,
      plannedTotal: input.plannedTotal,
      appliedTotal: input.appliedTotal,
      skippedReason: input.skippedReason,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      nodeIntents: input.nodeIntents,
      plannedChanges: input.plannedChanges,
      appliedChanges: input.appliedChanges
    });
    try {
      repo.appendReconcileTick(tick);
    } catch (err) {
      console.error("reconcile_ticks insert failed:", err);
    }
    return tick;
  }

  function placeholderTick(input: { skipped: ReconcileSkippedReason }): ReconcileTick {
    const now = new Date();
    return reconcileTickSchema.parse({
      id: randomUUID(),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      enabled: repo.getOrchestrationSpec().enabled,
      observedSummary: emptyObservedSummary(),
      plannedTotal: 0,
      appliedTotal: 0,
      skippedReason: input.skipped,
      nodeIntents: [],
      plannedChanges: [],
      appliedChanges: []
    });
  }

  function scheduleNext(): void {
    if (stopped) return;
    const spec = repo.getOrchestrationSpec();
    const interval = Math.max(5_000, spec.reconcileIntervalMs);
    nextTimer = setTimeout(() => {
      void tick().finally(scheduleNext);
    }, interval);
    nextTimer.unref?.();
  }

  // 启动时立即跑一次（让首次刷新更快）
  void tick().finally(() => {
    if (!stopped) scheduleNext();
  });

  // 订阅自动刷新子循环：按 spec.supply.fetchIntervalMs（默认 6h）独立运行。
  // 不在启动时立即跑（避免每次重启都拉一遍订阅）；首个延迟 = fetchIntervalMs。
  let subscriptionTimer: NodeJS.Timeout | undefined;
  function scheduleSubscriptionRefresh(): void {
    if (stopped) return;
    const spec = repo.getOrchestrationSpec();
    if (!spec.supply.autoFetchSubscriptions) {
      // 关闭态下也排一次，下次重新读 spec 时如果开了又能接上。
      subscriptionTimer = setTimeout(scheduleSubscriptionRefresh, 60_000);
      subscriptionTimer.unref?.();
      return;
    }
    const interval = Math.max(60_000, spec.supply.fetchIntervalMs);
    subscriptionTimer = setTimeout(async () => {
      try {
        await refreshSubscriptions(repo);
      } catch (err) {
        console.error("subscription refresh failed:", err);
      }
      scheduleSubscriptionRefresh();
    }, interval);
    subscriptionTimer.unref?.();
  }
  scheduleSubscriptionRefresh();

  return {
    triggerNow: () => tick(),
    stop: () => {
      stopped = true;
      if (nextTimer) clearTimeout(nextTimer);
      if (subscriptionTimer) clearTimeout(subscriptionTimer);
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────

function emptyObservedSummary(): ReconcileTick["observedSummary"] {
  return reconcileObservedSummarySchema.parse({
    proxiesTotal: 0,
    proxiesServing: 0,
    proxiesQuarantined: 0,
    proxiesEvicted: 0,
    proxiesProtected: 0,
    proxiesManaged: 0,
    accountsTotal: 0,
    accountsAssignable: 0,
    accountsProtected: 0,
    capacityTotal: 0,
    utilizationPercent: 0
  });
}

function writeBackNodeIntents(
  repo: HiveRepository,
  intents: ReconcileNodeIntent[],
  localNodes: ProxyNode[]
): void {
  if (intents.length === 0) return;
  const byHash = new Map(localNodes.map((node) => [node.hash, node]));
  const updates: ProxyNode[] = [];
  const nowIso = new Date().toISOString();
  for (const intent of intents) {
    const node = byHash.get(intent.hash);
    if (!node) continue;
    const changed =
      node.intentRole !== intent.intentRole ||
      (node.backoffUntil ?? null) !== (intent.backoffUntil ?? null) ||
      (node.backoffAttempts ?? 0) !== intent.backoffAttempts ||
      (node.healthScore ?? null) !== intent.healthScore;
    if (!changed) continue;
    updates.push({
      ...node,
      intentRole: intent.intentRole,
      backoffUntil: intent.backoffUntil ?? null,
      backoffAttempts: intent.backoffAttempts,
      healthScore: intent.healthScore,
      lastHealthCheck: nowIso
    });
  }
  if (updates.length > 0) repo.saveNodes(updates);
}

/**
 * 把 Sub2API 上游错误日志聚合成"按 proxy 的窗口错误数"信号源（ADR 0003 阶段 B）。
 *
 * Sub2API 没有"账号总请求数"接口，所以我们用**绝对错误数**当判定信号。
 * 错误窗口长度由 spec.health.windowMs 决定，转成 listAllUpstreamErrors 的 timeRange 字符串。
 */
async function fetchHealthSignals(
  client: Sub2ApiClient,
  accounts: Sub2ApiAccountRecord[],
  spec: OrchestrationSpec
): Promise<Map<number, ProxyHealthSignal>> {
  const timeRange = msToTimeRange(spec.health.windowMs);
  const errors = await client.listAllUpstreamErrors({ timeRange, view: "errors", phase: "upstream" });

  // 当前账号 → 当前 proxy_id 映射（用现在的视角归因，不查历史绑定）
  const accountToProxy = new Map<number, number>();
  for (const account of accounts) {
    if (account.proxy_id) accountToProxy.set(account.id, account.proxy_id);
  }

  const signals = new Map<number, ProxyHealthSignal>();
  // 先把所有当前有账号绑定的 proxy 都初始化为 0 错误（让"无错"也是有效信号）
  for (const proxyId of new Set(accountToProxy.values())) {
    signals.set(proxyId, { errorsInWindow: 0 });
  }
  for (const error of errors) {
    if (!error.account_id) continue;
    const proxyId = accountToProxy.get(error.account_id);
    if (!proxyId) continue;
    const current = signals.get(proxyId) ?? { errorsInWindow: 0 };
    signals.set(proxyId, { errorsInWindow: current.errorsInWindow + 1 });
  }
  return signals;
}

function msToTimeRange(ms: number): string {
  if (ms <= 0) return "5m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(ms / 3_600_000);
  return `${Math.max(1, hours)}h`;
}

// 每个 scheduler 实例独立计数；进程重启即重置（也会立刻清理一次，副作用可接受）。
let lastPruneAtMs = 0;
function maybePruneTicks(repo: HiveRepository, now: Date): void {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (now.getTime() - lastPruneAtMs < ONE_DAY) return;
  const deleted = repo.pruneReconcileTicks(7);
  lastPruneAtMs = now.getTime();
  if (deleted > 0) {
    console.log(`pruned ${deleted} reconcile tick(s) older than 7 days`);
  }
}

/**
 * 退役计时（ADR 0003 supply.evictAfterDays）。
 *
 * intentRole=evicted 且 last_health_check（或 updatedAt 兜底）已超过 evictAfterDays 天的节点
 * → lifecycleStatus 设为 retired。Reconcile 不再考虑它们；Mihomo 渲染也排除。
 */
function retireOldEvicted(repo: HiveRepository, spec: OrchestrationSpec, now: Date): void {
  const cutoff = new Date(now.getTime() - spec.supply.evictAfterDays * 24 * 60 * 60 * 1000);
  const updates: ProxyNode[] = [];
  for (const node of repo.listNodes()) {
    if (node.intentRole !== "evicted") continue;
    if (node.lifecycleStatus === "retired" || node.lifecycleStatus === "deleted") continue;
    const reference = node.lastHealthCheck ? new Date(node.lastHealthCheck) : new Date(node.updatedAt);
    if (reference > cutoff) continue;
    updates.push({ ...node, lifecycleStatus: "retired", schedulable: false });
  }
  if (updates.length > 0) {
    repo.saveNodes(updates);
    console.log(`retired ${updates.length} evicted node(s) past ${spec.supply.evictAfterDays} days`);
  }
}

/**
 * 订阅自动刷新子循环（ADR 0003 supply policy）。
 *
 * 等价于用户手动跑 subscriptions.applyImport，但批量+无人值守：
 *   1) 遍历所有 enabled 订阅源
 *   2) fetch + parse + build preview
 *   3) upsert importable 节点（status=untested、intent=standby，待测试）
 *   4) 删除被新规则过滤命中的现有节点（deletedByFilter 路径）
 *
 * 不抛错；单个订阅失败只跳过它，其他继续。
 */
async function refreshSubscriptions(repo: HiveRepository): Promise<void> {
  const sources = repo.listSubscriptions().filter((source) => source.enabled);
  for (const source of sources) {
    try {
      const content = await repo.fetchSubscriptionContent(source);
      repo.updateSubscriptionContent(source.id, content);
      const existingNodes = repo.listNodes();
      const importable = filterPreviewImportableNodes({
        source,
        content,
        existingNodes,
        excludeKeywords: source.excludeKeywords
      }).map((node) => ({
        ...node,
        lifecycleStatus: "candidate" as const,
        schedulable: false
      }));
      const deleteHashes = filteredExistingNodeHashes({
        source,
        content,
        existingNodes,
        excludeKeywords: source.excludeKeywords
      });
      if (deleteHashes.length > 0) repo.deleteNodes(deleteHashes);
      if (importable.length > 0) repo.upsertNodes(importable);
      console.log(
        `subscription auto-refresh "${source.name}": imported ${importable.length}, deletedByFilter ${deleteHashes.length}`
      );
    } catch (err) {
      console.warn(`subscription "${source.name}" refresh failed:`, err);
    }
  }
}
