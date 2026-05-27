import { randomUUID } from "node:crypto";
import {
  createSub2ApiClient,
  reconcile,
  type ReconcileSkippedReason,
  type Sub2ApiClient
} from "@mihomo-hive/core";
import { HiveRepository } from "@mihomo-hive/db";
import {
  reconcileObservedSummarySchema,
  reconcileTickSchema,
  sub2ApiAccountFiltersSchema,
  type ProxyNode,
  type ReconcileNodeIntent,
  type ReconcileTick,
  type RuntimeConfig
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
      const localNodes = repo.listNodes();

      const result = reconcile({
        now: startedAt,
        spec,
        localNodes,
        remoteProxies: proxies,
        remoteAccounts: accounts,
        managedProxyPrefix: connection.managedProxyPrefix
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

  return {
    triggerNow: () => tick(),
    stop: () => {
      stopped = true;
      if (nextTimer) clearTimeout(nextTimer);
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
  for (const intent of intents) {
    const node = byHash.get(intent.hash);
    if (!node) continue;
    if (node.intentRole === intent.intentRole) continue; // 无变化跳过
    updates.push({
      ...node,
      intentRole: intent.intentRole
    });
  }
  if (updates.length > 0) repo.saveNodes(updates);
}
