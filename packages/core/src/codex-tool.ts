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
      max_cost_per_account_usd: config.phoneSms.maxCostPerAccountUsd
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

export interface CodexToolLoginResult {
  phone: string;
  email: string;
  accountId: string | null;
  tokens: CodexToolTokens;
}

export type CodexToolRegisterOutcome =
  | {
      kind: "token_ready";
      account: {
        phone: string;
        password: string;
        email: string;
        batchId: string;
        tokens: CodexToolTokens;
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
      };
    }
  | {
      kind: "registration_failed";
      error: string;
    };

// ─── Spawner / Adapter 接口 ──────────────────────

export interface CodexToolSpawnRequest {
  args: string[];
  stdinJson: string | null;
  timeoutMs: number;
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
  }): Promise<CodexToolLoginResult>;

  registerOne(input?: {
    timeoutMs?: number;
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

  async function runEnvelope(args: string[], timeoutMs: number, withStdin: boolean): Promise<CodexToolEnvelope> {
    const res = await spawner({
      args,
      stdinJson: withStdin ? configJson : null,
      timeoutMs
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
    if (!envelope.ok) {
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
      const env = await runEnvelope(args, timeoutMs, true);
      return parseLoginEnvelope(env);
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
      const env = await runEnvelope(args, timeoutMs, true);
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
        }
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
        recoveryInput: rec.recovery_input ?? null
      }
    };
  }
  const failures = Array.isArray(data.registration_failures) ? data.registration_failures : [];
  const failure = failures.find((f) => isObject(f));
  return {
    kind: "registration_failed",
    error: failure && isObject(failure) && typeof (failure as Record<string, unknown>).error === "string"
      ? String((failure as Record<string, unknown>).error)
      : "registration failed (no detail)"
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

function createDefaultSpawner(binPath: string): CodexToolSpawner {
  return async ({ args, stdinJson, timeoutMs }) => {
    return new Promise<CodexToolSpawnResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = defaultSpawn(binPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
          // 确保子进程隔离，没法 access Hive 的 env（避免泄漏 HIVE_ACCOUNT_KEY 等）
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
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
      let timedOut = false;

      const stdoutStream = child.stdout as Readable | null;
      const stderrStream = child.stderr as Readable | null;
      const stdinStream = child.stdin as Writable | null;

      stdoutStream?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stderrStream?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
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
