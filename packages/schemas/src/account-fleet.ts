import { z } from "zod";

/**
 * Account Fleet schemas —— 账号生命周期编排器的所有类型。
 * 设计文档：notes/account-fleet-design.md
 *
 * 三维状态（origin × intent × health）的语义：
 * - origin   = 账号来源 / 信任度，决定自动化等级
 * - intent   = 系统当前打算做什么
 * - health   = 最近一次观察的真实状态
 */

// ─── 三维状态 ───────────────────────────────────

export const accountOriginSchema = z.enum([
  "hive_registered",      // Hive 用 codex-tool 注册的，凭据全在
  "adopted_active",       // 接管自 Sub2API + 当前健康，凭据只在 Sub2API 端
  "adopted_recovered",    // 接管后通过 codex_login 救回，Hive 已掌握 phone+pwd+token
  "adopted_observing",    // 接管但缺凭据 / 当前 broken，等用户决策
  "retired_legacy"        // 用户主动弃用
]);
export type AccountOrigin = z.infer<typeof accountOriginSchema>;

export const accountIntentSchema = z.enum([
  "pending",        // 本地登记完成、Sub2API 端尚未存在（register/login job 排队中）
  "active",         // Sub2API 有对应记录，scheduler 视为正常
  "recovering",     // 当前 broken，有 job 在跑修复
  "retired"         // 已退役
]);
export type AccountIntent = z.infer<typeof accountIntentSchema>;

export const accountHealthSchema = z.enum([
  "healthy",            // has_refresh_token=true + usage 正常 + 无 upstream-errors
  "rate_limited",       // rate_limited_at 非空 + rate_limit_reset_at 未到
  "quota_exhausted",    // extra.codex_7d_used_percent ≥ 阈值
  "broken",             // has_refresh_token=false 或错误率破预算
  "unknown"             // 新接管未观察
]);
export type AccountHealth = z.infer<typeof accountHealthSchema>;

export const accountRecoveryPathSchema = z.enum(["codex_login", "codex_register"]);
export type AccountRecoveryPath = z.infer<typeof accountRecoveryPathSchema>;

// ─── 账号记录 ────────────────────────────────────

// 持久化层（含 enc_* 字段）——只在 server 内部使用，不出 API
export const accountRecordInternalSchema = z.object({
  id: z.string().min(1),
  externalId: z.number().int().positive().nullable(),
  origin: accountOriginSchema,
  intent: accountIntentSchema,
  health: accountHealthSchema,

  email: z.string().min(1),
  organizationId: z.string().nullable(),
  clientId: z.string().nullable(),
  platform: z.string().min(1).default("openai"),
  type: z.string().min(1).default("oauth"),

  // 加密字段
  encPhone: z.string().nullable(),
  encPassword: z.string().nullable(),
  encRefreshToken: z.string().nullable(),
  encAccessToken: z.string().nullable(),
  encIdToken: z.string().nullable(),
  encRecoveryInputJson: z.string().nullable(),

  // 观察快照
  lastObservedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  rateLimitedAt: z.string().nullable(),
  rateLimitResetAt: z.string().nullable(),
  quota5hPercent: z.number().int().min(0).max(100).nullable(),
  quota7dPercent: z.number().int().min(0).max(100).nullable(),
  errorsInWindow: z.number().int().nonnegative().default(0),
  brokenSinceTick: z.string().nullable(),
  brokenConsecutiveTicks: z.number().int().nonnegative().default(0),

  // 修复跟踪
  recoveryAttempts: z.number().int().nonnegative().default(0),
  nextRecoveryAfter: z.string().nullable(),
  lastRecoveryError: z.string().nullable(),
  lastRecoveryPath: accountRecoveryPathSchema.nullable(),

  // 溯源
  batchId: z.string().nullable(),
  registeredAt: z.string().nullable(),

  /**
   * 软粘性的代理出口偏好 —— 账号首次注册 / 上次登录用过的本地节点 hash。
   *
   * 不是强绑定：节点失效或质量下降时会 fallback 到加权选择。设计目标：
   *   - 减少同账号在不同节点之间漂移
   *   - 分散新账号到不同节点（避免"永远在同一个 IP 注册"被风控）
   *
   * 由 worker 的 codex_login / codex_register / import_to_sub2api 在选好节点
   * 后回写，不参与 reconcile 的 proxy_id 绑定（那是代理编排的领地）。
   */
  egressNodeHash: z.string().nullable(),

  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type AccountRecordInternal = z.infer<typeof accountRecordInternalSchema>;

// 对外暴露的脱敏视图（API / UI）——不含 enc_*，凭据只暴露布尔标记
export const accountRecordViewSchema = z.object({
  id: z.string().min(1),
  externalId: z.number().int().positive().nullable(),
  origin: accountOriginSchema,
  intent: accountIntentSchema,
  health: accountHealthSchema,

  email: z.string().min(1),
  organizationId: z.string().nullable(),
  platform: z.string().min(1),

  hasPhonePassword: z.boolean(),
  hasRefreshToken: z.boolean(),

  lastObservedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  rateLimitedAt: z.string().nullable(),
  rateLimitResetAt: z.string().nullable(),
  quota5hPercent: z.number().int().min(0).max(100).nullable(),
  quota7dPercent: z.number().int().min(0).max(100).nullable(),
  errorsInWindow: z.number().int().nonnegative().default(0),

  recoveryAttempts: z.number().int().nonnegative().default(0),
  nextRecoveryAfter: z.string().nullable(),
  lastRecoveryError: z.string().nullable(),
  lastRecoveryPath: accountRecoveryPathSchema.nullable(),

  batchId: z.string().nullable(),
  registeredAt: z.string().nullable(),
  egressNodeHash: z.string().nullable(),

  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type AccountRecordView = z.infer<typeof accountRecordViewSchema>;

// ─── Spec（用户配置）─────────────────────────────

export const accountFleetTargetPolicySchema = z.object({
  healthyAccountsTarget: z.number().int().nonnegative().default(50),
  targetGroupId: z.number().int().positive().default(2),
  defaultProxyId: z.number().int().positive().default(1),
  minHealthyRatio: z.number().min(0).max(1).default(0.8),
  naming: z
    .object({
      template: z.string().min(1).default("Hive-{date}-{seq}"),
      notes: z.string().default("")
    })
    .default({})
});

export type AccountFleetTargetPolicy = z.infer<typeof accountFleetTargetPolicySchema>;

export const accountFleetHealthPolicySchema = z.object({
  refreshTokenMissingAsUnhealthy: z.boolean().default(true),
  rateLimitedAsUnhealthy: z.boolean().default(false),
  quotaExhaustedThresholdPercent: z.number().int().min(0).max(100).default(95),
  usagePollIntervalMs: z.number().int().min(60_000).default(30 * 60_000),
  errorBudgetPerWindow: z.number().int().min(1).default(5),
  windowMs: z.number().int().min(60_000).default(5 * 60_000),
  adoptedDemotionConsecutiveTicks: z.number().int().min(1).default(3)
});

export type AccountFleetHealthPolicy = z.infer<typeof accountFleetHealthPolicySchema>;

export const accountFleetRecoveryPolicySchema = z.object({
  enabled: z.boolean().default(true),
  pathPriority: z.array(accountRecoveryPathSchema).min(1).default(["codex_login", "codex_register"]),
  maxConcurrent: z.number().int().min(1).max(10).default(2),
  backoffSequenceMs: z
    .array(z.number().int().min(1000))
    .min(1)
    .default([60_000, 5 * 60_000, 30 * 60_000, 6 * 3_600_000]),
  maxAttemptsPerAccount: z.number().int().min(1).default(5),
  perTickRecoveryCap: z.number().int().min(0).default(10),
  deleteOldAccountOnRecovery: z.boolean().default(true)
});

export type AccountFleetRecoveryPolicy = z.infer<typeof accountFleetRecoveryPolicySchema>;

export const accountFleetRegistrationPolicySchema = z.object({
  enabled: z.boolean().default(true),
  perTickCap: z.number().int().min(0).default(5),
  dailyBudget: z.number().int().min(0).default(50),
  monthlyBudget: z.number().int().min(0).default(1000),
  smsCountry: z.string().min(1).default("6"),
  smsFallbackCountries: z.array(z.string().min(1)).default([]),
  autoAssignGroupIds: z.array(z.number().int().positive()).default([2]),
  autoAssignProxyId: z.number().int().positive().default(1),
  emergencyMode: z
    .object({
      enabled: z.boolean().default(true),
      perTickCap: z.number().int().min(0).default(10),
      ignoreDailyBudget: z.boolean().default(false)
    })
    .default({})
});

export type AccountFleetRegistrationPolicy = z.infer<typeof accountFleetRegistrationPolicySchema>;

export const accountFleetRetirementPolicySchema = z.object({
  afterMaxFailedRecoveries: z.boolean().default(true),
  afterDeadDays: z.number().int().min(1).default(7),
  deleteOnRetire: z.boolean().default(false),
  drainBeforeDeleteMs: z.number().int().min(0).default(10 * 60_000)
});

export type AccountFleetRetirementPolicy = z.infer<typeof accountFleetRetirementPolicySchema>;

export const accountFleetCodexToolPolicySchema = z.object({
  binPath: z.string().default("codex-tool"),
  skymail: z
    .object({
      baseUrl: z.string().default(""),
      adminEmail: z.string().default(""),
      adminPasswordRef: z.string().default("")
    })
    .default({}),
  chatgpt: z
    .object({
      mailDomain: z.string().default(""),
      chatWebClientId: z.string().default(""),
      codexClientId: z.string().default("")
    })
    .default({}),
  phoneSms: z
    .object({
      provider: z.enum(["herosms", "fivesim", "nexsms"]).default("herosms"),
      apiKeyRef: z.string().default(""),
      service: z.string().default("dr")
    })
    .default({}),
  httpUserAgentChrome: z
    .string()
    .default(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    ),
  egress: z
    .object({
      mode: z.enum(["managed-node", "pinned-node", "none"]).default("managed-node"),
      pinnedNodeHash: z.string().nullable().default(null)
    })
    .default({}),
  timeouts: z
    .object({
      smsCountriesMs: z.number().int().min(1000).default(30_000),
      loginMs: z.number().int().min(1000).default(90_000),
      registerMs: z.number().int().min(1000).default(300_000)
    })
    .default({})
});

export type AccountFleetCodexToolPolicy = z.infer<typeof accountFleetCodexToolPolicySchema>;

export const accountFleetSpecSchema = z.object({
  enabled: z.boolean().default(true),
  reconcileIntervalMs: z.number().int().min(30_000).default(5 * 60_000),
  graceBatchPercent: z.number().min(0).max(100).default(10),
  graceBatchAbs: z.number().int().min(0).default(50),

  target: accountFleetTargetPolicySchema.default({}),
  health: accountFleetHealthPolicySchema.default({}),
  recovery: accountFleetRecoveryPolicySchema.default({}),
  registration: accountFleetRegistrationPolicySchema.default({}),
  retirement: accountFleetRetirementPolicySchema.default({}),
  codexTool: accountFleetCodexToolPolicySchema.default({})
});

export type AccountFleetSpec = z.infer<typeof accountFleetSpecSchema>;

export const defaultAccountFleetSpec: AccountFleetSpec = accountFleetSpecSchema.parse({});

// ─── Tick / Plan ─────────────────────────────────

export const accountFleetActionKindSchema = z.enum([
  "demote_to_observing",        // adopted_active → adopted_observing
  "recover_via_login",          // PATH_A
  "recover_via_register",       // PATH_B
  "register_new",               // 常规补充 / 紧急补给
  "retire",                     // 退役
  "delete_external",            // 从 Sub2API 删除
  "toggle_schedulable",         // 改 schedulable=false/true
  "observe_usage",              // /usage 轮询
  "defer"                       // 仍在退避窗口
]);
export type AccountFleetActionKind = z.infer<typeof accountFleetActionKindSchema>;

export const accountFleetPlannedActionSchema = z.object({
  kind: accountFleetActionKindSchema,
  accountId: z.string().nullable(),
  externalId: z.number().int().positive().nullable(),
  email: z.string().nullable(),
  reason: z.string().min(1)
});

export type AccountFleetPlannedAction = z.infer<typeof accountFleetPlannedActionSchema>;

export const accountFleetObservedSummarySchema = z.object({
  totalAccounts: z.number().int().nonnegative(),
  byHealth: z.object({
    healthy: z.number().int().nonnegative(),
    rate_limited: z.number().int().nonnegative(),
    quota_exhausted: z.number().int().nonnegative(),
    broken: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative()
  }),
  byOrigin: z.object({
    hive_registered: z.number().int().nonnegative(),
    adopted_active: z.number().int().nonnegative(),
    adopted_recovered: z.number().int().nonnegative(),
    adopted_observing: z.number().int().nonnegative(),
    retired_legacy: z.number().int().nonnegative()
  }),
  byIntent: z.object({
    pending: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    recovering: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative()
  }),
  healthyCount: z.number().int().nonnegative(),
  target: z.number().int().nonnegative(),
  targetGap: z.number().int(),
  minHealthyRatio: z.number(),
  emergencyMode: z.boolean(),
  dailyRegistrationsUsed: z.number().int().nonnegative(),
  dailyRegistrationsBudget: z.number().int().nonnegative(),
  monthlyRegistrationsUsed: z.number().int().nonnegative(),
  monthlyRegistrationsBudget: z.number().int().nonnegative()
});

export type AccountFleetObservedSummary = z.infer<typeof accountFleetObservedSummarySchema>;

export const accountFleetTickSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  enabled: z.boolean(),
  skippedReason: z.enum([
    "applied",
    "no_change",
    "paused",
    "batch_capped",
    "budget_exhausted",
    "error",
    "dry_run"
  ]),
  errorMessage: z.string().optional(),
  plannedTotal: z.number().int().nonnegative(),
  appliedTotal: z.number().int().nonnegative(),
  observed: accountFleetObservedSummarySchema,
  plannedActions: z.array(accountFleetPlannedActionSchema),
  appliedActions: z.array(accountFleetPlannedActionSchema),
  triggeredJobIds: z.array(z.string().min(1)).default([])
});

export type AccountFleetTick = z.infer<typeof accountFleetTickSchema>;

export const accountFleetTickSummarySchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  enabled: z.boolean(),
  plannedTotal: z.number().int().nonnegative(),
  appliedTotal: z.number().int().nonnegative(),
  skippedReason: accountFleetTickSchema.shape.skippedReason,
  errorMessage: z.string().optional()
});

export type AccountFleetTickSummary = z.infer<typeof accountFleetTickSummarySchema>;

// ─── Jobs ─────────────────────────────────────────

export const accountJobKindSchema = z.enum([
  "codex_login",          // codex-tool login → fresh tokens → import to Sub2API
  "codex_register",       // codex-tool all → 新账号
  "import_to_sub2api",    // 已有 refresh_token，灌到 Sub2API（试探导入用）
  "delete_sub2api",       // DELETE /accounts/{id}
  "toggle_schedulable",   // PUT /accounts/{id}/schedulable
  "observe_usage"         // GET /accounts/{id}/usage
]);
export type AccountJobKind = z.infer<typeof accountJobKindSchema>;

export const accountJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);
export type AccountJobStatus = z.infer<typeof accountJobStatusSchema>;

export const accountJobTriggeredBySchema = z.enum(["scheduler", "manual", "adopter"]);
export type AccountJobTriggeredBy = z.infer<typeof accountJobTriggeredBySchema>;

export const accountJobSchema = z.object({
  id: z.string().min(1),
  kind: accountJobKindSchema,
  accountId: z.string().nullable(),
  status: accountJobStatusSchema,
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(1),
  priority: z.number().int().default(100),
  scheduledAt: z.string().min(1),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  payloadJson: z.string(),
  resultJson: z.string().nullable(),
  errorMessage: z.string().nullable(),
  triggeredBy: accountJobTriggeredBySchema,
  triggeredTickId: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type AccountJob = z.infer<typeof accountJobSchema>;

// ─── Budgets ──────────────────────────────────────

export const accountBudgetRecordSchema = z.object({
  windowKey: z.string().min(1),
  registrationsUsed: z.number().int().nonnegative().default(0),
  registrationsBudget: z.number().int().nonnegative(),
  smsCostCents: z.number().int().nonnegative().default(0),
  resetAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type AccountBudgetRecord = z.infer<typeof accountBudgetRecordSchema>;

// ─── Status snapshot for UI ──────────────────────

export const accountFleetStatusSnapshotSchema = z.object({
  spec: accountFleetSpecSchema,
  lastTick: accountFleetTickSchema.optional(),
  recentTicks: z.array(accountFleetTickSummarySchema),
  accounts: z.array(accountRecordViewSchema),
  recentJobs: z.array(accountJobSchema),
  kpis: z.object({
    totalAccounts: z.number().int().nonnegative(),
    healthyCount: z.number().int().nonnegative(),
    target: z.number().int().nonnegative(),
    brokenCount: z.number().int().nonnegative(),
    recoveringCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    todayRegistrationsUsed: z.number().int().nonnegative(),
    todayRegistrationsBudget: z.number().int().nonnegative(),
    monthlyRegistrationsUsed: z.number().int().nonnegative(),
    monthlyRegistrationsBudget: z.number().int().nonnegative()
  })
});

export type AccountFleetStatusSnapshot = z.infer<typeof accountFleetStatusSnapshotSchema>;
