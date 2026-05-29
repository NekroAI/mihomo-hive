/**
 * codex-tool adapter —— spawn private binary, pipe config JSON via stdin,
 * parse JSON envelope from stdout. **绝对不会把 stdout 写到日志或磁盘**——
 * stdout 含完整 OAuth token，解析后即刻 GC。
 *
 * 设计依据：
 *   - codex-tool docs: /Users/miose/Projects/codex-create/docs/external-integration.md
 *                      /Users/miose/Projects/codex-create/docs/cli-contract.md
 *   - Hive 设计文档: notes/account-fleet-design.md §9.2
 *
 * 三个核心命令：
 *   - smsCountries()  → `codex-tool sms countries --json` （查接码地区）
 *   - login()         → `codex-tool login --stateless --json --no-color --reveal-secrets
 *                          --config-json-stdin --phone X --password Y`
 *   - registerOne()   → `codex-tool all --count 1 --stateless --json --no-color
 *                          --reveal-secrets --config-json-stdin`
 *
 * 退出码契约（cli-contract.md §"退出码"）：
 *   0 = ok / 1 = general / 2 = arg / 3 = external service / 4 = verification / 5 = fs
 */

import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

// ─── 配置 ────────────────────────────────────────

export interface CodexToolConfig {
  /** 二进制路径；默认走 PATH 找 "codex-tool"。 */
  binPath: string;
  /** SkyMail 配置（必填，登录流程依赖邮箱 OTP）。 */
  skymail: { baseUrl: string; adminEmail: string; adminPassword: string };
  /** ChatGPT OAuth 配置（client_id 等）。 */
  chatgpt: { mailDomain: string; chatWebClientId: string; codexClientId: string };
  /** 接码平台配置。地区由 codex-tool 按 maxCostPerAccountUsd 自行选择，Hive 不传 country。 */
  phoneSms: {
    provider: "herosms" | "fivesim" | "nexsms";
    apiKey: string;
    service: string;
    /**
     * 单账号注册成本上限（USD）。codex-tool 据此筛选可用地区，超过这个价格的地区
     * 直接跳过。**未设置就发起注册** 是配置错误，codex-tool 应拒绝执行。
     * 详细约定见 mihomo-hive 仓库的 notes/codex-tool-needs.md。
     */
    maxCostPerAccountUsd: number;
    /**
     * 跨调用地区经验回灌（external-integration.md §"成本上限和选区策略"）。
     *
     * Hive 保持透明：原样从上一次注册的 sms_region_result 拿到的 blob 直接塞进来，
     * codex-tool 自己决定 TTL / 失败惩罚 / 黑名单。Hive 永远不解析其字段语义，
     * 只在 UI 上作为观测数据展示。null 表示无历史经验，codex-tool 走价格升序探索。
     */
    regionHint?: unknown;
  };
  httpUserAgentChrome: string;
  /** 出口代理 URL（e.g. "socks5://127.0.0.1:10001"），codex-tool 通过它访问外部服务。 */
  proxyDefault: string;
}

/**
 * Build the JSON payload that gets piped into codex-tool stdin.
 *
 * Field naming follows codex-tool's config schema exactly
 * (see external-integration.md §"配置 JSON"). 不要在这里改字段名，
 * 出错会让 codex-tool 拒识。
 */
export function buildCodexToolConfigJson(config: CodexToolConfig): Record<string, unknown> {
  const phoneSmsKey =
    config.phoneSms.provider === "herosms"
      ? "herosms_api_key"
      : config.phoneSms.provider === "fivesim"
        ? "fivesim_api_key"
        : "nexsms_api_key";
  return {
    skymail: {
      base_url: config.skymail.baseUrl,
      admin_email: config.skymail.adminEmail,
      admin_password: config.skymail.adminPassword
    },
    chatgpt: {
      mail_domain: config.chatgpt.mailDomain,
      chat_web_client_id: config.chatgpt.chatWebClientId,
      codex_client_id: config.chatgpt.codexClientId
    },
    phone_sms: {
      provider: config.phoneSms.provider,
      [phoneSmsKey]: config.phoneSms.apiKey,
      service: config.phoneSms.service,
      max_cost_per_account_usd: config.phoneSms.maxCostPerAccountUsd,
      // 透明回灌：上次 sms_region_result 的整个 object 原样塞，codex-tool 自己解释
      ...(config.phoneSms.regionHint !== undefined && config.phoneSms.regionHint !== null
        ? { region_hint: config.phoneSms.regionHint }
        : {})
    },
    http: {
      user_agent_chrome: config.httpUserAgentChrome
    },
    proxy: {
      default: config.proxyDefault
    }
  };
}

// ─── 错误类型 ────────────────────────────────────

export type CodexToolErrorKind =
  | "bin_not_found"
  | "spawn_failed"
  | "timeout"
  | "argument_error" // exit 2
  | "external_service" // exit 3
  | "verification" // exit 4
  | "fs_error" // exit 5
  | "general_error" // exit 1
  | "envelope_invalid"
  | "envelope_not_ok";

export class CodexToolError extends Error {
  constructor(
    message: string,
    public readonly kind: CodexToolErrorKind,
    public readonly exitCode?: number
  ) {
    super(message);
    this.name = "CodexToolError";
  }
}

function mapExitCodeToErrorKind(code: number): CodexToolErrorKind {
  switch (code) {
    case 0:
      return "general_error"; // never reached if ok
    case 2:
      return "argument_error";
    case 3:
      return "external_service";
    case 4:
      return "verification";
    case 5:
      return "fs_error";
    default:
      return "general_error";
  }
}

// ─── Envelope + 返回类型 ─────────────────────────

export interface CodexToolEnvelope {
  ok: boolean;
  command: string;
  run_id: number | null;
  data: unknown;
  error: string | null;
  warnings: string[];
  paths: Record<string, string | null>;
}

export interface SmsCountry {
  country: string;
  countryName: string;
  price: number;
  total: number;
  physical: number;
  virtual: number;
  recommended: boolean;
  importantFlags: string[];
}

export interface CodexToolTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
}

/**
 * codex-tool 返回的 OAuth 失败分类（external-integration.md §"OAuth 失败分类"）。
 * Hive 按此分流：
 *   - account_unusable → 不重试，账号入 retired
 *   - network_or_proxy → 延后重试，优先检查代理/出口
 *   - oauth_failed     → 普通恢复登录队列
 */
export type CodexFailureCategory = "account_unusable" | "network_or_proxy" | "oauth_failed";

export interface CodexFailureClassification {
  failureCategory: CodexFailureCategory | null;
  retryable: boolean | null;
  recommendedAction: string | null;
  reason: string | null;
}

/**
 * 短信地区返回数据（external-integration.md §"成本上限和选区策略"）。
 * 这部分 Hive 完全透明保存——不解析 country/operator/price 等字段语义，
 * 仅在 UI 上观测、在下一次注册时把 smsRegionResult 作为 hint 原样回传。
 */
export interface CodexSmsRegionResult {
  /** 透明 blob：原样从 envelope.data.sms_region_result 取，结构由 codex-tool 决定。 */
  result: unknown;
  /** 本轮地区尝试明细 list，原样保留供审计。 */
  attempts: unknown[];
  /** 注册实际花了多少美元；落 account_budgets.sms_cost_cents 用。 */
  costUsd: number | null;
  /** 注册成功用的国家码，落 accounts.sms_country 用（用户能看到的简单字段）。 */
  country: string | null;
}

export interface CodexToolLoginResult {
  phone: string;
  email: string;
  accountId: string | null;
  tokens: CodexToolTokens;
}

/**
 * login 命令的返回 union：成功取到新 tokens 或带分类的失败。
 * 旧版本调用方拿到 failure 时一律重试；新版本可以按 failureCategory 分流：
 *   - account_unusable → 不重试，账号 retired
 *   - network_or_proxy → 延后重试
 *   - oauth_failed     → 正常退避重试
 */
export type CodexToolLoginOutcome =
  | { kind: "ok"; result: CodexToolLoginResult }
  | {
      kind: "failed";
      error: string;
      classification: CodexFailureClassification;
    };

export type CodexToolRegisterOutcome =
  | {
      kind: "token_ready";
      account: {
        phone: string;
        password: string;
        email: string;
        batchId: string;
        tokens: CodexToolTokens;
        /** 本次注册的短信地区数据（用于观测 + 回灌 + 账单）。 */
        sms: CodexSmsRegionResult;
      };
    }
  | {
      kind: "oauth_failed";
      recoverable: {
        phone: string;
        password: string;
        batchId: string;
        error: string;
        recoveryInput: unknown;
        /** OAuth 失败已扣短信成本，仍要入账。 */
        sms: CodexSmsRegionResult;
        classification: CodexFailureClassification;
      };
    }
  | {
      kind: "registration_failed";
      error: string;
      /**
       * 注册阶段失败时通常没有可保存账号，但 codex-tool 可能仍在 sms_region_attempts 里
       * 留有"试了哪些地区花了多少钱"用于审计；sms_cost_usd 一般为 0（取号失败不收费）。
       */
      sms: CodexSmsRegionResult;
      classification: CodexFailureClassification;
    };

// ─── Spawner / Adapter 接口 ──────────────────────

export interface CodexToolSpawnRequest {
  args: string[];
  stdinJson: string | null;
  timeoutMs: number;
  /**
   * P5-AT：实时 stderr 行回调（codex-tool 进度日志走 stderr，stdout 留给 JSON
   * 信封 / token）。**绝不回调 stdout**。调用方负责 redact 后再落地。
   */
  onStderr?: (line: string) => void;
}

export interface CodexToolSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
}

export type CodexToolSpawner = (input: CodexToolSpawnRequest) => Promise<CodexToolSpawnResult>;

export interface CodexToolAdapter {
  smsCountries(options?: {
    limit?: number;
    countries?: string;
    timeoutMs?: number;
  }): Promise<{ countries: SmsCountry[]; total: number; provider: string; service: string }>;

  login(input: {
    phone: string;
    password: string;
    timeoutMs?: number;
    /** P5-AT：codex-tool stderr 进度行回调（实时日志）。 */
    onLog?: (line: string) => void;
  }): Promise<CodexToolLoginOutcome>;

  registerOne(input?: {
    timeoutMs?: number;
    onLog?: (line: string) => void;
  }): Promise<CodexToolRegisterOutcome>;
}

// ─── 实现 ────────────────────────────────────────

interface CreateAdapterOptions {
  config: CodexToolConfig;
  defaults: {
    smsCountriesMs: number;
    loginMs: number;
    registerMs: number;
  };
  /** 测试时可传 mock spawner；默认用 real child_process.spawn 包装。 */
  spawner?: CodexToolSpawner;
}

export function createCodexToolAdapter(opts: CreateAdapterOptions): CodexToolAdapter {
  const spawner = opts.spawner ?? createDefaultSpawner(opts.config.binPath);
  const configJson = JSON.stringify(buildCodexToolConfigJson(opts.config));

  /**
   * @param lenient 默认 false：ok=false 直接抛 envelope_not_ok。如果调用方（如
   *   login）需要从失败 envelope 里读 failure_category 字段做分类处理，传 true
   *   只让 exit code 非 0 抛错，ok=false 但 exit=0 返回让调用方解释。
   */
  async function runEnvelope(
    args: string[],
    timeoutMs: number,
    withStdin: boolean,
    lenient = false,
    onStderr?: (line: string) => void
  ): Promise<CodexToolEnvelope> {
    const res = await spawner({
      args,
      stdinJson: withStdin ? configJson : null,
      timeoutMs,
      ...(onStderr ? { onStderr } : {})
    });
    if (res.timedOut) {
      throw new CodexToolError(
        `codex-tool timed out after ${timeoutMs}ms (signal=${res.signal ?? "none"})`,
        "timeout"
      );
    }
    if (res.exitCode === null) {
      throw new CodexToolError(
        `codex-tool exited without code (signal=${res.signal ?? "none"})`,
        "spawn_failed"
      );
    }
    const envelope = parseEnvelope(res.stdout);
    if (res.exitCode !== 0) {
      const kind = mapExitCodeToErrorKind(res.exitCode);
      throw new CodexToolError(
        envelope.error ?? `codex-tool exit ${res.exitCode}: ${truncate(res.stderr, 500)}`,
        kind,
        res.exitCode
      );
    }
    if (!envelope.ok && !lenient) {
      throw new CodexToolError(
        envelope.error ?? `codex-tool returned ok=false (exit 0)`,
        "envelope_not_ok"
      );
    }
    return envelope;
  }

  return {
    async smsCountries(options = {}) {
      const args = ["sms", "countries", "--json", "--no-color", "--config-json-stdin"];
      if (typeof options.limit === "number") {
        args.push("--limit", String(options.limit));
      }
      if (options.countries) {
        args.push("--countries", options.countries);
      }
      const timeoutMs = options.timeoutMs ?? opts.defaults.smsCountriesMs;
      const env = await runEnvelope(args, timeoutMs, true);
      const data = (env.data ?? {}) as Record<string, unknown>;
      const rawCountries = Array.isArray(data.countries) ? (data.countries as Array<Record<string, unknown>>) : [];
      return {
        countries: rawCountries.map((row) => ({
          country: String(row.country ?? ""),
          countryName: String(row.country_name ?? ""),
          price: typeof row.price === "number" ? row.price : Number(row.price ?? 0) || 0,
          total: typeof row.total === "number" ? row.total : Number(row.total ?? 0) || 0,
          physical: typeof row.physical === "number" ? row.physical : Number(row.physical ?? 0) || 0,
          virtual: typeof row.virtual === "number" ? row.virtual : Number(row.virtual ?? 0) || 0,
          recommended: Boolean(row.recommended),
          importantFlags: Array.isArray(row.important_flags)
            ? (row.important_flags as unknown[]).map((x) => String(x))
            : []
        })),
        total: typeof data.total === "number" ? data.total : 0,
        provider: String(data.provider ?? "herosms"),
        service: String(data.service ?? "")
      };
    },

    async login(input) {
      const args = [
        "login",
        "--stateless",
        "--json",
        "--no-color",
        "--reveal-secrets",
        "--config-json-stdin",
        "--phone",
        input.phone,
        "--password",
        input.password
      ];
      const timeoutMs = input.timeoutMs ?? opts.defaults.loginMs;
      // lenient：ok=false 不抛错，调用方能从 data 里读 failure_category 做分流
      const env = await runEnvelope(args, timeoutMs, true, true, input.onLog);
      if (!env.ok) {
        const data = isObject(env.data) ? (env.data as Record<string, unknown>) : {};
        return {
          kind: "failed",
          error: env.error ?? "login failed (no error message)",
          classification: extractFailureClassification(data)
        };
      }
      return { kind: "ok", result: parseLoginEnvelope(env) };
    },

    async registerOne(input = {}) {
      const args = [
        "all",
        "--count",
        "1",
        "--stateless",
        "--json",
        "--no-color",
        "--reveal-secrets",
        "--config-json-stdin"
      ];
      const timeoutMs = input.timeoutMs ?? opts.defaults.registerMs;
      const env = await runEnvelope(args, timeoutMs, true, false, input.onLog);
      return parseRegisterEnvelope(env);
    }
  };
}

// ─── parse helpers ───────────────────────────────

export function parseEnvelope(stdout: string): CodexToolEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new CodexToolError(
      `Failed to parse JSON envelope: ${(cause as Error).message}; first 200 chars: ${truncate(stdout, 200)}`,
      "envelope_invalid"
    );
  }
  if (!isObject(parsed)) {
    throw new CodexToolError("Envelope is not an object", "envelope_invalid");
  }
  if (typeof parsed.ok !== "boolean") {
    throw new CodexToolError("Envelope missing 'ok' boolean", "envelope_invalid");
  }
  return {
    ok: parsed.ok,
    command: String(parsed.command ?? ""),
    run_id: typeof parsed.run_id === "number" ? parsed.run_id : null,
    data: "data" in parsed ? parsed.data : null,
    error: typeof parsed.error === "string" ? parsed.error : null,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
    paths: isObject(parsed.paths) ? (parsed.paths as Record<string, string | null>) : {}
  };
}

function parseLoginEnvelope(env: CodexToolEnvelope): CodexToolLoginResult {
  const data = env.data;
  if (!isObject(data)) {
    throw new CodexToolError("login envelope missing data", "envelope_invalid");
  }
  // login envelope 顶层结构（cli-contract.md §"恢复登录命令"）：
  //   data: { phone, email, account_id, status, token: {tokens: {...}, _email, last_refresh} }
  const phone = stringOrThrow(data.phone, "data.phone");
  const email = stringOrThrow(data.email, "data.email");
  const accountId = typeof data.account_id === "string" && data.account_id ? data.account_id : null;
  const token = isObject(data.token) ? (data.token as Record<string, unknown>) : null;
  const tokens = token && isObject(token.tokens) ? (token.tokens as Record<string, unknown>) : null;
  if (!tokens) {
    throw new CodexToolError("login envelope missing data.token.tokens", "envelope_invalid");
  }
  return {
    phone,
    email,
    accountId,
    tokens: {
      idToken: stringOrThrow(tokens.id_token, "tokens.id_token"),
      accessToken: stringOrThrow(tokens.access_token, "tokens.access_token"),
      refreshToken: stringOrThrow(tokens.refresh_token, "tokens.refresh_token"),
      accountId: typeof tokens.account_id === "string" ? tokens.account_id : null
    }
  };
}

/**
 * 从单个 account / recoverable 条目里抽 sms 数据（external-integration.md
 * §"成本上限和选区策略"）。codex-tool 把 sms_region_result / sms_region_attempts /
 * sms_cost_usd / sms_country 都挂在条目内层；老版本可能没这些字段，全部 null-safe。
 */
function extractSmsResult(item: Record<string, unknown>): CodexSmsRegionResult {
  const attempts = Array.isArray(item.sms_region_attempts)
    ? (item.sms_region_attempts as unknown[])
    : [];
  const result = item.sms_region_result !== undefined ? item.sms_region_result : null;
  const costUsd =
    typeof item.sms_cost_usd === "number"
      ? item.sms_cost_usd
      : typeof item.sms_cost_usd === "string"
        ? Number(item.sms_cost_usd) || null
        : null;
  const country = typeof item.sms_country === "string" ? item.sms_country : null;
  return { result, attempts, costUsd, country };
}

/**
 * 抽 OAuth 失败分类字段（external-integration.md §"OAuth 失败分类"）。老版本
 * codex-tool 不带这几个字段，全部 null-safe。Hive 拿到 null 时会保守按
 * "oauth_failed" 分支处理（兼容旧版本不引入回归）。
 */
function extractFailureClassification(item: Record<string, unknown>): CodexFailureClassification {
  const cat = item.failure_category;
  const failureCategory: CodexFailureCategory | null =
    cat === "account_unusable" || cat === "network_or_proxy" || cat === "oauth_failed" ? cat : null;
  return {
    failureCategory,
    retryable: typeof item.retryable === "boolean" ? item.retryable : null,
    recommendedAction: typeof item.recommended_action === "string" ? item.recommended_action : null,
    reason: typeof item.reason === "string" ? item.reason : null
  };
}

/** 空 sms 占位 —— 当条目里没有任何 sms 字段或者没匹配到具体条目时返回。 */
const EMPTY_SMS: CodexSmsRegionResult = { result: null, attempts: [], costUsd: null, country: null };

function parseRegisterEnvelope(env: CodexToolEnvelope): CodexToolRegisterOutcome {
  const data = env.data;
  if (!isObject(data)) {
    throw new CodexToolError("register envelope missing data", "envelope_invalid");
  }
  // all envelope 结构（external-integration.md §"注册并登录" / §"登录失败恢复"）:
  //   data: { accounts: [...], recoverable_accounts: [...], registration_failures: [...], summary: {...} }
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const tokenReady = accounts.find((a) => isObject(a) && (a as Record<string, unknown>).status === "token_ready");
  if (tokenReady && isObject(tokenReady)) {
    const acc = tokenReady as Record<string, unknown>;
    const token = isObject(acc.token) ? (acc.token as Record<string, unknown>) : null;
    const tokens = token && isObject(token.tokens) ? (token.tokens as Record<string, unknown>) : null;
    if (!tokens) {
      throw new CodexToolError("register envelope account missing token.tokens", "envelope_invalid");
    }
    return {
      kind: "token_ready",
      account: {
        phone: stringOrThrow(acc.phone, "account.phone"),
        password: stringOrThrow(acc.password, "account.password"),
        email: stringOrThrow(acc.email, "account.email"),
        batchId: stringOrThrow(acc.batch_id, "account.batch_id"),
        tokens: {
          idToken: stringOrThrow(tokens.id_token, "tokens.id_token"),
          accessToken: stringOrThrow(tokens.access_token, "tokens.access_token"),
          refreshToken: stringOrThrow(tokens.refresh_token, "tokens.refresh_token"),
          accountId: typeof tokens.account_id === "string" ? tokens.account_id : null
        },
        sms: extractSmsResult(acc)
      }
    };
  }
  const recoverable = Array.isArray(data.recoverable_accounts) ? data.recoverable_accounts : [];
  const oauthFailed = recoverable.find((r) => isObject(r) && (r as Record<string, unknown>).phone);
  if (oauthFailed && isObject(oauthFailed)) {
    const rec = oauthFailed as Record<string, unknown>;
    return {
      kind: "oauth_failed",
      recoverable: {
        phone: stringOrThrow(rec.phone, "recoverable.phone"),
        password: stringOrThrow(rec.password, "recoverable.password"),
        batchId: stringOrThrow(rec.batch_id, "recoverable.batch_id"),
        error: typeof rec.error === "string" ? rec.error : "oauth failed",
        recoveryInput: rec.recovery_input ?? null,
        sms: extractSmsResult(rec),
        classification: extractFailureClassification(rec)
      }
    };
  }
  const failures = Array.isArray(data.registration_failures) ? data.registration_failures : [];
  const failure = failures.find((f) => isObject(f));
  const failObj = failure && isObject(failure) ? (failure as Record<string, unknown>) : null;
  return {
    kind: "registration_failed",
    error:
      failObj && typeof failObj.error === "string"
        ? failObj.error
        : "registration failed (no detail)",
    sms: failObj ? extractSmsResult(failObj) : EMPTY_SMS,
    classification: failObj ? extractFailureClassification(failObj) : {
      failureCategory: null,
      retryable: null,
      recommendedAction: null,
      reason: null
    }
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringOrThrow(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new CodexToolError(`Envelope field ${field} missing or not a non-empty string`, "envelope_invalid");
  }
  return v;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…(${s.length}B total)`;
}

// ─── 默认 spawner（封装 child_process.spawn）───

/**
 * 构造 codex-tool 子进程的 env —— PATH + HOME + 非敏感运行时白名单。
 * 绝不透传 Hive 的密钥类 env（HIVE_ACCOUNT_KEY 等），避免泄漏给子进程。
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? ""
  };
  for (const key of ["PLAYWRIGHT_BROWSERS_PATH", "TZ", "LANG", "LC_ALL"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return env;
}

function createDefaultSpawner(binPath: string): CodexToolSpawner {
  return async ({ args, stdinJson, timeoutMs, onStderr }) => {
    return new Promise<CodexToolSpawnResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = defaultSpawn(binPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
          // 子进程 env 隔离：默认不继承 Hive 全量 env（避免泄漏 HIVE_ACCOUNT_KEY 等密钥）。
          // 但 codex-tool 自身运行时需要少量非敏感 env，用白名单透传：
          //   PLAYWRIGHT_BROWSERS_PATH —— 指向挂载进容器的 chromium。不传的话 codex-tool 的
          //     playwright 会找默认 $HOME/.cache/ms-playwright（容器内 /root/.cache，无浏览器）
          //     → "Executable doesn't exist / playwright install"。
          //   TZ / LANG / LC_ALL —— 时区与本地化，影响日志和部分解析，非敏感。
          env: buildChildEnv()
        });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new CodexToolError(`codex-tool binary not found at ${binPath}`, "bin_not_found"));
        } else {
          reject(new CodexToolError(`Failed to spawn codex-tool: ${(cause as Error).message}`, "spawn_failed"));
        }
        return;
      }
      let stdout = "";
      let stderr = "";
      let stderrPending = ""; // 按行切分缓冲，给 onStderr 实时回调
      let timedOut = false;

      const stdoutStream = child.stdout as Readable | null;
      const stderrStream = child.stderr as Readable | null;
      const stdinStream = child.stdin as Writable | null;

      stdoutStream?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stderrStream?.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        stderr += s;
        if (onStderr) {
          stderrPending += s;
          const lines = stderrPending.split(/\r?\n/);
          stderrPending = lines.pop() ?? ""; // 最后一段可能不完整，留到下次
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) onStderr(trimmed);
          }
        }
      });

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(killTimer);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(new CodexToolError(`codex-tool binary not found at ${binPath}`, "bin_not_found"));
        } else {
          reject(new CodexToolError(`codex-tool spawn error: ${err.message}`, "spawn_failed"));
        }
      });

      child.on("close", (exitCode, signal) => {
        clearTimeout(killTimer);
        resolve({
          stdout,
          stderr,
          exitCode: exitCode,
          timedOut,
          signal
        });
      });

      // 灌 config JSON 到 stdin
      if (stdinJson !== null && stdinStream) {
        stdinStream.write(stdinJson);
        stdinStream.end();
      } else if (stdinStream) {
        stdinStream.end();
      }
    });
  };
}
