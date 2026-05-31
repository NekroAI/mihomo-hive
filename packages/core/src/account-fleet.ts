/**
 * Account Fleet 调度纯函数 —— sense → diagnose → plan → gate。
 *
 * 设计文档：notes/account-fleet-design.md §7 (修复路径决策树) + §8 (调度循环)
 *
 * 不做任何 I/O。所有外部数据通过 input 传入。调度器/路由器去真正写 jobs 表 + 远端。
 *
 * 关键 invariants：
 *   - origin=retired_legacy / adopted_observing → 永不触发自动修复
 *   - origin=adopted_active 掉线 → 先连续 N tick 都 broken 才降级，避免误判
 *   - 修复优先 PATH_A (codex_login)，仅在没 phone+password 时降级到 PATH_B (codex_register)
 *   - PATH_B 受 dailyBudget + monthlyBudget + perTickCap 三层熔断
 *   - 紧急补给（healthy/target < minHealthyRatio）→ 提升 perTickCap 上限但仍受日预算
 */

import type {
  AccountFleetObservedSummary,
  AccountFleetPlannedAction,
  AccountFleetSpec,
  AccountHealth,
  AccountIntent,
  AccountOrigin,
  AccountRecordInternal,
  Sub2ApiAccountRecord,
  Sub2ApiUpstreamError
} from "@mihomo-hive/schemas";

// ─── Input/Output ───────────────────────────────

export interface AccountFleetInput {
  now: Date;
  spec: AccountFleetSpec;
  localAccounts: AccountRecordInternal[];
  /** Sub2API live accounts（已过 platform filter）。可选；不传 = 跳过 sense 同步逻辑（纯本地 plan）。 */
  remoteAccounts?: Sub2ApiAccountRecord[];
  /** 按 account_id 索引的 upstream errors 计数（窗口内）。 */
  upstreamErrorsByAccountId?: Map<number, number>;
  /**
   * Sub2API 自己判定为不可用的账号（status=error，如 "Token revoked (401)"）。
   * 按 externalId 索引 → 错误原因字符串。这是确定性「需重登」信号：Sub2API 已经把
   * 账号停用（schedulable=false），即便 has_refresh_token=true、配额很低，账号也用不了。
   * diagnose 据此最高优先级判 broken，避免误判健康。
   */
  remoteAuthErrorByExternalId?: Map<number, string>;
  /** 当前预算状态。 */
  budgetState: {
    dailyUsed: number;
    dailyBudget: number;
    monthlyUsed: number;
    monthlyBudget: number;
  };
}

export interface AccountFleetPlanResult {
  /** 新建 / 更新本地 accounts 记录（sense 同步出来的）。 */
  observedAccounts: AccountRecordInternal[];
  /** 给 scheduler 的 observed 汇总。 */
  observedSummary: AccountFleetObservedSummary;
  /** Plan 阶段生成的所有动作（未经 gate）。 */
  plannedActions: AccountFleetPlannedAction[];
  /** Gate 之后保留的动作（实际应该入队的）。 */
  gatedActions: AccountFleetPlannedAction[];
  /** paused / batch_capped / budget_exhausted / no_change / applied —— 由调度器最终决定。 */
  inferredSkippedReason: "paused" | "no_change" | "batch_capped" | "budget_exhausted" | "applied";
}

// ─── 入口 ────────────────────────────────────────

export function planAccountFleet(input: AccountFleetInput): AccountFleetPlanResult {
  const observedAccounts = senseAccounts(input);
  const diagnosed = diagnoseAccounts(input, observedAccounts);
  const observedSummary = summarize(input, diagnosed);
  const planned = planActions(input, diagnosed, observedSummary);
  const gated = gateActions(input.spec, planned, observedSummary);

  let skipped: AccountFleetPlanResult["inferredSkippedReason"] = "applied";
  if (!input.spec.enabled) {
    skipped = "paused";
  } else if (planned.length === 0) {
    skipped = "no_change";
  } else if (gated.length === 0 && planned.length > 0) {
    // 分辨预算耗尽 vs 一般 batch cap
    const wantedRegisters = planned.filter((p) => p.kind === "register_new" || p.kind === "recover_via_register").length;
    if (
      wantedRegisters > 0 &&
      input.budgetState.dailyUsed >= input.budgetState.dailyBudget &&
      input.budgetState.dailyBudget > 0
    ) {
      skipped = "budget_exhausted";
    } else {
      skipped = "batch_capped";
    }
  } else if (gated.length < planned.length) {
    // 部分被 cap
    skipped = "applied";
  }

  return {
    observedAccounts: diagnosed,
    observedSummary,
    plannedActions: planned,
    gatedActions: gated,
    inferredSkippedReason: skipped
  };
}

// ─── Step 1: sense ───────────────────────────────

/**
 * 合并本地 + 远端账号视图，处理三类不对齐：
 *   - 本地有 + 远端无 → 本地标 retired（除非 intent=pending 表示注册中）
 *   - 远端有 + 本地无 → 自动登记 adopted_active（健康）/ adopted_observing（broken）
 *   - 双有 → 更新远端观察字段（health / rate_limit / observed_at）
 */
function senseAccounts(input: AccountFleetInput): AccountRecordInternal[] {
  const out: AccountRecordInternal[] = input.localAccounts.map((a) => ({ ...a }));
  const byExternal = new Map<number, AccountRecordInternal>();
  for (const acc of out) {
    if (acc.externalId !== null) byExternal.set(acc.externalId, acc);
  }

  const remote = input.remoteAccounts;
  if (!remote) return out;

  const nowIso = input.now.toISOString();
  const seenExternal = new Set<number>();

  for (const r of remote) {
    seenExternal.add(r.id);
    const fields = extractRemoteFields(r);
    const existing = byExternal.get(r.id);
    if (existing) {
      // 双有：更新远端观察字段（一次性把 sense 阶段能拿到的字段都同步）
      if (fields.email) existing.email = fields.email;
      if (fields.organizationId) existing.organizationId = fields.organizationId;
      if (fields.clientId) existing.clientId = fields.clientId;
      existing.platform = fields.platform;
      existing.type = fields.type;
      existing.lastObservedAt = nowIso;
      existing.lastUsedAt = fields.lastUsedAt ?? existing.lastUsedAt;
      existing.rateLimitedAt = fields.rateLimitedAt;
      existing.rateLimitResetAt = fields.rateLimitResetAt;
      existing.quota5hPercent = fields.quota5hPercent;
      existing.quota7dPercent = fields.quota7dPercent;
      // 如果原本是 unknown email（旧 bug 数据），现在拿到真实 email 后纠正一次
      if (existing.email.startsWith("unknown-") && fields.email) {
        existing.email = fields.email;
      }
      continue;
    }
    // 远端有 + 本地无 → 自动登记
    const hasRefresh = fields.hasRefreshToken;
    const origin: AccountOrigin = hasRefresh ? "adopted_active" : "adopted_observing";
    const intent: AccountIntent = "active";
    // 健康初值给 unknown，让 diagnose 根据全部信号给出最终判定
    const health: AccountHealth = "unknown";
    out.push({
      id: `adopt-${r.id}-${Math.random().toString(36).slice(2, 8)}`,
      externalId: r.id,
      origin,
      intent,
      health,
      email: fields.email ?? `unknown-${r.id}`,
      organizationId: fields.organizationId,
      clientId: fields.clientId,
      platform: fields.platform,
      type: fields.type,
      encPhone: null,
      encPassword: null,
      encRefreshToken: null,
      encAccessToken: null,
      encIdToken: null,
      encRecoveryInputJson: null,
      lastObservedAt: nowIso,
      lastUsedAt: fields.lastUsedAt,
      rateLimitedAt: fields.rateLimitedAt,
      rateLimitResetAt: fields.rateLimitResetAt,
      quota5hPercent: fields.quota5hPercent,
      quota7dPercent: fields.quota7dPercent,
      errorsInWindow: 0,
      brokenSinceTick: null,
      brokenConsecutiveTicks: 0,
      recoveryAttempts: 0,
      nextRecoveryAfter: null,
      lastRecoveryError: null,
      lastRecoveryPath: null,
      lastRecoveryFailureCategory: null,
      opsEnabled: true,
      herosmsActivationId: null,
      batchId: null,
      registeredAt: null,
      // adopted_* 不是本地注册，没有 sms_country / sms_cost 经验
      smsCountry: null,
      smsCostCents: null,
      egressNodeHash: null,
      // P5-AQ: 接管时没有更早的来源时间 → 用接管时间作首见时间兜底
      firstSeenAt: nowIso,
      reloginCount: 0,
      lastRecoveredAt: null,
      createdAt: nowIso,
      updatedAt: nowIso
    });
  }

  // 本地有 + 远端无 → 标 retired（保留观察记录，便于后续审计）
  // 注意：intent=pending 的本地账号（register/login job 排队中）不该被改
  for (const acc of out) {
    if (acc.externalId === null) continue;
    if (seenExternal.has(acc.externalId)) continue;
    if (acc.intent === "pending") continue;
    acc.intent = "retired";
    acc.health = "broken";
    acc.lastObservedAt = nowIso;
  }

  return out;
}

/**
 * 提取 Sub2API account 记录里 sense 关心的字段。
 *
 * 抓包确认的真实结构（参考 docs/Sub2API 代理配置.md §"获取账号列表"）：
 *   - email 在 credentials.email（顶层 email 字段实际不返回）
 *   - has_refresh_token 在 credentials_status.has_refresh_token
 *   - 配额在 extra.codex_5h_used_percent / extra.codex_7d_used_percent
 *   - last_used_at / rate_limited_at / rate_limit_reset_at 在顶层
 */
function extractRemoteFields(r: Sub2ApiAccountRecord): {
  email: string | null;
  organizationId: string | null;
  clientId: string | null;
  platform: string;
  type: string;
  hasRefreshToken: boolean;
  lastUsedAt: string | null;
  rateLimitedAt: string | null;
  rateLimitResetAt: string | null;
  quota5hPercent: number | null;
  quota7dPercent: number | null;
} {
  const cred = r.credentials ?? null;
  const credStatus = r.credentials_status ?? null;
  const extra = r.extra ?? null;
  // email 优先级：credentials.email > extra.email > 顶层 email
  const email =
    (cred?.email && String(cred.email)) ||
    (extra?.email && String(extra.email)) ||
    (r.email && String(r.email)) ||
    null;
  const organizationId = cred?.organization_id ? String(cred.organization_id) : null;
  const clientId = cred?.client_id ? String(cred.client_id) : null;
  const hasRefreshToken =
    typeof credStatus?.has_refresh_token === "boolean"
      ? credStatus.has_refresh_token
      : // 兜底：抓包里 credentials_status 永远三个 boolean；缺它时退回看 status
        r.status === "active";
  const lastUsedAt = r.last_used_at ?? null;
  const rateLimitedAt = r.rate_limited_at ?? null;
  const rateLimitResetAt = r.rate_limit_reset_at ?? null;
  // codex_*_used_percent 字段是浮点 0–100；本地存整数 0–100
  const quota5hPercent = clampPercent(extra?.codex_5h_used_percent);
  const quota7dPercent = clampPercent(extra?.codex_7d_used_percent);
  return {
    email,
    organizationId,
    clientId,
    platform: r.platform ?? "openai",
    type: r.type ?? "oauth",
    hasRefreshToken,
    lastUsedAt,
    rateLimitedAt,
    rateLimitResetAt,
    quota5hPercent,
    quota7dPercent
  };
}

function clampPercent(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ─── Step 2: diagnose ────────────────────────────

function diagnoseAccounts(
  input: AccountFleetInput,
  accounts: AccountRecordInternal[]
): AccountRecordInternal[] {
  const errorsBy = input.upstreamErrorsByAccountId ?? new Map<number, number>();
  const authErrorBy = input.remoteAuthErrorByExternalId ?? new Map<number, string>();
  const policy = input.spec.health;
  const nowIso = input.now.toISOString();
  const out = accounts.map((a) => ({ ...a }));

  for (const acc of out) {
    // skip 已退役 / pending（pending 还没有远端记录）
    if (acc.intent === "retired" || acc.intent === "pending") continue;

    const errors = acc.externalId !== null ? errorsBy.get(acc.externalId) ?? 0 : 0;
    acc.errorsInWindow = errors;

    // 最高优先级：Sub2API 标 status=error（OAuth token 失效 / revoked）→ 直接 broken。
    // 这是确定性「需重登」信号，优先于配额/限流判定：token 都失效了配额再低也用不了。
    // 把 Sub2API 给的原因写进 lastRecoveryError 方便 UI 展示"为什么挂了"。
    const remoteAuthError = acc.externalId !== null ? authErrorBy.get(acc.externalId) : undefined;
    if (remoteAuthError) {
      acc.health = "broken";
      acc.lastRecoveryError = remoteAuthError;
      if (!acc.brokenSinceTick) acc.brokenSinceTick = nowIso;
      acc.brokenConsecutiveTicks = (acc.brokenConsecutiveTicks ?? 0) + 1;
      acc.updatedAt = nowIso;
      continue;
    }

    // 优先级：quota_exhausted > rate_limited > broken > healthy
    if (acc.quota7dPercent !== null && acc.quota7dPercent >= policy.quotaExhaustedThresholdPercent) {
      acc.health = "quota_exhausted";
    } else if (acc.rateLimitedAt) {
      // 如果 reset_at 已过，rate_limit 自然结束
      if (acc.rateLimitResetAt && new Date(acc.rateLimitResetAt) <= input.now) {
        // 重置：清掉
        acc.rateLimitedAt = null;
        acc.rateLimitResetAt = null;
        acc.health = errors >= policy.errorBudgetPerWindow ? "broken" : "healthy";
      } else {
        acc.health = policy.rateLimitedAsUnhealthy ? "broken" : "rate_limited";
      }
    } else if (errors >= policy.errorBudgetPerWindow) {
      acc.health = "broken";
    } else if (acc.intent === "recovering") {
      // 正在修，保持 broken/recovering 视觉
      acc.health = "broken";
    } else {
      acc.health = "healthy";
    }

    // 维护 brokenConsecutiveTicks 给 adopted_active 降级用
    if (acc.health === "broken") {
      if (!acc.brokenSinceTick) acc.brokenSinceTick = nowIso;
      acc.brokenConsecutiveTicks = (acc.brokenConsecutiveTicks ?? 0) + 1;
    } else {
      acc.brokenSinceTick = null;
      acc.brokenConsecutiveTicks = 0;
    }

    acc.updatedAt = nowIso;
  }

  return out;
}

// ─── Step 3: summarize ───────────────────────────

function summarize(input: AccountFleetInput, accounts: AccountRecordInternal[]): AccountFleetObservedSummary {
  const byHealth: AccountFleetObservedSummary["byHealth"] = {
    healthy: 0,
    rate_limited: 0,
    quota_exhausted: 0,
    broken: 0,
    unknown: 0
  };
  const byOrigin: AccountFleetObservedSummary["byOrigin"] = {
    hive_registered: 0,
    adopted_active: 0,
    adopted_recovered: 0,
    adopted_observing: 0,
    retired_legacy: 0
  };
  const byIntent: AccountFleetObservedSummary["byIntent"] = {
    pending: 0,
    active: 0,
    recovering: 0,
    retired: 0
  };
  for (const a of accounts) {
    byHealth[a.health]++;
    byOrigin[a.origin]++;
    byIntent[a.intent]++;
  }
  const healthyCount = byHealth.healthy;
  const target = input.spec.target.healthyAccountsTarget;
  const targetGap = target - healthyCount;
  const minRatio = input.spec.target.minHealthyRatio;
  const emergencyMode = input.spec.registration.emergencyMode.enabled && target > 0 && healthyCount / target < minRatio;

  return {
    totalAccounts: accounts.length,
    byHealth,
    byOrigin,
    byIntent,
    healthyCount,
    target,
    targetGap,
    minHealthyRatio: minRatio,
    emergencyMode,
    dailyRegistrationsUsed: input.budgetState.dailyUsed,
    dailyRegistrationsBudget: input.budgetState.dailyBudget,
    monthlyRegistrationsUsed: input.budgetState.monthlyUsed,
    monthlyRegistrationsBudget: input.budgetState.monthlyBudget
  };
}

// ─── Step 4: plan ────────────────────────────────

function planActions(
  input: AccountFleetInput,
  accounts: AccountRecordInternal[],
  summary: AccountFleetObservedSummary
): AccountFleetPlannedAction[] {
  const out: AccountFleetPlannedAction[] = [];
  const policy = input.spec;
  const now = input.now;

  // (1) 降级：adopted_active 满足 brokenConsecutiveTicks ≥ 阈值
  for (const acc of accounts) {
    if (acc.intent === "retired") continue; // 已退役不再处理
    if (
      acc.origin === "adopted_active" &&
      acc.health === "broken" &&
      acc.brokenConsecutiveTicks >= policy.health.adoptedDemotionConsecutiveTicks
    ) {
      out.push({
        kind: "demote_to_observing",
        accountId: acc.id,
        externalId: acc.externalId,
        email: acc.email,
        reason: `broken for ${acc.brokenConsecutiveTicks} consecutive ticks ≥ ${policy.health.adoptedDemotionConsecutiveTicks}`
      });
    }
  }

  // (2) 退役
  const retirementDeadDaysMs = policy.retirement.afterDeadDays * 24 * 60 * 60 * 1000;
  for (const acc of accounts) {
    if (acc.intent === "retired") continue;
    if (acc.origin === "retired_legacy") continue;
    // 失败次数耗尽
    if (
      policy.retirement.afterMaxFailedRecoveries &&
      acc.recoveryAttempts >= policy.recovery.maxAttemptsPerAccount &&
      isAutoRecoverable(acc)
    ) {
      out.push({
        kind: "retire",
        accountId: acc.id,
        externalId: acc.externalId,
        email: acc.email,
        reason: `recovery_attempts=${acc.recoveryAttempts} ≥ max ${policy.recovery.maxAttemptsPerAccount}`
      });
      continue;
    }
    // 死号 N 天
    if (
      acc.lastUsedAt &&
      acc.health === "broken" &&
      now.getTime() - new Date(acc.lastUsedAt).getTime() > retirementDeadDaysMs
    ) {
      out.push({
        kind: "retire",
        accountId: acc.id,
        externalId: acc.externalId,
        email: acc.email,
        reason: `broken + no usage for ${policy.retirement.afterDeadDays}d`
      });
    }
  }
  const retiringIds = new Set(out.filter((p) => p.kind === "retire").map((p) => p.accountId));

  // (3) 修复 broken（PATH_A → PATH_B）
  if (policy.recovery.enabled) {
    for (const acc of accounts) {
      if (acc.health !== "broken") continue;
      // 运维开关关闭 → 该账号暂停一切自动恢复(用于隔离实验:停掉现有账号、只跑新账号)。
      if (acc.opsEnabled === false) continue;
      // P6-14 关键修复：已退役账号 health 仍为 broken，但绝不能再排恢复 —— 否则每个 tick
      // 都给死号重新入队 recover_via_login，被执行前拦截删除后又入队，无限空转。
      if (acc.intent === "retired") continue;
      if (retiringIds.has(acc.id)) continue;
      // 不自动修复的 origins
      if (acc.origin === "retired_legacy" || acc.origin === "adopted_observing") continue;
      // adopted_active 还没降级到 observing 之前不主动修复（要先降级，下个 tick 再决定）
      if (acc.origin === "adopted_active") continue;
      // 在退避窗口
      if (acc.nextRecoveryAfter && new Date(acc.nextRecoveryAfter) > now) {
        out.push({
          kind: "defer",
          accountId: acc.id,
          externalId: acc.externalId,
          email: acc.email,
          reason: `nextRecoveryAfter=${acc.nextRecoveryAfter}`
        });
        continue;
      }
      // 选择路径：根据 policy.pathPriority 顺序 + 资源可用性
      const path = pickRecoveryPath(acc, policy.recovery.pathPriority);
      if (!path) {
        // 无 phone+password 且 register 不启用：标 defer
        out.push({
          kind: "defer",
          accountId: acc.id,
          externalId: acc.externalId,
          email: acc.email,
          reason: "no recovery path available (missing phone+password, register disabled)"
        });
        continue;
      }
      out.push({
        kind: path === "codex_login" ? "recover_via_login" : "recover_via_register",
        accountId: acc.id,
        externalId: acc.externalId,
        email: acc.email,
        reason: `broken account, attempt=${acc.recoveryAttempts}, path=${path}`
      });
    }
  }

  // (4) 常规补充 / 紧急补给
  //
  // 设计原则：plan 仅关心"需求"（gap）+ perTickCap；预算/graceBatch 留给 gate 阶段。
  // 这样让 inferredSkippedReason="budget_exhausted" 能被检测出来（plan 出了 N 个但
  // gate 全砍掉）。
  if (policy.registration.enabled) {
    const cap = summary.emergencyMode
      ? policy.registration.emergencyMode.perTickCap
      : policy.registration.perTickCap;
    const gap = Math.max(0, summary.targetGap);
    // P5-AW 均衡度：只用注册补缺口的一部分(bias%)，其余留给重登旧账号恢复。
    // 紧急模式下忽略 bias（缺口已低于安全线，能补多少补多少）。
    const bias = summary.emergencyMode ? 100 : policy.target.registerBias;
    const biasedGap = Math.ceil((gap * bias) / 100);
    const count = Math.min(cap, biasedGap);
    for (let i = 0; i < count; i++) {
      out.push({
        kind: "register_new",
        accountId: null,
        externalId: null,
        email: null,
        reason: summary.emergencyMode
          ? `emergency supply: healthy=${summary.healthyCount}/${summary.target} < ratio ${summary.minHealthyRatio}`
          : `regular fill: gap=${gap}`
      });
    }
  }

  // (5) observe_usage：仅对 active 且最近未轮询过的 active 账号
  for (const acc of accounts) {
    if (acc.intent !== "active") continue;
    if (acc.externalId === null) continue;
    if (
      !acc.lastObservedAt ||
      now.getTime() - new Date(acc.lastObservedAt).getTime() >= policy.health.usagePollIntervalMs
    ) {
      out.push({
        kind: "observe_usage",
        accountId: acc.id,
        externalId: acc.externalId,
        email: acc.email,
        reason: "usage poll interval reached"
      });
    }
  }

  return out;
}

function isAutoRecoverable(acc: AccountRecordInternal): boolean {
  return acc.origin === "hive_registered" || acc.origin === "adopted_recovered";
}

function pickRecoveryPath(
  acc: AccountRecordInternal,
  priority: AccountFleetSpec["recovery"]["pathPriority"]
): "codex_login" | "codex_register" | null {
  const hasLogin = Boolean(acc.encPhone) && Boolean(acc.encPassword);
  for (const p of priority) {
    if (p === "codex_login" && hasLogin) return "codex_login";
    if (p === "codex_register") return "codex_register";
  }
  return null;
}

// ─── Step 5: gate ────────────────────────────────

function gateActions(
  spec: AccountFleetSpec,
  planned: AccountFleetPlannedAction[],
  summary: AccountFleetObservedSummary
): AccountFleetPlannedAction[] {
  if (!spec.enabled) return [];

  const dailyRemaining = Math.max(0, summary.dailyRegistrationsBudget - summary.dailyRegistrationsUsed);
  const monthlyRemaining = Math.max(0, summary.monthlyRegistrationsBudget - summary.monthlyRegistrationsUsed);

  const out: AccountFleetPlannedAction[] = [];
  let recoveryUsed = 0;
  let registerUsed = 0;
  let totalChanges = 0;

  // graceBatch 总变更上限：影响所有"实际修改"动作（不含 defer / observe_usage）
  const totalCap =
    spec.graceBatchPercent > 0
      ? Math.max(spec.graceBatchAbs, Math.ceil((summary.totalAccounts * spec.graceBatchPercent) / 100))
      : spec.graceBatchAbs;

  for (const action of planned) {
    // defer / observe_usage / demote 不参与变更 cap
    if (action.kind === "defer" || action.kind === "observe_usage" || action.kind === "demote_to_observing") {
      out.push(action);
      continue;
    }
    if (action.kind === "recover_via_login" || action.kind === "recover_via_register") {
      if (recoveryUsed >= spec.recovery.perTickRecoveryCap) continue;
      // recover_via_register 也消耗 register 配额
      if (action.kind === "recover_via_register") {
        if (registerUsed >= dailyRemaining || registerUsed >= monthlyRemaining) continue;
        registerUsed++;
      }
      recoveryUsed++;
    }
    if (action.kind === "register_new") {
      if (registerUsed >= dailyRemaining || registerUsed >= monthlyRemaining) continue;
      registerUsed++;
    }
    if (totalChanges >= totalCap) continue;
    out.push(action);
    if (action.kind !== "retire" && action.kind !== "delete_external") {
      totalChanges++;
    }
  }
  return out;
}
