import { createHash } from "node:crypto";
import {
  reconcileObservedSummarySchema,
  type OrchestrationSpec,
  type ProxyNode,
  type ReconcileNodeIntent,
  type ReconcileObservedSummary,
  type ReconcilePlannedChange,
  type Sub2ApiAccountRecord,
  type Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";
import { matchesProtectedProxy } from "./sub2api-assignment.js";
import { isManagedProxy } from "./sub2api-maintenance.js";

export interface ReconcileInput {
  now: Date;
  spec: OrchestrationSpec;
  localNodes: ProxyNode[];
  remoteProxies: Sub2ApiProxyRecord[];
  remoteAccounts: Sub2ApiAccountRecord[];
  managedProxyPrefix: string;
}

export type ReconcileSkippedReason = "paused" | "batch_capped" | "no_change" | "applied";

export interface ReconcileResult {
  observedSummary: ReconcileObservedSummary;
  nodeIntents: ReconcileNodeIntent[];
  plannedChanges: ReconcilePlannedChange[];
  appliedChanges: ReconcilePlannedChange[];
  skippedReason: ReconcileSkippedReason;
}

interface ObservedWorld {
  enabled: boolean;
  spec: OrchestrationSpec;
  nowDate: Date;
  proxies: Sub2ApiProxyRecord[];
  proxiesById: Map<number, Sub2ApiProxyRecord>;
  localByProxyId: Map<number, ProxyNode>;
  managedProxyIds: Set<number>;
  protectedProxyIds: Set<number>;
  accountsByProxyId: Map<number, Sub2ApiAccountRecord[]>;
  uniqueAccounts: Sub2ApiAccountRecord[];
  servingProxyIds: Set<number>;
  quarantinedProxyIds: Set<number>;
  evictedProxyIds: Set<number>;
  intakeProxyId: number | null;
}

interface NodeRoleDecision {
  proxyId: number;
  proxy: Sub2ApiProxyRecord;
  localNode: ProxyNode | undefined;
  role: "serving" | "standby" | "quarantined" | "evicted";
  currentLoad: number;
  targetLoad: number;
  nextAction: string;
}

/**
 * 纯函数入口。五步：观测 → 判定 → 规划 → 限速 → 汇总。
 * 不做任何 I/O，方便单元测试。Scheduler / router 层去真正写远端。
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const world = observeWorld(input);
  const decisions = decideNodeRoles(world);
  const planned = planChanges(world, decisions);
  const { applied, skippedReason } = gateChanges(world, planned);

  return {
    observedSummary: summarizeObserved(world, decisions),
    nodeIntents: buildNodeIntents(world, decisions),
    plannedChanges: planned,
    appliedChanges: applied,
    skippedReason
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Step 1 — observe

function observeWorld(input: ReconcileInput): ObservedWorld {
  const proxies = input.remoteProxies.slice().sort((a, b) => a.id - b.id);
  const proxiesById = new Map(proxies.map((proxy) => [proxy.id, proxy]));

  const localByProxyId = new Map<number, ProxyNode>();
  for (const node of input.localNodes) {
    if (node.sub2apiProxyId) localByProxyId.set(node.sub2apiProxyId, node);
  }

  const managedProxyIds = new Set(
    proxies.filter((p) => isManagedProxy(p, input.managedProxyPrefix)).map((p) => p.id)
  );
  const protectedProxyIds = new Set(
    proxies.filter((p) => matchesProtectedProxy(p, input.spec.protectedRule)).map((p) => p.id)
  );

  const accountsByProxyId = new Map<number, Sub2ApiAccountRecord[]>();
  for (const account of input.remoteAccounts) {
    if (!account.proxy_id) continue;
    const bucket = accountsByProxyId.get(account.proxy_id) ?? [];
    bucket.push(account);
    accountsByProxyId.set(account.proxy_id, bucket);
  }

  const intakeProxyId =
    input.spec.intake.proxyId && proxiesById.has(input.spec.intake.proxyId) ? input.spec.intake.proxyId : null;

  const servingProxyIds = new Set<number>();
  const quarantinedProxyIds = new Set<number>();
  const evictedProxyIds = new Set<number>();

  for (const proxy of proxies) {
    if (protectedProxyIds.has(proxy.id)) continue;
    if (proxy.id === intakeProxyId) continue;
    if (!managedProxyIds.has(proxy.id)) continue;

    const local = localByProxyId.get(proxy.id);
    if (!local) continue; // 远端有但本地无记录 → 视为 standby，不参与调度

    const backoffUntil = local.backoffUntil ? new Date(local.backoffUntil) : null;
    const stillInBackoff = backoffUntil ? backoffUntil > input.now : false;

    if (local.intentRole === "evicted") {
      evictedProxyIds.add(proxy.id);
    } else if (local.intentRole === "quarantined" || stillInBackoff) {
      quarantinedProxyIds.add(proxy.id);
    } else if (local.intentRole === "serving" || local.lifecycleStatus === "schedulable") {
      servingProxyIds.add(proxy.id);
    }
  }

  return {
    enabled: input.spec.enabled,
    spec: input.spec,
    nowDate: input.now,
    proxies,
    proxiesById,
    localByProxyId,
    managedProxyIds,
    protectedProxyIds,
    accountsByProxyId,
    uniqueAccounts: dedupeAccounts(input.remoteAccounts),
    servingProxyIds,
    quarantinedProxyIds,
    evictedProxyIds,
    intakeProxyId
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Step 2 — decide

function decideNodeRoles(world: ObservedWorld): NodeRoleDecision[] {
  const servingCount = world.servingProxyIds.size;

  const assignableAccountCount = world.uniqueAccounts.filter((account) => {
    if (account.proxy_id && world.protectedProxyIds.has(account.proxy_id)) return false;
    return true;
  }).length;

  const target =
    world.spec.capacity.targetPerNode === "auto"
      ? servingCount > 0
        ? Math.ceil(assignableAccountCount / servingCount)
        : 0
      : world.spec.capacity.targetPerNode;

  const decisions: NodeRoleDecision[] = [];
  for (const proxy of world.proxies) {
    const local = world.localByProxyId.get(proxy.id);
    const currentLoad = (world.accountsByProxyId.get(proxy.id) ?? []).length;

    let role: NodeRoleDecision["role"] = "standby";
    let nextAction = "等待启用";

    if (world.protectedProxyIds.has(proxy.id)) {
      nextAction = "保护代理，不参与自动调度";
    } else if (proxy.id === world.intakeProxyId) {
      nextAction = currentLoad > 0 ? `入站代理，下次将引流 ${currentLoad} 个账号` : "入站代理，当前无待引流账号";
    } else if (world.evictedProxyIds.has(proxy.id)) {
      role = "evicted";
      nextAction = "已驱逐，等待人工恢复或退役";
    } else if (world.quarantinedProxyIds.has(proxy.id)) {
      role = "quarantined";
      const until = local?.backoffUntil ? ` (退避至 ${local.backoffUntil})` : "";
      nextAction = `退避中${until}，账号留在原地等待恢复`;
    } else if (world.servingProxyIds.has(proxy.id)) {
      role = "serving";
      const upper = Math.ceil(target * world.spec.capacity.overloadRatio);
      const lower = Math.floor(target * world.spec.capacity.underloadRatio);
      if (currentLoad > upper) {
        nextAction = `过载（${currentLoad} > ${upper}），下次将外迁 ${currentLoad - target} 个账号`;
      } else if (currentLoad < lower && target > 0) {
        nextAction = `欠载（${currentLoad} < ${lower}），等待新账号填入`;
      } else {
        nextAction = `承载 ${currentLoad}/${target}，稳定`;
      }
    }

    decisions.push({
      proxyId: proxy.id,
      proxy,
      localNode: local,
      role,
      currentLoad,
      targetLoad: target,
      nextAction
    });
  }

  return decisions;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 3 — plan

function planChanges(world: ObservedWorld, decisions: NodeRoleDecision[]): ReconcilePlannedChange[] {
  const planned: ReconcilePlannedChange[] = [];
  const servingProxies = decisions
    .filter((d) => d.role === "serving" && !world.protectedProxyIds.has(d.proxyId))
    .map((d) => d.proxy);

  if (servingProxies.length === 0) {
    return planned;
  }

  // priority 1 — drain intake
  if (world.intakeProxyId !== null) {
    const intakeAccounts = world.accountsByProxyId.get(world.intakeProxyId) ?? [];
    for (const account of intakeAccounts) {
      const target = pickTargetProxy(account, servingProxies, world.spec.stickiness.strategy);
      if (!target) continue;
      planned.push({
        kind: "drain_intake",
        accountId: account.id,
        accountName: account.name,
        fromProxyId: world.intakeProxyId,
        toProxyId: target.id,
        reason: "新账号从入站代理引流到 Hive 节点"
      });
    }
  }

  // priority 2 — bind_missing / rebind_dead
  for (const account of world.uniqueAccounts) {
    if (account.proxy_id && world.protectedProxyIds.has(account.proxy_id)) continue;
    // intake 上的账号已经在第 1 步处理过；只有 intakeProxyId 非 null 且账号确实绑在 intake 上时才 skip
    if (world.intakeProxyId !== null && account.proxy_id === world.intakeProxyId) continue;

    const proxyId = account.proxy_id ?? null;
    // 决策 #5：quarantined 期间账号留在原地（"故障路径不触发漂移"），只有 evicted/不存在 才算 dead
    const proxyAlive =
      proxyId !== null &&
      !world.evictedProxyIds.has(proxyId) &&
      (world.servingProxyIds.has(proxyId) || world.quarantinedProxyIds.has(proxyId));

    if (!proxyAlive) {
      const target = pickTargetProxy(account, servingProxies, world.spec.stickiness.strategy);
      if (!target) continue;
      if (target.id === proxyId) continue;
      planned.push({
        kind: proxyId === null ? "bind_missing" : "rebind_dead",
        accountId: account.id,
        accountName: account.name,
        fromProxyId: proxyId,
        toProxyId: target.id,
        reason: proxyId === null ? "账号未绑定，自动分配到健康节点" : "原代理已退避/驱逐/不再服务"
      });
    }
  }

  // priority 3 — rebalance overload
  const overloadDecisions = decisions.filter(
    (d) => d.role === "serving" && d.currentLoad > Math.ceil(d.targetLoad * world.spec.capacity.overloadRatio)
  );
  for (const overloadNode of overloadDecisions) {
    const exceed = overloadNode.currentLoad - overloadNode.targetLoad;
    if (exceed <= 0) continue;
    const candidates = (world.accountsByProxyId.get(overloadNode.proxyId) ?? [])
      .filter((acc) => !(acc.proxy_id && world.protectedProxyIds.has(acc.proxy_id)))
      .slice()
      .sort((a, b) => b.id - a.id); // LIFO 倾向把最近迁入的搬走

    let migrated = 0;
    for (const account of candidates) {
      if (migrated >= exceed) break;
      const otherServing = servingProxies.filter((p) => p.id !== overloadNode.proxyId);
      const target = pickTargetProxy(account, otherServing, world.spec.stickiness.strategy);
      if (!target) continue;
      planned.push({
        kind: "rebalance_overload",
        accountId: account.id,
        accountName: account.name,
        fromProxyId: overloadNode.proxyId,
        toProxyId: target.id,
        reason: `过载外迁：节点承载 ${overloadNode.currentLoad} > 上限 ${Math.ceil(
          overloadNode.targetLoad * world.spec.capacity.overloadRatio
        )}`
      });
      migrated += 1;
    }
  }

  // priority 4 / 5 — drift_correction & rebalance_fill：阶段 A 暂不实现
  return planned;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 4 — gate (灰度限速 + 暂停)

function gateChanges(
  world: ObservedWorld,
  planned: ReconcilePlannedChange[]
): { applied: ReconcilePlannedChange[]; skippedReason: ReconcileSkippedReason } {
  if (!world.enabled) {
    return { applied: [], skippedReason: "paused" };
  }
  if (planned.length === 0) {
    return { applied: [], skippedReason: "no_change" };
  }

  const priority: Record<ReconcilePlannedChange["kind"], number> = {
    drain_intake: 0,
    rebind_dead: 1,
    bind_missing: 2,
    rebalance_overload: 3,
    rebalance_fill: 4,
    drift_correction: 5
  };
  const sorted = planned.slice().sort((a, b) => priority[a.kind] - priority[b.kind]);

  const total = world.uniqueAccounts.length;
  const percentCap = Math.floor((total * world.spec.graceBatchPercent) / 100);
  const absCap = world.spec.graceBatchAbs;
  const generalCap = Math.max(0, Math.min(percentCap, absCap));
  const migrationCap = world.spec.stickiness.perTickMigrationCap;
  const bypass = world.spec.intake.bypassGraceBatch;

  const applied: ReconcilePlannedChange[] = [];
  let generalCount = 0;
  let migrationCount = 0;

  for (const change of sorted) {
    const isIntake = change.kind === "drain_intake";
    const isMigration = change.kind === "rebalance_overload" || change.kind === "drift_correction";

    if (isMigration && migrationCount >= migrationCap) continue;

    if (isIntake && bypass) {
      applied.push(change);
      continue; // 不消耗 generalCap
    }

    if (generalCount >= generalCap) continue;
    applied.push(change);
    generalCount += 1;
    if (isMigration) migrationCount += 1;
  }

  if (applied.length === 0) return { applied, skippedReason: "batch_capped" };
  return { applied, skippedReason: "applied" };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers

function summarizeObserved(world: ObservedWorld, decisions: NodeRoleDecision[]): ReconcileObservedSummary {
  const proxiesTotal = world.proxiesById.size;
  const proxiesServing = decisions.filter((d) => d.role === "serving").length;
  const proxiesQuarantined = decisions.filter((d) => d.role === "quarantined").length;
  const proxiesEvicted = decisions.filter((d) => d.role === "evicted").length;
  const accountsTotal = world.uniqueAccounts.length;
  const accountsProtected = world.uniqueAccounts.filter(
    (a) => a.proxy_id && world.protectedProxyIds.has(a.proxy_id)
  ).length;
  const accountsAssignable = accountsTotal - accountsProtected;
  const capacityTotal = decisions
    .filter((d) => d.role === "serving")
    .reduce((sum, d) => sum + Math.ceil(d.targetLoad * world.spec.capacity.overloadRatio), 0);
  const utilizationPercent =
    capacityTotal === 0 ? 0 : Math.min(100, Math.round((accountsAssignable / capacityTotal) * 100));

  return reconcileObservedSummarySchema.parse({
    proxiesTotal,
    proxiesServing,
    proxiesQuarantined,
    proxiesEvicted,
    proxiesProtected: world.protectedProxyIds.size,
    proxiesManaged: world.managedProxyIds.size,
    accountsTotal,
    accountsAssignable,
    accountsProtected,
    capacityTotal,
    utilizationPercent
  });
}

function buildNodeIntents(world: ObservedWorld, decisions: NodeRoleDecision[]): ReconcileNodeIntent[] {
  return decisions
    .filter((d) => world.localByProxyId.has(d.proxyId))
    .map((d) => {
      const local = world.localByProxyId.get(d.proxyId)!;
      return {
        hash: local.hash,
        proxyId: d.proxyId,
        intentRole: d.role,
        healthScore: local.healthScore ?? null,
        backoffUntil: local.backoffUntil ?? null,
        backoffAttempts: local.backoffAttempts ?? 0,
        currentLoad: d.currentLoad,
        targetLoad: d.targetLoad,
        nextAction: d.nextAction
      };
    });
}

function dedupeAccounts(accounts: Sub2ApiAccountRecord[]): Sub2ApiAccountRecord[] {
  const seen = new Set<number>();
  const out: Sub2ApiAccountRecord[] = [];
  for (const account of accounts) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    out.push(account);
  }
  return out;
}

function pickTargetProxy(
  account: Sub2ApiAccountRecord,
  pool: Sub2ApiProxyRecord[],
  strategy: "stable-hash" | "rendezvous-hash"
): Sub2ApiProxyRecord | undefined {
  if (pool.length === 0) return undefined;
  if (strategy === "rendezvous-hash") return pickRendezvousProxy(account, pool);
  const key = `${account.id}:${account.name}`;
  const digest = createHash("sha256").update(key).digest();
  const index = digest.readUInt32BE(0) % pool.length;
  return pool[index];
}

function pickRendezvousProxy(account: Sub2ApiAccountRecord, pool: Sub2ApiProxyRecord[]): Sub2ApiProxyRecord {
  let best: { proxy: Sub2ApiProxyRecord; weight: number } | undefined;
  for (const proxy of pool) {
    const key = `${proxy.id}:${account.id}`;
    const digest = createHash("sha256").update(key).digest();
    const weight = digest.readUInt32BE(0);
    if (!best || weight > best.weight) best = { proxy, weight };
  }
  return best!.proxy;
}

/**
 * Validate the intake config against the rest of Spec. Returns an error message
 * if the config is illegal (used in spec.save preflight).
 */
export function validateIntakeAgainstSpec(
  spec: OrchestrationSpec,
  proxies: Sub2ApiProxyRecord[],
  managedProxyPrefix: string
): string | null {
  const id = spec.intake.proxyId;
  if (id === null) return null;
  const proxy = proxies.find((p) => p.id === id);
  if (!proxy) return "入站代理在 Sub2API 中已不存在";
  if (isManagedProxy(proxy, managedProxyPrefix)) {
    return "入站代理不能是 Hive 托管代理（带托管前缀）";
  }
  if (matchesProtectedProxy(proxy, spec.protectedRule)) {
    return "入站代理不能命中保护规则";
  }
  return null;
}
