/**
 * AccountJobsWorker —— 异步消费 account_jobs 队列。
 *
 * 设计文档：notes/account-fleet-design.md §9 (Jobs Worker 与 codex-tool adapter)
 *
 * 设计原则：
 *   - 每次 poll 一条 status='queued' AND scheduled_at ≤ now 的 job
 *   - 受 spec.recovery.maxConcurrent 限制总并发
 *   - 每个 kind 走对应 handler；handler 失败 → 写 error + 更新账号 backoff
 *   - 完成后立刻 poll 下一条（直到 queue 空 / 并发满）
 *   - 失败的 account 会被 scheduler 下个 tick 按 backoffSequenceMs 重新规划
 *
 * 安全：
 *   - codex-tool stdout 含完整 token，**不落日志**——adapter 内部解析后即刻 GC
 *   - jobs.payloadJson / resultJson 入库前用 safeRedact 过一遍敏感字段
 */

import { randomUUID } from "node:crypto";
import {
  buildEgressLoadMap,
  createCodexToolAdapter,
  createSub2ApiClient,
  loadAccountCrypto,
  NoEgressAvailableError,
  selectEgressForLogin,
  selectEgressForRegister,
  type AccountCrypto,
  type CodexToolAdapter,
  type CodexToolConfig,
  type EgressSelection,
  type Sub2ApiClient
} from "@mihomo-hive/core";
import { HiveRepository } from "@mihomo-hive/db";
import type {
  AccountFleetSpec,
  AccountJob,
  AccountRecordInternal,
  ProxyNode,
  Sub2ApiCreateAccountPayload
} from "@mihomo-hive/schemas";
import { budgetWindowKey } from "./account-fleet-orchestrator.js";

export interface AccountJobsWorkerHandle {
  /** 立刻尝试 poll 一次（测试 / UI 手动触发用）。 */
  pump: () => Promise<void>;
  stop: () => void;
}

export interface AccountJobsWorkerOptions {
  repo: HiveRepository;
  /**
   * 用于解密 enc_phone / enc_password / enc_refresh_token 的加密器。
   * 默认从 process.env.HIVE_ACCOUNT_KEY 加载；测试可注入。
   */
  crypto?: AccountCrypto;
  /** 默认 5_000ms。worker 空闲时等多久再 poll。 */
  idlePollMs?: number;
  /** 测试用：禁用自动循环，只通过 pump() 触发。 */
  manualOnly?: boolean;
}

export function startAccountJobsWorker(options: AccountJobsWorkerOptions): AccountJobsWorkerHandle {
  const { repo } = options;
  const crypto = options.crypto ?? safeLoadCrypto();
  const idlePollMs = options.idlePollMs ?? 5_000;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let running = 0;

  async function tryConsumeOne(): Promise<boolean> {
    const spec = repo.getAccountFleetSpec();
    const maxConcurrent = Math.max(1, spec.recovery.maxConcurrent);
    if (running >= maxConcurrent) return false;
    const job = repo.claimNextAccountJob();
    if (!job) return false;
    // 抢占式：再次检查后才标 running，避免重复消费
    running++;
    const startedAt = new Date();
    repo.updateAccountJob(job.id, {
      status: "running",
      startedAt: startedAt.toISOString(),
      attempt: job.attempt + 1
    });
    try {
      await executeJob(job, spec);
      repo.updateAccountJob(job.id, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime()
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知错误";
      repo.updateAccountJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        errorMessage: redactErrorMessage(message)
      });
      // 同步 account.recoveryAttempts / nextRecoveryAfter
      //
      // 例外：NoEgressAvailableError 是"基础设施暂时空"（节点池没可用节点），不是
      // 账号本身的问题。如果计入 recoveryAttempts，会因为节点池抖动把无辜账号烧掉，
      // 所以这里不更新 attempts —— 下个 tick 节点池恢复后会重新规划。
      const isInfraIssue = err instanceof NoEgressAvailableError;
      if (
        !isInfraIssue &&
        job.accountId &&
        (job.kind === "codex_login" || job.kind === "codex_register")
      ) {
        applyRecoveryFailure(repo, spec, job, message);
      }
    } finally {
      running--;
    }
    return true;
  }

  async function executeJob(job: AccountJob, spec: AccountFleetSpec): Promise<void> {
    switch (job.kind) {
      case "codex_login":
        return runCodexLogin(repo, crypto, spec, job);
      case "codex_register":
        return runCodexRegister(repo, crypto, spec, job);
      case "import_to_sub2api":
        return runImportToSub2api(repo, crypto, spec, job);
      case "delete_sub2api":
        return runDeleteSub2api(repo, spec, job);
      case "toggle_schedulable":
        return runToggleSchedulable(repo, spec, job);
      case "observe_usage":
        return runObserveUsage(repo, spec, job);
      default:
        throw new Error(`Unknown job kind: ${job.kind satisfies never}`);
    }
  }

  async function poll(): Promise<void> {
    try {
      // 尽量消化所有可消费的 job（直到没有 / 并发满）
      while (!stopped) {
        const consumed = await tryConsumeOne();
        if (!consumed) break;
      }
    } catch (err) {
      console.error("AccountJobsWorker poll loop error:", err);
    }
    if (stopped || options.manualOnly) return;
    pollTimer = setTimeout(poll, idlePollMs);
    pollTimer.unref?.();
  }

  if (!options.manualOnly) {
    void poll();
  }

  return {
    pump: async () => {
      while (true) {
        const consumed = await tryConsumeOne();
        if (!consumed) break;
      }
    },
    stop: () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
    }
  };
}

// ─── Job handlers ────────────────────────────────

/**
 * PATH_A: codex_login —— spawn codex-tool login → fresh tokens →
 *   POST /admin/openai/refresh-token → POST /admin/accounts → (可选) DELETE 旧
 *
 * Job payload: { accountId }
 * 成功后 account.intent='active' + origin 升级（adopted→recovered）+ encRefreshToken 更新
 *
 * 代理选择：优先尝试 account.egressNodeHash 对应的节点（软粘性）；
 * 不可用时按质量+负载加权随机回退。
 */
async function runCodexLogin(
  repo: HiveRepository,
  crypto: AccountCrypto,
  spec: AccountFleetSpec,
  job: AccountJob
): Promise<void> {
  const account = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  if (!account) throw new Error("account not found for codex_login");
  const phone = crypto.decryptOptional(account.encPhone);
  const password = crypto.decryptOptional(account.encPassword);
  if (!phone || !password) throw new Error("codex_login requires encPhone + encPassword");
  // 标 recovering
  repo.patchAccount(account.id, { intent: "recovering" });

  const egress = resolveEgressForLogin(repo, spec, account);
  const adapter = await buildCodexToolAdapter(repo, crypto, spec, egress);
  const outcome = await adapter.login({ phone, password, timeoutMs: spec.codexTool.timeouts.loginMs });
  // P5-AI: login 失败拿到分类信号 → 早期分流：
  //   account_unusable → 把账号直接 retire，不再消耗后续修复 quota
  //   network_or_proxy → 保留账号 + 标错误分类（worker 上层会根据 intent=recovering 继续退避）
  //   oauth_failed     → 跟旧行为一致，抛错由 handleRecoveryFailure 统一退避
  if (outcome.kind === "failed") {
    const category = outcome.classification.failureCategory ?? "oauth_failed";
    if (category === "account_unusable") {
      repo.patchAccount(account.id, {
        intent: "retired",
        health: "broken",
        lastRecoveryError: redactErrorMessage(outcome.error),
        lastRecoveryPath: "codex_login",
        lastRecoveryFailureCategory: "account_unusable"
      });
      throw new Error(`login failed [account_unusable]: ${outcome.error}`);
    }
    // network_or_proxy / oauth_failed → 把分类标到账号，让 handleRecoveryFailure 接管退避
    repo.patchAccount(account.id, { lastRecoveryFailureCategory: category });
    throw new Error(`login failed [${category}]: ${outcome.error}`);
  }
  await landOnSub2api({
    repo,
    crypto,
    spec,
    account,
    tokens: outcome.result.tokens,
    email: outcome.result.email,
    accountIdHint: outcome.result.accountId,
    isRecovery: true,
    egressNodeHash: egress?.hash ?? null
  });
}

/**
 * PATH_B: codex_register —— spawn codex-tool all → fresh account + token →
 *   refresh-token / createAccount → 老账号 retire（如果有 accountId）
 *
 * Job payload: { existingAccountId? } —— null 表示纯新增；非空表示替代某个废掉的
 */
async function runCodexRegister(
  repo: HiveRepository,
  crypto: AccountCrypto,
  spec: AccountFleetSpec,
  job: AccountJob
): Promise<void> {
  // 注册：按质量+负载加权随机选 egress，让新账号 IP 出生地自然分散
  const egress = resolveEgressForRegister(repo, spec);
  const adapter = await buildCodexToolAdapter(repo, crypto, spec, egress);
  const outcome = await adapter.registerOne({
    timeoutMs: spec.codexTool.timeouts.registerMs
  });
  const oldAccount = job.accountId ? repo.getAccountById(job.accountId) : undefined;

  // P5-AI: 不管成功失败，只要 codex-tool 返回了 sms_region_result 就回灌经验
  // （codex-tool 决定怎么用，Hive 透明保存）；并按实际花费记账，让月度成本预算有意义
  const persistSms = (sms: { result: unknown; costUsd: number | null }, country: string | null) => {
    if (sms.result != null) repo.saveSmsRegionHint(sms.result);
    const costCents = sms.costUsd != null ? Math.round(sms.costUsd * 100) : 0;
    incrementRegistrationsBudget(repo, spec, costCents);
    return { costCents: sms.costUsd != null ? costCents : null, country };
  };

  if (outcome.kind === "registration_failed") {
    // 接码失败一般不收费（cost=0），但仍把 attempts 经验保留下来给 codex-tool 下次参考
    persistSms(outcome.sms, outcome.sms.country);
    throw new Error(`registration failed: ${outcome.error}`);
  }
  if (outcome.kind === "oauth_failed") {
    const { costCents, country } = persistSms(outcome.recoverable.sms, outcome.recoverable.sms.country);
    // 按 OAuth 失败分类决定怎么落库（external-integration.md §"OAuth 失败分类"）：
    //   account_unusable → 直接 retired，不进恢复队列
    //   network_or_proxy → 进恢复队列但拉长延后，可能换代理后能救
    //   oauth_failed     → 普通恢复队列（旧行为）
    //   null（老版本 codex-tool）→ 兜底按 oauth_failed
    const category = outcome.recoverable.classification.failureCategory ?? "oauth_failed";
    const baseIntent = category === "account_unusable" ? "retired" : "recovering";
    const recoveryJson = JSON.stringify(outcome.recoverable.recoveryInput);
    const newRow: AccountRecordInternal = makeFreshAccount({
      email: `oauth-failed-${Date.now()}`,
      origin: "hive_registered",
      intent: baseIntent,
      health: "broken",
      encPhone: crypto.encryptOptional(outcome.recoverable.phone),
      encPassword: crypto.encryptOptional(outcome.recoverable.password),
      encRecoveryInputJson: crypto.encryptOptional(recoveryJson),
      batchId: outcome.recoverable.batchId,
      egressNodeHash: egress?.hash ?? null,
      smsCountry: country,
      smsCostCents: costCents,
      lastRecoveryError: redactErrorMessage(outcome.recoverable.error),
      lastRecoveryFailureCategory: category,
      // network_or_proxy 时取退避序列第二档（粗略给代理切换留余地，避免立刻撞同样问题）
      nextRecoveryAfter:
        category === "network_or_proxy"
          ? new Date(
              Date.now() + (spec.recovery.backoffSequenceMs[1] ?? spec.recovery.backoffSequenceMs[0] ?? 60_000)
            ).toISOString()
          : null
    });
    repo.upsertAccount(newRow);
    throw new Error(
      `oauth_failed[${category}]; recoverable account saved as ${newRow.id}: ${outcome.recoverable.error}`
    );
  }

  // token_ready
  const { costCents, country } = persistSms(outcome.account.sms, outcome.account.sms.country);
  await landOnSub2api({
    repo,
    crypto,
    spec,
    account: oldAccount,
    tokens: outcome.account.tokens,
    email: outcome.account.email,
    accountIdHint: outcome.account.tokens.accountId,
    phone: outcome.account.phone,
    password: outcome.account.password,
    batchId: outcome.account.batchId,
    isRecovery: Boolean(oldAccount),
    isFreshRegistration: !oldAccount,
    egressNodeHash: egress?.hash ?? null,
    smsCountry: country,
    smsCostCents: costCents
  });
}

/**
 * import_to_sub2api —— 试探导入：有 refresh_token 但未在 Sub2API 中。
 * 适用：收编工作台用户提供的 refresh_token 备份。
 *
 * payload: { refreshToken }
 * 成功 → 创建本地 hive_registered（或 adopted_recovered）+ Sub2API account
 * 失败 → 备份已死，标失败
 */
async function runImportToSub2api(
  repo: HiveRepository,
  crypto: AccountCrypto,
  _spec: AccountFleetSpec,
  job: AccountJob
): Promise<void> {
  const payload = JSON.parse(job.payloadJson) as { refreshToken: string; existingAccountId?: string };
  // import_to_sub2api 不调 codex-tool —— refresh-token 和 createAccount 都是 Sub2API
  // 服务端走自己的网络发 OpenAI 请求，本地节点根本没参与。所以这里不选 egress，
  // 也不回填 egressNodeHash —— 保持 null，让后续真正用 codex-tool 的 login/register
  // 第一次跑时再选 + 回填。
  // proxy_id 用代理编排 intake 作为 fallback（没 egress 节点信息）。
  const proxyId = resolveCreationProxyId(repo, null);
  const sub2api = requireSub2apiClient(repo);
  const refreshed = await sub2api.refreshOpenaiToken({
    refreshToken: payload.refreshToken,
    proxyId
  });
  const created = await sub2api.createAccount(
    makeCreatePayload({
      spec: _spec,
      proxyId,
      tokens: {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        idToken: refreshed.id_token
      },
      email: refreshed.email,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      expiresAt: refreshed.expires_at,
      name: synthesizeName(_spec, refreshed.email)
    })
  );

  const existing = payload.existingAccountId ? repo.getAccountById(payload.existingAccountId) : undefined;
  if (existing) {
    repo.patchAccount(existing.id, {
      externalId: created.id,
      origin: "adopted_recovered",
      intent: "active",
      health: "healthy",
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      recoveryAttempts: 0,
      nextRecoveryAfter: null,
      lastRecoveryError: null
      // 不写 egressNodeHash：本路径没用本地节点出口
    });
  } else {
    const fresh = makeFreshAccount({
      externalId: created.id,
      email: refreshed.email,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      origin: "adopted_recovered",
      intent: "active",
      health: "healthy",
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      egressNodeHash: null
    });
    repo.upsertAccount(fresh);
  }
}

async function runDeleteSub2api(repo: HiveRepository, _spec: AccountFleetSpec, job: AccountJob): Promise<void> {
  const account = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  if (!account || !account.externalId) throw new Error("delete_sub2api requires account with externalId");
  const sub2api = requireSub2apiClient(repo);
  await sub2api.deleteAccount(account.externalId);
  // 本地标 retired_legacy，保留审计
  repo.patchAccount(account.id, {
    origin: "retired_legacy",
    intent: "retired",
    externalId: null
  });
}

async function runToggleSchedulable(
  repo: HiveRepository,
  _spec: AccountFleetSpec,
  job: AccountJob
): Promise<void> {
  const account = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  if (!account || !account.externalId) throw new Error("toggle_schedulable requires account with externalId");
  const payload = JSON.parse(job.payloadJson) as { schedulable: boolean };
  const sub2api = requireSub2apiClient(repo);
  await sub2api.setAccountSchedulable(account.externalId, payload.schedulable);
}

async function runObserveUsage(repo: HiveRepository, _spec: AccountFleetSpec, job: AccountJob): Promise<void> {
  const account = job.accountId ? repo.getAccountById(job.accountId) : undefined;
  if (!account || !account.externalId) throw new Error("observe_usage requires account with externalId");
  const sub2api = requireSub2apiClient(repo);
  const usage = await sub2api.getAccountUsage(account.externalId);
  repo.patchAccount(account.id, {
    quota5hPercent: Math.round((usage.five_hour.utilization ?? 0) * 100),
    quota7dPercent: Math.round((usage.seven_day.utilization ?? 0) * 100),
    lastObservedAt: new Date().toISOString()
  });
}

// ─── 内部工具 ────────────────────────────────────

interface LandOnSub2apiInput {
  repo: HiveRepository;
  crypto: AccountCrypto;
  spec: AccountFleetSpec;
  account?: AccountRecordInternal | undefined;
  tokens: { idToken: string; accessToken: string; refreshToken: string };
  email: string;
  organizationId?: string | null | undefined;
  clientId?: string | null | undefined;
  accountIdHint?: string | null | undefined;
  phone?: string | undefined;
  password?: string | undefined;
  batchId?: string | undefined;
  isRecovery?: boolean | undefined;
  isFreshRegistration?: boolean | undefined;
  /** 本次 codex-tool 调用用了哪个本地节点作出口；落地账号时写入 egressNodeHash 作软粘性 */
  egressNodeHash?: string | null | undefined;
  /** P5-AI: codex-tool 注册返回的 sms_country；非注册路径（恢复登录 / import）为 null */
  smsCountry?: string | null | undefined;
  /** P5-AI: codex-tool 注册返回的 sms_cost_usd * 100；非注册路径为 null */
  smsCostCents?: number | null | undefined;
}

/**
 * 把 fresh tokens 灌进 Sub2API（refresh-token + createAccount），
 * 并更新本地 accounts 表（旧账号 origin=adopted_recovered 或新账号 hive_registered）。
 *
 * 若 spec.recovery.deleteOldAccountOnRecovery=true 且旧账号有 externalId →
 * 创建新 Sub2API record 成功后删除旧的。
 */
async function landOnSub2api(input: LandOnSub2apiInput): Promise<void> {
  const { repo, crypto, spec, account, tokens, email } = input;
  const sub2api = requireSub2apiClient(repo);
  // 1. 推导 Sub2API 端的 proxy_id ——
  //    优先用本次 codex-tool 实际走的节点对应的 Sub2API proxy_id（egress 节点必须先
  //    "启用调度"推到 Sub2API 才有此映射）。这样账号 IP 出生地跟 Sub2API 看到的
  //    binding 一致，省一次后续 reconcile 漂移。
  //    fallback：代理编排 Spec.intake.proxyId（如果配过 intake 兜底代理）。
  //    两者都没 → 抛错，让用户感知问题（而不是硬编码到某个不知名 proxy_id=1）。
  const proxyId = resolveCreationProxyId(repo, input.egressNodeHash ?? null);
  // 2. 灌 token 到 Sub2API → 拿标准化 token bundle（含 client_id / org_id / expires_at）
  const refreshed = await sub2api.refreshOpenaiToken({
    refreshToken: tokens.refreshToken,
    proxyId
  });
  // 3. POST /admin/accounts
  const name = synthesizeName(spec, email);
  const created = await sub2api.createAccount(
    makeCreatePayload({
      spec,
      proxyId,
      tokens: { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token, idToken: refreshed.id_token },
      email: refreshed.email,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      expiresAt: refreshed.expires_at,
      name
    })
  );
  // 3. 删除旧 Sub2API 记录（可选）
  let deletedOld = false;
  if (input.isRecovery && account?.externalId && spec.recovery.deleteOldAccountOnRecovery) {
    try {
      await sub2api.deleteAccount(account.externalId);
      deletedOld = true;
    } catch (err) {
      console.warn(`failed to delete old Sub2API account ${account.externalId}:`, err);
    }
  }
  // 4. 本地账号更新
  const now = new Date().toISOString();
  if (account) {
    repo.patchAccount(account.id, {
      externalId: created.id,
      origin: account.origin === "hive_registered" ? "hive_registered" : "adopted_recovered",
      intent: "active",
      health: "healthy",
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      encAccessToken: null, // 短期：不长期持有
      encIdToken: null,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      lastObservedAt: now,
      recoveryAttempts: 0,
      nextRecoveryAfter: null,
      lastRecoveryError: deletedOld ? null : account.lastRecoveryError,
      lastRecoveryPath: "codex_login",
      // 恢复成功后清掉上次失败分类（让 UI 不再显示旧的红色告警）
      lastRecoveryFailureCategory: null,
      // 仅在本次成功用过 egress 时回填；保留原值的 fallback：传 null 会覆盖，传 undefined 会跳过
      ...(input.egressNodeHash !== undefined ? { egressNodeHash: input.egressNodeHash } : {})
    });
  } else if (input.isFreshRegistration) {
    const fresh = makeFreshAccount({
      externalId: created.id,
      email: refreshed.email,
      organizationId: refreshed.organization_id,
      clientId: refreshed.client_id,
      origin: "hive_registered",
      intent: "active",
      health: "healthy",
      encPhone: input.phone ? crypto.encryptOptional(input.phone) : null,
      encPassword: input.password ? crypto.encryptOptional(input.password) : null,
      encRefreshToken: crypto.encryptOptional(refreshed.refresh_token),
      batchId: input.batchId ?? null,
      registeredAt: now,
      lastRecoveryPath: "codex_register",
      egressNodeHash: input.egressNodeHash ?? null,
      smsCountry: input.smsCountry ?? null,
      smsCostCents: input.smsCostCents ?? null
    });
    repo.upsertAccount(fresh);
  }
}

function makeCreatePayload(input: {
  spec: AccountFleetSpec;
  proxyId: number;
  tokens: { accessToken: string; refreshToken: string; idToken: string };
  email: string;
  organizationId: string;
  clientId: string;
  expiresAt: number;
  name: string;
}): Sub2ApiCreateAccountPayload {
  return {
    name: input.name,
    notes: input.spec.target.naming.notes,
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: input.tokens.accessToken,
      refresh_token: input.tokens.refreshToken,
      id_token: input.tokens.idToken,
      expires_at: input.expiresAt,
      client_id: input.clientId,
      email: input.email,
      organization_id: input.organizationId,
      model_mapping: {}
    },
    extra: { email: input.email },
    proxy_id: input.proxyId,
    concurrency: 10,
    priority: 1,
    rate_multiplier: 1,
    group_ids: input.spec.registration.autoAssignGroupIds,
    expires_at: null,
    auto_pause_on_expired: true
  };
}

/**
 * 推导 Sub2API 端 createAccount 用的 proxy_id。
 *
 * 优先级（高 → 低）：
 *   1. egress 节点对应的 Sub2API proxy_id（node.sub2apiProxyId）
 *      —— 账号编排走的本地代理跟新账号在 Sub2API 端的初始 binding 一致
 *   2. 代理编排 Spec.intake.proxyId （OrchestrationSpec 的 intake 配置）
 *      —— 用户在代理编排页配过的"新账号兜底入口"
 *   3. 都没有 → 抛错。**不再硬编码 default proxy_id**。
 *
 * 没有兜底是设计选择：用户必须有一个明确的"账号该绑哪个 proxy"的源头，
 * 要么是节点池里的健康节点（推过 Sub2API），要么是代理编排里手动选的 intake。
 * 不允许"凭空数字 id"——避免新账号被绑到一个用户压根不知道的代理上。
 */
function resolveCreationProxyId(repo: HiveRepository, egressNodeHash: string | null): number {
  if (egressNodeHash) {
    const node = repo.listNodes().find((n) => n.hash === egressNodeHash);
    if (node?.sub2apiProxyId) return node.sub2apiProxyId;
  }
  const orch = repo.getOrchestrationSpec();
  if (orch.intake.proxyId) return orch.intake.proxyId;
  throw new Error(
    "无法确定新账号 Sub2API proxy_id：" +
      "egress 节点未推到 Sub2API（先在节点池启用调度），且代理编排页 intake.proxyId 也未配置。"
  );
}

function makeFreshAccount(overrides: Partial<AccountRecordInternal>): AccountRecordInternal {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    externalId: null,
    origin: "hive_registered",
    intent: "active",
    health: "healthy",
    email: "unknown@local",
    organizationId: null,
    clientId: null,
    platform: "openai",
    type: "oauth",
    encPhone: null,
    encPassword: null,
    encRefreshToken: null,
    encAccessToken: null,
    encIdToken: null,
    encRecoveryInputJson: null,
    lastObservedAt: now,
    lastUsedAt: null,
    rateLimitedAt: null,
    rateLimitResetAt: null,
    quota5hPercent: null,
    quota7dPercent: null,
    errorsInWindow: 0,
    brokenSinceTick: null,
    brokenConsecutiveTicks: 0,
    recoveryAttempts: 0,
    nextRecoveryAfter: null,
    lastRecoveryError: null,
    lastRecoveryPath: null,
    lastRecoveryFailureCategory: null,
    batchId: null,
    registeredAt: null,
    smsCountry: null,
    smsCostCents: null,
    egressNodeHash: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function synthesizeName(spec: AccountFleetSpec, email: string): string {
  const tmpl = spec.target.naming.template;
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, ""); // YYMMDD
  const seqRand = Math.random().toString(36).slice(2, 6);
  return tmpl
    .replace("{date}", date)
    .replace("{seq}", seqRand)
    .replace("{email}", email);
}

function applyRecoveryFailure(
  repo: HiveRepository,
  spec: AccountFleetSpec,
  job: AccountJob,
  message: string
): void {
  if (!job.accountId) return;
  const account = repo.getAccountById(job.accountId);
  if (!account) return;
  const attempts = account.recoveryAttempts + 1;
  const backoffIdx = Math.min(attempts - 1, spec.recovery.backoffSequenceMs.length - 1);
  const backoffMs = spec.recovery.backoffSequenceMs[backoffIdx] ?? 60_000;
  repo.patchAccount(account.id, {
    recoveryAttempts: attempts,
    nextRecoveryAfter: new Date(Date.now() + backoffMs).toISOString(),
    lastRecoveryError: redactErrorMessage(message),
    lastRecoveryPath: job.kind === "codex_login" ? "codex_login" : "codex_register",
    intent: attempts >= spec.recovery.maxAttemptsPerAccount ? "retired" : "recovering"
  });
}

function incrementRegistrationsBudget(
  repo: HiveRepository,
  spec: AccountFleetSpec,
  deltaSmsCostCents = 0
): void {
  const now = new Date();
  const dayKey = budgetWindowKey(now, "day");
  const monthKey = budgetWindowKey(now, "month");
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const monthAfter = new Date(now);
  monthAfter.setUTCMonth(monthAfter.getUTCMonth() + 1);
  monthAfter.setUTCDate(1);
  monthAfter.setUTCHours(0, 0, 0, 0);
  repo.incrementBudgetUsage({
    windowKey: dayKey,
    registrationsBudget: spec.registration.dailyBudget,
    resetAt: tomorrow.toISOString(),
    deltaRegistrations: 1,
    deltaSmsCostCents
  });
  repo.incrementBudgetUsage({
    windowKey: monthKey,
    registrationsBudget: spec.registration.monthlyBudget,
    resetAt: monthAfter.toISOString(),
    deltaRegistrations: 1,
    deltaSmsCostCents
  });
}

export async function buildCodexToolAdapter(
  repo: HiveRepository,
  crypto: AccountCrypto,
  spec: AccountFleetSpec,
  /**
   * 由调用方（register / login / import handler）按场景选好的 egress；null 表示
   * 调用方不需要走出口（如 codex sms countries 之类纯查询，但当前实现总传 egress）。
   */
  egress: EgressSelection | null
): Promise<CodexToolAdapter> {
  const skymailPassword = spec.codexTool.skymail.adminPasswordRef
    ? crypto.decrypt(spec.codexTool.skymail.adminPasswordRef)
    : "";
  const smsApiKey = spec.codexTool.phoneSms.apiKeyRef
    ? crypto.decrypt(spec.codexTool.phoneSms.apiKeyRef)
    : "";
  const proxyDefault = egress ? `socks5://127.0.0.1:${egress.port}` : resolveLegacyEgressProxyUrl(repo, spec);
  // P5-AI: 透明回灌 region_hint —— 上次注册成功的 sms_region_result blob 原样塞给
  // codex-tool 让它优先尝试该地区，Hive 不解析 blob 字段。第一次跑时没有，为 null。
  const hintMemory = repo.getSmsRegionHint();
  const config: CodexToolConfig = {
    binPath: spec.codexTool.binPath,
    skymail: {
      baseUrl: spec.codexTool.skymail.baseUrl,
      adminEmail: spec.codexTool.skymail.adminEmail,
      adminPassword: skymailPassword
    },
    chatgpt: {
      mailDomain: spec.codexTool.chatgpt.mailDomain,
      chatWebClientId: spec.codexTool.chatgpt.chatWebClientId,
      codexClientId: spec.codexTool.chatgpt.codexClientId
    },
    phoneSms: {
      provider: spec.codexTool.phoneSms.provider,
      apiKey: smsApiKey,
      service: spec.codexTool.phoneSms.service,
      maxCostPerAccountUsd: spec.registration.maxCostPerAccountUsd,
      ...(hintMemory?.hint != null ? { regionHint: hintMemory.hint } : {})
    },
    httpUserAgentChrome: spec.codexTool.httpUserAgentChrome,
    proxyDefault
  };
  return createCodexToolAdapter({
    config,
    defaults: {
      smsCountriesMs: spec.codexTool.timeouts.smsCountriesMs,
      loginMs: spec.codexTool.timeouts.loginMs,
      registerMs: spec.codexTool.timeouts.registerMs
    }
  });
}

/**
 * 在 spec.codexTool.egress.mode === 'pinned-node' / 'none' 时兜底走的旧选择逻辑。
 *
 * managed-node 模式现在已被 register/login handler 显式调用 selectEgressForRegister
 * / selectEgressForLogin 取代，所以这里只处理 pinned / none 两种简单 mode；
 * 走到 managed-node 分支说明调用方没主动选 egress，保留原"取第一个候选"行为。
 */
function resolveLegacyEgressProxyUrl(repo: HiveRepository, spec: AccountFleetSpec): string {
  const mode = spec.codexTool.egress.mode;
  if (mode === "none") return "";
  if (mode === "pinned-node" && spec.codexTool.egress.pinnedNodeHash) {
    const node = repo.listNodes().find((n) => n.hash === spec.codexTool.egress.pinnedNodeHash);
    if (!node?.assignedPort) {
      throw new Error(
        `egress pinned node ${spec.codexTool.egress.pinnedNodeHash} not found or has no assigned port`
      );
    }
    return `socks5://127.0.0.1:${node.assignedPort}`;
  }
  // 兜底：第一个可用节点（保守，跟 P4 旧行为兼容）
  const candidates: ProxyNode[] = repo
    .listNodes()
    .filter((n) => n.schedulable && n.status === "active" && n.assignedPort);
  const pick = candidates[0];
  if (!pick?.assignedPort) {
    throw new Error("no healthy + schedulable + ported node available for egress");
  }
  return `socks5://127.0.0.1:${pick.assignedPort}`;
}

/**
 * 注册（codex_register / import_to_sub2api）—— 按质量+负载加权随机。
 *
 * pinned-node mode 仍优先；none mode 返回 null（adapter 接受 null=不走代理）。
 */
function resolveEgressForRegister(repo: HiveRepository, spec: AccountFleetSpec): EgressSelection | null {
  if (spec.codexTool.egress.mode === "none") return null;
  if (spec.codexTool.egress.mode === "pinned-node" && spec.codexTool.egress.pinnedNodeHash) {
    const node = repo.listNodes().find((n) => n.hash === spec.codexTool.egress.pinnedNodeHash);
    if (!node?.assignedPort) {
      throw new NoEgressAvailableError(
        `pinned egress node ${spec.codexTool.egress.pinnedNodeHash} not found / no assigned port`
      );
    }
    return { hash: node.hash, port: node.assignedPort, reason: "preferred" };
  }
  // managed-node 默认路径
  const nodes = repo.listNodes();
  const loads = buildEgressLoadMap(repo.listAccounts());
  return selectEgressForRegister({ nodes, egressLoadByNodeHash: loads });
}

/**
 * 登录（codex_login）—— 优先 account.egressNodeHash 软粘性，
 * 不可用则等同 resolveEgressForRegister。
 */
function resolveEgressForLogin(
  repo: HiveRepository,
  spec: AccountFleetSpec,
  account: AccountRecordInternal
): EgressSelection | null {
  if (spec.codexTool.egress.mode === "none") return null;
  if (spec.codexTool.egress.mode === "pinned-node" && spec.codexTool.egress.pinnedNodeHash) {
    return resolveEgressForRegister(repo, spec);
  }
  const nodes = repo.listNodes();
  const loads = buildEgressLoadMap(repo.listAccounts());
  return selectEgressForLogin({
    nodes,
    egressLoadByNodeHash: loads,
    preferredHash: account.egressNodeHash
  });
}

function requireSub2apiClient(repo: HiveRepository): Sub2ApiClient {
  const conn = repo.getSub2ApiConnection();
  if (!conn) throw new Error("Sub2API connection not configured");
  return createSub2ApiClient(conn);
}

export function safeLoadCrypto(): AccountCrypto {
  try {
    return loadAccountCrypto();
  } catch (err) {
    // 软失败：worker 启动时不阻塞 server 上线；任何需要 crypto 的 job 失败时会自然报错
    console.warn("AccountJobsWorker: failed to load crypto; jobs requiring secrets will fail:", err);
    // 返回一个永远失败的 crypto 占位
    return {
      encrypt: () => {
        throw err instanceof Error ? err : new Error(String(err));
      },
      decrypt: () => {
        throw err instanceof Error ? err : new Error(String(err));
      },
      encryptOptional: () => {
        throw err instanceof Error ? err : new Error(String(err));
      },
      decryptOptional: (v) => {
        if (v === null || v === undefined) return null;
        throw err instanceof Error ? err : new Error(String(err));
      }
    };
  }
}

/** 简单 redact：把 token / refresh_token / 长 JWT / 手机号替成 `***`。 */
function redactErrorMessage(message: string): string {
  return message
    .replace(/eyJ[A-Za-z0-9._-]{40,}/g, "***JWT***")
    .replace(/rt_[A-Za-z0-9._-]{30,}/g, "***RT***")
    .replace(/\+\d{7,15}/g, "***PHONE***");
}
