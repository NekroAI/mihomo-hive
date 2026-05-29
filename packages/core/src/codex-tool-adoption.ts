/**
 * codex-tool 账号接管纯函数（P5-AK/3a）。
 *
 * 输入流：用户在 codex-tool 主机执行 `accounts list --include-tokens --json` 拿到
 * envelope JSON 文件，Hive UI 上传，server 解析后跟本地 / Sub2API 远端账号做三分支
 * 去重计划。
 *
 * 设计原则：
 *   - 纯函数，不依赖 db / network
 *   - 字段按 docs/external-integration.md §"接管既有账号" 的 snake_case 形态解析
 *   - 字段稳定性承诺由 codex-tool 文档保证，envelope 解析 null-safe
 *   - 三分支按 (Sub2API 是否已有, codex-tool 是否有 refresh_token) 二维分流
 */

// ─── 解析 codex-tool envelope ─────────────────────────

export interface CodexAccountFromExport {
  /** codex-tool 本地数据库 id（int），仅作为 import 接口的 selection key */
  id: number;
  phone: string;
  password: string;
  email: string | null;
  batchId: string | null;
  /** codex-tool 端账号 status（如 "token_ready" / "registered" / "oauth_failed"），仅参考 */
  status: string;
  createdAt: string | null;
  /** 最新 token 字段；账号没有 token 时全部为 null（status 通常不是 token_ready） */
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  chatgptAccountId: string | null;
  lastRefresh: string | null;
}

export class CodexAdoptionParseError extends Error {
  constructor(
    message: string,
    public readonly kind: "envelope_invalid" | "envelope_not_ok" | "missing_field" | "wrong_command"
  ) {
    super(message);
    this.name = "CodexAdoptionParseError";
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function requireStr(o: Record<string, unknown>, field: string): string {
  const v = o[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new CodexAdoptionParseError(`accounts[].${field} missing or empty`, "missing_field");
  }
  return v;
}

/**
 * 解析 codex-tool 导出的 envelope JSON 字符串。
 *
 * 期待结构（docs/external-integration.md §"接管既有账号"）：
 * ```
 * { ok: true, command: "accounts list", data: { accounts: [...] }, ... }
 * ```
 *
 * 严格校验：
 *   - ok 必须 true（否则用户的 codex-tool 调用本身失败了，不能继续）
 *   - command 必须 "accounts list"（防误传 stateless register envelope）
 *   - phone + password 必须有（接管的核心价值是回填这两个凭据）
 *   - email / token 字段可 null（token 缺失的账号也要导入为 "凭据存在但 token 缺失"）
 */
export function parseCodexAccountListEnvelope(jsonText: string): CodexAccountFromExport[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(jsonText);
  } catch (e) {
    throw new CodexAdoptionParseError(
      `JSON parse failed: ${(e as Error).message}`,
      "envelope_invalid"
    );
  }
  if (!isObj(envelope)) {
    throw new CodexAdoptionParseError("envelope is not an object", "envelope_invalid");
  }
  if (envelope.ok !== true) {
    const errMsg = typeof envelope.error === "string" ? envelope.error : "ok=false";
    throw new CodexAdoptionParseError(`codex-tool envelope.ok=false: ${errMsg}`, "envelope_not_ok");
  }
  if (envelope.command !== "accounts list") {
    throw new CodexAdoptionParseError(
      `expected command="accounts list", got "${envelope.command}". 是否传错了文件？接管功能需要 \`accounts list --include-tokens\` 的输出。`,
      "wrong_command"
    );
  }
  const data = isObj(envelope.data) ? envelope.data : {};
  const rawAccounts = Array.isArray(data.accounts) ? data.accounts : [];

  const out: CodexAccountFromExport[] = [];
  for (const raw of rawAccounts) {
    if (!isObj(raw)) continue;
    const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new CodexAdoptionParseError(
        `accounts[].id must be positive integer, got ${JSON.stringify(raw.id)}`,
        "missing_field"
      );
    }
    out.push({
      id,
      phone: requireStr(raw, "phone"),
      password: requireStr(raw, "password"),
      email: strOrNull(raw.email),
      batchId: strOrNull(raw.batch_id),
      status: typeof raw.status === "string" ? raw.status : "unknown",
      createdAt: strOrNull(raw.created_at),
      idToken: strOrNull(raw.id_token),
      accessToken: strOrNull(raw.access_token),
      refreshToken: strOrNull(raw.refresh_token),
      chatgptAccountId: strOrNull(raw.chatgpt_account_id),
      lastRefresh: strOrNull(raw.last_refresh)
    });
  }
  return out;
}

// ─── 三分支去重计划 ───────────────────────────────────

export type AdoptionAction =
  /** Sub2API 已有，且本地 Hive 账号原本是 adopted_* 无凭据 →
   *  回填 phone+password，origin 升级 adopted_recovered，未来可 codex_login 自愈 */
  | "upgrade_recovered"
  /** Sub2API 无，codex-tool 有 refresh_token → 走 refresh + create 路径新建 Sub2API account
   *  + Hive 落 hive_registered */
  | "register_new"
  /** Sub2API 无，codex-tool 也没 refresh_token → Hive 落 adopted_observing 仅记录
   *  phone+password 不调 Sub2API，提示用户手动跑一次 codex_login */
  | "observed_only"
  /** 跳过：本地 Hive 已经有这个邮箱 + hive_registered 状态（凭据本来就该全），不重复 */
  | "skip_already_hive"
  /** 跳过：codex-tool 给的账号已经在 Hive 里且本地有 refresh_token（凭据已齐） */
  | "skip_creds_complete";

export interface AdoptionPlanItem {
  source: CodexAccountFromExport;
  action: AdoptionAction;
  /** UI 上显示的人话原因 */
  reason: string;
  /** Sub2API 远端账号 id（若有；preview UI 上点开看远端记录用） */
  sub2apiAccountId?: number;
  /** Hive 本地 account id（若有，用于 upgrade 分支的 patchAccount target） */
  hiveLocalId?: string;
}

export interface AdoptionPlanSummary {
  totalScanned: number;
  upgradeRecovered: number;
  registerNew: number;
  observedOnly: number;
  skipped: number;
  /** 致命错误：缺 phone/password 的账号数（这些被忽略，因为接管核心是凭据） */
  invalidSkipped: number;
}

export interface AdoptionPlan {
  items: AdoptionPlanItem[];
  summary: AdoptionPlanSummary;
}

/**
 * 三分支去重决策（详见 notes/codex-tool-needs.md §4 + SystemRoute 占位文案）：
 *
 *   ┌──────────────────────────┬─────────────────────────┐
 *   │ Sub2API 有？              │ codex-tool 有 refresh   │
 *   │                          │ token？                  │
 *   ├──────────────────────────┼─────────────────────────┤
 *   │ Y (本地 hive_registered) │  -                       │ → skip_already_hive
 *   │ Y (本地 hive_registered) │  Y                       │ → skip_already_hive
 *   │ Y (本地 adopted_recover  │  -                       │ → skip_creds_complete (本地已有凭据)
 *   │    且 enc_password 在)   │                          │
 *   │ Y (本地 adopted_observ-  │  -                       │ → upgrade_recovered ✨
 *   │    ing 或无 enc_password)│                          │
 *   │ Y (本地无)               │  -                       │ → upgrade_recovered ✨ (会先 upsert)
 *   │ N                        │  Y                       │ → register_new ✨
 *   │ N                        │  N                       │ → observed_only
 *   └──────────────────────────┴─────────────────────────┘
 *
 * Match key：email（codex-tool 的 email 字段 vs Sub2API account.email / Hive
 * accounts.email）。codex-tool 端账号可能 email=null（注册成功但 token 缺失的
 * 状态），这些只能走 observed_only 分支兜底。
 */
export interface AdoptionPlanInput {
  codexAccounts: CodexAccountFromExport[];
  /**
   * Hive 本地账号视图（origin + email + 是否有 enc_password）。adopter 不直接看 enc，
   * 由调用方传 hasEncPhonePassword 布尔。
   */
  hiveAccounts: Array<{
    id: string;
    email: string;
    origin: string;
    hasEncPhonePassword: boolean;
    externalId: number | null;
  }>;
  /** Sub2API 远端账号最少字段：id + email；用 email 做匹配 */
  sub2apiAccounts: Array<{ id: number; email: string | null }>;
}

export function planCodexToolAdoption(input: AdoptionPlanInput): AdoptionPlan {
  // index：email → 本地账号 / 远端账号
  const localByEmail = new Map<string, AdoptionPlanInput["hiveAccounts"][number]>();
  for (const local of input.hiveAccounts) {
    if (local.email) localByEmail.set(local.email.toLowerCase(), local);
  }
  const remoteByEmail = new Map<string, AdoptionPlanInput["sub2apiAccounts"][number]>();
  for (const remote of input.sub2apiAccounts) {
    if (remote.email) remoteByEmail.set(remote.email.toLowerCase(), remote);
  }

  const items: AdoptionPlanItem[] = [];
  let invalidSkipped = 0;
  for (const acc of input.codexAccounts) {
    if (!acc.phone || !acc.password) {
      // 这种已在 parse 阶段拒掉，理论不会到这里；保留兜底防止上游绕过
      invalidSkipped++;
      continue;
    }
    const emailKey = acc.email?.toLowerCase() ?? null;
    const remote = emailKey ? remoteByEmail.get(emailKey) : undefined;
    const local = emailKey ? localByEmail.get(emailKey) : undefined;

    // reason 文案面向用户：不暴露内部 origin/enum 名（adopted_recovered / hive_registered
    // 等），只讲"会发生什么"。内部分支语义见各 action 类型注释。
    if (remote && local && local.origin === "hive_registered") {
      items.push({
        source: acc,
        action: "skip_already_hive",
        reason: "Hive 已有同邮箱账号，凭据齐全，无需重复接管",
        sub2apiAccountId: remote.id,
        hiveLocalId: local.id
      });
      continue;
    }
    if (remote && local && local.hasEncPhonePassword && local.origin === "adopted_recovered") {
      items.push({
        source: acc,
        action: "skip_creds_complete",
        reason: "本地已存有手机号 + 密码，无需重复回填",
        sub2apiAccountId: remote.id,
        hiveLocalId: local.id
      });
      continue;
    }
    if (remote) {
      // 远端有 + (本地无 / 本地有但缺凭据) → 升级
      items.push({
        source: acc,
        action: "upgrade_recovered",
        reason: local
          ? "Sub2API 已有此账号但本地缺凭据，回填手机号 + 密码后可自动续命"
          : "Sub2API 已有此账号，回填凭据 + 拉取 token 一次性纳入本地管理",
        sub2apiAccountId: remote.id,
        ...(local ? { hiveLocalId: local.id } : {})
      });
      continue;
    }
    // 远端无
    if (acc.refreshToken) {
      items.push({
        source: acc,
        action: "register_new",
        reason: "Sub2API 暂无此账号，凭据有效 → 自动建号并纳入账号池"
      });
      continue;
    }
    items.push({
      source: acc,
      action: "observed_only",
      reason: "凭据已过期，先在本地存档；之后手动触发一次登录即可救活"
    });
  }

  return {
    items,
    summary: {
      totalScanned: input.codexAccounts.length,
      upgradeRecovered: items.filter((i) => i.action === "upgrade_recovered").length,
      registerNew: items.filter((i) => i.action === "register_new").length,
      observedOnly: items.filter((i) => i.action === "observed_only").length,
      skipped: items.filter((i) => i.action === "skip_already_hive" || i.action === "skip_creds_complete").length,
      invalidSkipped
    }
  };
}
