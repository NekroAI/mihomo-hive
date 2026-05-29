import { describe, expect, it } from "vitest";
import {
  CodexAdoptionParseError,
  parseCodexAccountListEnvelope,
  planCodexToolAdoption,
  type AdoptionPlanInput,
  type CodexAccountFromExport
} from "./codex-tool-adoption.js";

// ─── parseCodexAccountListEnvelope ───────────────────

describe("parseCodexAccountListEnvelope", () => {
  it("解析合法 envelope，含完整 token 的账号", () => {
    const json = JSON.stringify({
      ok: true,
      command: "accounts list",
      run_id: null,
      data: {
        accounts: [
          {
            id: 42,
            phone: "+123",
            password: "p4ss",
            email: "alice@example.com",
            batch_id: "all-260528-abcd",
            status: "token_ready",
            created_at: "2026-05-25T10:20:00Z",
            id_token: "id-tok",
            access_token: "ac-tok",
            refresh_token: "ref-tok",
            chatgpt_account_id: "user-ABC",
            last_refresh: "2026-05-28T07:17:52Z"
          }
        ]
      },
      error: null,
      warnings: [],
      paths: {}
    });
    const out = parseCodexAccountListEnvelope(json);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 42,
      phone: "+123",
      password: "p4ss",
      email: "alice@example.com",
      idToken: "id-tok",
      refreshToken: "ref-tok",
      chatgptAccountId: "user-ABC"
    });
  });

  it("解析合法 envelope，token 字段缺失（registered 状态）", () => {
    const json = JSON.stringify({
      ok: true,
      command: "accounts list",
      data: {
        accounts: [
          {
            id: 43,
            phone: "+456",
            password: "p4ss2",
            email: null,
            status: "registered",
            id_token: null,
            access_token: null,
            refresh_token: null,
            chatgpt_account_id: null,
            last_refresh: null
          }
        ]
      }
    });
    const out = parseCodexAccountListEnvelope(json);
    expect(out[0]).toMatchObject({
      id: 43,
      phone: "+456",
      email: null,
      refreshToken: null
    });
  });

  it("拒绝 ok=false envelope", () => {
    const json = JSON.stringify({
      ok: false,
      command: "accounts list",
      error: "数据库被锁",
      data: null
    });
    expect(() => parseCodexAccountListEnvelope(json)).toThrowError(CodexAdoptionParseError);
  });

  it("拒绝错误的 command（用户上传了 stateless register envelope）", () => {
    const json = JSON.stringify({ ok: true, command: "all", data: { accounts: [] } });
    expect(() => parseCodexAccountListEnvelope(json)).toThrow(/是否传错了文件/);
  });

  it("拒绝非 JSON", () => {
    expect(() => parseCodexAccountListEnvelope("not json")).toThrow(/JSON parse failed/);
  });

  it("拒绝缺 phone 的账号（接管核心是凭据）", () => {
    const json = JSON.stringify({
      ok: true,
      command: "accounts list",
      data: { accounts: [{ id: 1, password: "p", email: "x@y.z" }] }
    });
    expect(() => parseCodexAccountListEnvelope(json)).toThrow(/accounts\[\]\.phone/);
  });

  it("空 accounts 数组允许（codex-tool 库刚建好没数据）", () => {
    const json = JSON.stringify({ ok: true, command: "accounts list", data: { accounts: [] } });
    expect(parseCodexAccountListEnvelope(json)).toEqual([]);
  });
});

// ─── planCodexToolAdoption ────────────────────────────

function makeCodex(overrides: Partial<CodexAccountFromExport> = {}): CodexAccountFromExport {
  return {
    id: 1,
    phone: "+100",
    password: "pw",
    email: "u@e.com",
    batchId: null,
    status: "token_ready",
    createdAt: null,
    idToken: "id",
    accessToken: "ac",
    refreshToken: "ref",
    chatgptAccountId: null,
    lastRefresh: null,
    ...overrides
  };
}

const EMPTY_INPUT: Omit<AdoptionPlanInput, "codexAccounts"> = {
  hiveAccounts: [],
  sub2apiAccounts: []
};

describe("planCodexToolAdoption", () => {
  it("Sub2API 已有 × 本地 hive_registered → skip_already_hive", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [makeCodex({ email: "alice@x.com" })],
      hiveAccounts: [
        { id: "h-1", email: "alice@x.com", origin: "hive_registered", hasEncPhonePassword: true, externalId: 42 }
      ],
      sub2apiAccounts: [{ id: 42, email: "alice@x.com" }]
    });
    expect(plan.items[0]?.action).toBe("skip_already_hive");
    expect(plan.summary.skipped).toBe(1);
  });

  it("Sub2API 已有 × 本地 adopted_recovered 已有凭据 → skip_creds_complete", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [makeCodex({ email: "bob@x.com" })],
      hiveAccounts: [
        { id: "h-2", email: "bob@x.com", origin: "adopted_recovered", hasEncPhonePassword: true, externalId: 7 }
      ],
      sub2apiAccounts: [{ id: 7, email: "bob@x.com" }]
    });
    expect(plan.items[0]?.action).toBe("skip_creds_complete");
  });

  it("Sub2API 已有 × 本地 adopted_observing → upgrade_recovered（接管核心价值）", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [makeCodex({ email: "carol@x.com" })],
      hiveAccounts: [
        { id: "h-3", email: "carol@x.com", origin: "adopted_observing", hasEncPhonePassword: false, externalId: 9 }
      ],
      sub2apiAccounts: [{ id: 9, email: "carol@x.com" }]
    });
    expect(plan.items[0]?.action).toBe("upgrade_recovered");
    expect(plan.items[0]?.sub2apiAccountId).toBe(9);
    expect(plan.items[0]?.hiveLocalId).toBe("h-3");
    expect(plan.summary.upgradeRecovered).toBe(1);
  });

  it("Sub2API 已有 × 本地无 → upgrade_recovered（远端 + codex 双源拼齐）", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [makeCodex({ email: "dave@x.com" })],
      hiveAccounts: [],
      sub2apiAccounts: [{ id: 11, email: "dave@x.com" }]
    });
    expect(plan.items[0]?.action).toBe("upgrade_recovered");
    expect(plan.items[0]?.hiveLocalId).toBeUndefined();
  });

  it("Sub2API 无 × codex 有 refresh_token → register_new", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [makeCodex({ email: "eve@x.com", refreshToken: "fresh" })],
      ...EMPTY_INPUT
    });
    expect(plan.items[0]?.action).toBe("register_new");
    expect(plan.summary.registerNew).toBe(1);
  });

  it("Sub2API 无 × codex 无 refresh_token → observed_only", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [makeCodex({ email: "frank@x.com", refreshToken: null })],
      ...EMPTY_INPUT
    });
    expect(plan.items[0]?.action).toBe("observed_only");
    expect(plan.summary.observedOnly).toBe(1);
  });

  it("codex email=null → 不可能匹配到远端 / 本地，按 register_new / observed_only 兜底", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [
        makeCodex({ id: 1, email: null, refreshToken: "x" }),
        makeCodex({ id: 2, email: null, refreshToken: null })
      ],
      hiveAccounts: [
        // 噪音：本地有 hive_registered 但 email != null，不会和 codex.email=null 匹配
        { id: "h-x", email: "noise@x.com", origin: "hive_registered", hasEncPhonePassword: true, externalId: 1 }
      ],
      sub2apiAccounts: [{ id: 1, email: "noise@x.com" }]
    });
    expect(plan.items[0]?.action).toBe("register_new");
    expect(plan.items[1]?.action).toBe("observed_only");
  });

  it("大小写不敏感匹配 email", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [makeCodex({ email: "Alice@X.COM" })],
      hiveAccounts: [],
      sub2apiAccounts: [{ id: 1, email: "alice@x.com" }]
    });
    expect(plan.items[0]?.action).toBe("upgrade_recovered");
  });

  it("混合输入 → summary 计数准确", () => {
    const plan = planCodexToolAdoption({
      codexAccounts: [
        makeCodex({ id: 1, email: "skip@x.com" }), // skip_already_hive
        makeCodex({ id: 2, email: "upgrade@x.com" }), // upgrade
        makeCodex({ id: 3, email: "fresh1@x.com", refreshToken: "r" }), // register_new
        makeCodex({ id: 4, email: "fresh2@x.com", refreshToken: null }) // observed_only
      ],
      hiveAccounts: [
        { id: "h-1", email: "skip@x.com", origin: "hive_registered", hasEncPhonePassword: true, externalId: 100 }
      ],
      sub2apiAccounts: [
        { id: 100, email: "skip@x.com" },
        { id: 200, email: "upgrade@x.com" }
      ]
    });
    expect(plan.summary).toEqual({
      totalScanned: 4,
      upgradeRecovered: 1,
      registerNew: 1,
      observedOnly: 1,
      skipped: 1,
      invalidSkipped: 0
    });
  });
});
