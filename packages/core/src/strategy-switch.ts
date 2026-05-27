import { createHash } from "node:crypto";
import type {
  OrchestrationSpec,
  ReconcilePlannedChange,
  Sub2ApiAccountRecord,
  Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";
import { matchesProtectedProxy } from "./sub2api-assignment.js";
import { isManagedProxy } from "./sub2api-maintenance.js";

export interface StrategyMigrationInput {
  spec: OrchestrationSpec;
  targetStrategy: "stable-hash" | "rendezvous-hash";
  proxies: Sub2ApiProxyRecord[];
  accounts: Sub2ApiAccountRecord[];
  managedProxyPrefix: string;
  servingProxyIds: Set<number>;
}

export interface StrategyMigrationPlan {
  fromStrategy: "stable-hash" | "rendezvous-hash";
  toStrategy: "stable-hash" | "rendezvous-hash";
  affectedAccounts: number;
  totalConsidered: number;
  changes: ReconcilePlannedChange[];
}

/**
 * 计算"如果把 stickiness.strategy 切到 targetStrategy 会发生哪些迁移"。
 * 全量重新分配；不受 graceBatch 限制。仅在切换日运行。
 *
 * 排除：保护代理上的账号、入站代理上的账号、不在 servingProxyIds 里的账号。
 *
 * 目标 proxy 是 servingProxyIds 经排序后的子集（去掉保护 / intake）。
 */
export function planStrategySwitch(input: StrategyMigrationInput): StrategyMigrationPlan {
  const protectedIds = new Set(
    input.proxies.filter((p) => matchesProtectedProxy(p, input.spec.protectedRule)).map((p) => p.id)
  );
  const intakeId = input.spec.intake.proxyId;

  const targetPool = input.proxies
    .filter((p) => input.servingProxyIds.has(p.id))
    .filter((p) => !protectedIds.has(p.id))
    .filter((p) => p.id !== intakeId)
    .filter((p) => isManagedProxy(p, input.managedProxyPrefix))
    .sort((a, b) => a.id - b.id);

  const changes: ReconcilePlannedChange[] = [];
  let considered = 0;

  for (const account of input.accounts) {
    if (!account.proxy_id) continue;
    if (protectedIds.has(account.proxy_id)) continue; // 保护账号不动
    if (account.proxy_id === intakeId) continue; // intake 走 drain_intake 路径
    if (!targetPool.find((p) => p.id === account.proxy_id)) continue; // 当前不在 serving pool 也跳过

    considered += 1;
    const target = pickByStrategy(account, targetPool, input.targetStrategy);
    if (!target) continue;
    if (target.id === account.proxy_id) continue;
    changes.push({
      kind: "drift_correction",
      accountId: account.id,
      accountName: account.name,
      fromProxyId: account.proxy_id,
      toProxyId: target.id,
      reason: `策略切换 ${input.spec.stickiness.strategy} → ${input.targetStrategy}：HRW 目标变化`
    });
  }

  return {
    fromStrategy: input.spec.stickiness.strategy,
    toStrategy: input.targetStrategy,
    affectedAccounts: changes.length,
    totalConsidered: considered,
    changes
  };
}

function pickByStrategy(
  account: Sub2ApiAccountRecord,
  pool: Sub2ApiProxyRecord[],
  strategy: "stable-hash" | "rendezvous-hash"
): Sub2ApiProxyRecord | undefined {
  if (pool.length === 0) return undefined;
  if (strategy === "rendezvous-hash") {
    let best: { proxy: Sub2ApiProxyRecord; weight: number } | undefined;
    for (const proxy of pool) {
      const weight = createHash("sha256").update(`${proxy.id}:${account.id}`).digest().readUInt32BE(0);
      if (!best || weight > best.weight) best = { proxy, weight };
    }
    return best!.proxy;
  }
  const idx = createHash("sha256").update(`${account.id}:${account.name}`).digest().readUInt32BE(0) % pool.length;
  return pool[idx];
}
