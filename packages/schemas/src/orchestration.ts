import { z } from "zod";
import { sub2ApiProtectedProxyRuleSchema } from "./sub2api.js";

// 节点意图角色 —— 系统判定节点当前应该做什么
// serving      = 健康，参与调度，承载账号
// standby      = 入池后等待启用 / 暂停状态（disabled 同义）
// quarantined  = 退避中：错误率破阈值，暂停接收新账号，账号留在原地
// evicted      = 永久驱逐（多次 backoff 仍失败），等待人工 reset 或退役
export const nodeIntentRoleSchema = z.enum(["serving", "standby", "quarantined", "evicted"]);
export type NodeIntentRole = z.infer<typeof nodeIntentRoleSchema>;

// 节点供给策略 —— "我有哪些节点能用"
export const supplyPolicySchema = z.object({
  autoFetchSubscriptions: z.boolean().default(true),
  fetchIntervalMs: z.number().int().min(60_000).default(6 * 60 * 60 * 1000), // 6h
  inPoolGate: z.object({
    requirePassedTest: z.boolean().default(true),
    maxLatencyMs: z.number().int().positive().optional(),
    minQualityScore: z.number().int().min(0).max(100).optional()
  }).default({}),
  evictAfterDays: z.number().int().min(1).default(7)
});

export type SupplyPolicy = z.infer<typeof supplyPolicySchema>;

// 容量策略 —— "节点能否最大效率工作"
export const capacityPolicySchema = z.object({
  // "auto" = totalAssignableAccounts / healthyServingNodes
  targetPerNode: z.union([z.literal("auto"), z.number().int().positive()]).default("auto"),
  overloadRatio: z.number().min(1).default(1.2),     // 超过目标 1.2x → 视为过载
  underloadRatio: z.number().min(0).max(1).default(0.6),  // 低于目标 0.6x → 视为欠载
  hardMaxPerNode: z.number().int().positive().default(200)
});

export type CapacityPolicy = z.infer<typeof capacityPolicySchema>;

// 绑定稳定性策略 —— "账号能否少漂移"
export const stickinessPolicySchema = z.object({
  // strategy: 阶段 A 先用 "stable-hash"（当前 sha256(account.id) % N）；阶段 C 切到 "rendezvous-hash"
  strategy: z.enum(["stable-hash", "rendezvous-hash"]).default("stable-hash"),
  rebalanceTriggerPercent: z.number().min(0).max(100).default(15),
  // 单次 reconcile 最多触发 N 个账号的"再平衡"迁移
  perTickMigrationCap: z.number().int().nonnegative().default(10)
});

export type StickinessPolicy = z.infer<typeof stickinessPolicySchema>;

// 故障自愈策略 —— "故障能否自动调整"
export const healthPolicySchema = z.object({
  signalSource: z.literal("upstream-errors").default("upstream-errors"),
  windowMs: z.number().int().min(60_000).default(5 * 60 * 1000),       // 5min 滑动窗口
  errorRateThreshold: z.number().min(0).max(1).default(0.05),           // 错误率 ≥ 5% 触发退避
  minRequestsForJudgement: z.number().int().min(1).default(10),         // 窗口内 < 10 次请求不判定
  backoffSequenceMs: z.array(z.number().int().min(1000))
    .min(1)
    .default([60_000, 300_000, 900_000, 3_600_000, 21_600_000]),        // 1m / 5m / 15m / 1h / 6h
  evictAfterBackoffs: z.number().int().min(1).default(5)
});

export type HealthPolicy = z.infer<typeof healthPolicySchema>;

// 入站代理（Intake Proxy）—— 账号的"漏斗入口"
//
// 用户在 Sub2API 后台手动配的一个代理（通常是一个兜底代理，比如全局直连或者用户家里的某条线路），
// 创建账号时默认把账号绑定到这里。Reconcile 检测到这个代理上有账号 → 立刻按 HRW 引流到合适的
// Hive 健康节点。账号永远不在 intake 代理上"停留"，它仅是中转层。
//
// 设计约束：
//  - intake 代理本身不能是 Hive 托管代理（不能有 managedProxyPrefix）
//  - intake 代理不能命中保护规则（否则永远迁不走）
//  - 上面的账号视为"紧急高优先级"，绕过 graceBatch 限制（但仍受 perTickMigrationCap 上限）
export const intakePolicySchema = z.object({
  proxyId: z.number().int().positive().nullable().default(null),       // 用户从 Sub2API 代理列表里选
  bypassGraceBatch: z.boolean().default(true)                          // intake 上的账号优先迁出
});

export type IntakePolicy = z.infer<typeof intakePolicySchema>;

// 总编排意图（Spec）
export const orchestrationSpecSchema = z.object({
  enabled: z.boolean().default(true),                                   // 火警开关：false 时只观测不执行
  reconcileIntervalMs: z.number().int().min(5_000).default(30_000),

  // 灰度阀（决策 #1：10% / 50，min）
  graceBatchPercent: z.number().min(0).max(100).default(10),
  graceBatchAbs: z.number().int().min(0).default(50),

  supply: supplyPolicySchema.default({}),
  capacity: capacityPolicySchema.default({}),
  stickiness: stickinessPolicySchema.default({}),
  health: healthPolicySchema.default({}),
  intake: intakePolicySchema.default({}),

  protectedRule: sub2ApiProtectedProxyRuleSchema.default({})
});

export type OrchestrationSpec = z.infer<typeof orchestrationSpecSchema>;

export const defaultOrchestrationSpec: OrchestrationSpec = orchestrationSpecSchema.parse({});

// reconcile tick 的执行结果 —— 写到 reconcile_ticks 表 + 内存暴露给 UI
export const reconcilePlannedChangeSchema = z.object({
  kind: z.enum([
    "drain_intake",          // intake 代理上的账号 → 引流到合适 Hive 节点（最高优先级）
    "bind_missing",          // 账号未绑定 → 绑到 HRW 目标
    "rebind_dead",           // 账号绑到已删/quarantined/evicted 代理 → 绑到健康目标
    "rebalance_overload",    // 从过载节点外迁
    "rebalance_fill",        // 填到欠载节点（partner of overload）
    "drift_correction"       // 理论 HRW 与现状偏差（最低优先级）
  ]),
  accountId: z.number().int().positive(),
  accountName: z.string().min(1),
  fromProxyId: z.number().int().positive().nullable(),
  toProxyId: z.number().int().positive(),
  reason: z.string().min(1)
});

export type ReconcilePlannedChange = z.infer<typeof reconcilePlannedChangeSchema>;

export const reconcileNodeIntentSchema = z.object({
  hash: z.string().min(8),
  proxyId: z.number().int().positive().nullable(),
  intentRole: nodeIntentRoleSchema,
  healthScore: z.number().int().min(0).max(100).nullable(),
  backoffUntil: z.string().nullable(),
  backoffAttempts: z.number().int().min(0),
  currentLoad: z.number().int().min(0),
  targetLoad: z.number().int().min(0),
  nextAction: z.string()
});

export type ReconcileNodeIntent = z.infer<typeof reconcileNodeIntentSchema>;

export const reconcileObservedSummarySchema = z.object({
  proxiesTotal: z.number().int().nonnegative(),
  proxiesServing: z.number().int().nonnegative(),
  proxiesQuarantined: z.number().int().nonnegative(),
  proxiesEvicted: z.number().int().nonnegative(),
  proxiesProtected: z.number().int().nonnegative(),
  proxiesManaged: z.number().int().nonnegative(),
  accountsTotal: z.number().int().nonnegative(),
  accountsAssignable: z.number().int().nonnegative(),
  accountsProtected: z.number().int().nonnegative(),
  capacityTotal: z.number().int().nonnegative(),
  utilizationPercent: z.number().min(0).max(100)
});

export type ReconcileObservedSummary = z.infer<typeof reconcileObservedSummarySchema>;

export const reconcileTickSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  enabled: z.boolean(),
  observedSummary: reconcileObservedSummarySchema,
  plannedTotal: z.number().int().nonnegative(),
  appliedTotal: z.number().int().nonnegative(),
  skippedReason: z.enum(["paused", "batch_capped", "no_change", "error", "applied"]),
  errorMessage: z.string().optional(),
  nodeIntents: z.array(reconcileNodeIntentSchema),
  plannedChanges: z.array(reconcilePlannedChangeSchema),
  appliedChanges: z.array(reconcilePlannedChangeSchema),
  operationId: z.string().optional()
});

export type ReconcileTick = z.infer<typeof reconcileTickSchema>;

// status snapshot — UI 主面板要的数据
export const orchestrationStatusSnapshotSchema = z.object({
  spec: orchestrationSpecSchema,
  lastTick: reconcileTickSchema.optional(),
  recentTicks: z.array(reconcileTickSchema),                            // 最近 N 条（默认 10）
  nodeIntents: z.array(reconcileNodeIntentSchema),
  observedSummary: reconcileObservedSummarySchema.optional(),
  // 衍生 KPI
  kpis: z.object({
    healthyProxies: z.number().int().nonnegative(),
    totalProxies: z.number().int().nonnegative(),
    utilizationPercent: z.number().min(0).max(100),
    driftCount24h: z.number().int().nonnegative(),
    quarantinedCount: z.number().int().nonnegative()
  })
});

export type OrchestrationStatusSnapshot = z.infer<typeof orchestrationStatusSnapshotSchema>;
