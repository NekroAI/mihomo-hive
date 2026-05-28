import { describe, expect, it } from "vitest";
import {
  buildCodexToolConfigJson,
  CodexToolError,
  createCodexToolAdapter,
  parseEnvelope,
  type CodexToolConfig,
  type CodexToolSpawnRequest,
  type CodexToolSpawnResult,
  type CodexToolSpawner
} from "./codex-tool.js";

const baseConfig: CodexToolConfig = {
  binPath: "codex-tool",
  skymail: { baseUrl: "https://mail.example.com", adminEmail: "a@e", adminPassword: "secret" },
  chatgpt: { mailDomain: "example.com", chatWebClientId: "app_chat", codexClientId: "app_codex" },
  phoneSms: { provider: "herosms", apiKey: "sms-key", service: "dr", maxCostPerAccountUsd: 0.05 },
  httpUserAgentChrome: "Mozilla/5.0",
  proxyDefault: "socks5://127.0.0.1:10001"
};

const defaults = { smsCountriesMs: 5_000, loginMs: 30_000, registerMs: 60_000 };

function makeRecordingSpawner(
  result: CodexToolSpawnResult
): { spawner: CodexToolSpawner; recorded: CodexToolSpawnRequest[] } {
  const recorded: CodexToolSpawnRequest[] = [];
  const spawner: CodexToolSpawner = async (input) => {
    recorded.push(input);
    return result;
  };
  return { spawner, recorded };
}

describe("buildCodexToolConfigJson", () => {
  it("maps herosms api key to herosms_api_key", () => {
    const json = buildCodexToolConfigJson(baseConfig);
    expect((json.phone_sms as Record<string, unknown>).herosms_api_key).toBe("sms-key");
    expect((json.phone_sms as Record<string, unknown>).fivesim_api_key).toBeUndefined();
  });

  it("maps fivesim provider to fivesim_api_key", () => {
    const json = buildCodexToolConfigJson({
      ...baseConfig,
      phoneSms: { ...baseConfig.phoneSms, provider: "fivesim", apiKey: "5sim-k" }
    });
    expect((json.phone_sms as Record<string, unknown>).fivesim_api_key).toBe("5sim-k");
  });

  it("maps nexsms provider to nexsms_api_key", () => {
    const json = buildCodexToolConfigJson({
      ...baseConfig,
      phoneSms: { ...baseConfig.phoneSms, provider: "nexsms", apiKey: "nex-k" }
    });
    expect((json.phone_sms as Record<string, unknown>).nexsms_api_key).toBe("nex-k");
  });

  it("传递 max_cost_per_account_usd 给 codex-tool（地区由 codex-tool 自决）", () => {
    const json = buildCodexToolConfigJson({
      ...baseConfig,
      phoneSms: { ...baseConfig.phoneSms, maxCostPerAccountUsd: 0.08 }
    });
    expect((json.phone_sms as Record<string, unknown>).max_cost_per_account_usd).toBe(0.08);
    // 同时 country 字段不再传 —— codex-tool 自己根据上限筛地区
    expect((json.phone_sms as Record<string, unknown>).country).toBeUndefined();
  });

  it("uses snake_case field names matching codex-tool config schema", () => {
    const json = buildCodexToolConfigJson(baseConfig);
    expect(json.skymail).toEqual({
      base_url: "https://mail.example.com",
      admin_email: "a@e",
      admin_password: "secret"
    });
    expect(json.chatgpt).toEqual({
      mail_domain: "example.com",
      chat_web_client_id: "app_chat",
      codex_client_id: "app_codex"
    });
    expect(json.proxy).toEqual({ default: "socks5://127.0.0.1:10001" });
    expect(json.http).toEqual({ user_agent_chrome: "Mozilla/5.0" });
  });
});

describe("parseEnvelope", () => {
  it("parses well-formed envelope", () => {
    const env = parseEnvelope(
      JSON.stringify({
        ok: true,
        command: "test",
        run_id: null,
        data: { foo: "bar" },
        error: null,
        warnings: [],
        paths: {}
      })
    );
    expect(env.ok).toBe(true);
    expect((env.data as Record<string, string>).foo).toBe("bar");
  });

  it("rejects non-JSON", () => {
    expect(() => parseEnvelope("not json")).toThrow(CodexToolError);
  });

  it("rejects array root", () => {
    expect(() => parseEnvelope("[1,2,3]")).toThrow(/not an object/);
  });

  it("rejects missing ok field", () => {
    expect(() => parseEnvelope('{"command":"x"}')).toThrow(/missing 'ok'/);
  });
});

describe("CodexToolAdapter", () => {
  describe("smsCountries", () => {
    it("passes proper args + config stdin, parses countries", async () => {
      const { spawner, recorded } = makeRecordingSpawner({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          command: "sms countries",
          run_id: null,
          data: {
            provider: "herosms",
            service: "dr",
            countries: [
              {
                country: "6",
                country_name: "印度尼西亚",
                price: 0.4,
                total: 100,
                physical: 60,
                virtual: 40,
                recommended: true,
                important_flags: ["high-yield"]
              },
              { country: "7", country_name: "x", price: 0.5, total: 5, physical: 0, virtual: 5 }
            ],
            total: 2,
            sort: "price asc, physical desc, total desc"
          },
          error: null,
          warnings: [],
          paths: {}
        }),
        stderr: "",
        timedOut: false,
        signal: null
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      const r = await adapter.smsCountries({ limit: 20 });
      expect(r.countries).toHaveLength(2);
      expect(r.countries[0]?.country).toBe("6");
      expect(r.countries[0]?.countryName).toBe("印度尼西亚");
      expect(r.countries[0]?.recommended).toBe(true);
      expect(r.countries[1]?.importantFlags).toEqual([]); // 缺字段降级为空数组

      // 校验 args + stdin
      const req = recorded[0];
      expect(req?.args).toEqual(["sms", "countries", "--json", "--no-color", "--config-json-stdin", "--limit", "20"]);
      expect(req?.stdinJson).not.toBeNull();
      const sentConfig = JSON.parse(req?.stdinJson ?? "{}");
      expect((sentConfig.phone_sms as Record<string, unknown>).herosms_api_key).toBe("sms-key");
    });
  });

  describe("login", () => {
    it("emits required args + parses tokens", async () => {
      const { spawner, recorded } = makeRecordingSpawner({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          command: "login",
          run_id: null,
          data: {
            phone: "+1234567890",
            email: "alice@example.com",
            account_id: "user-ABC",
            status: "token_ready",
            token: {
              auth_mode: "chatgpt",
              tokens: {
                id_token: "id-tok",
                access_token: "acc-tok",
                refresh_token: "ref-tok",
                account_id: "user-ABC"
              },
              last_refresh: "2026-05-28T07:17:52Z",
              _email: "alice@example.com"
            }
          },
          error: null,
          warnings: [],
          paths: {}
        }),
        stderr: "",
        timedOut: false,
        signal: null
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      const r = await adapter.login({ phone: "+1234567890", password: "p4ss" });
      expect(r.phone).toBe("+1234567890");
      expect(r.email).toBe("alice@example.com");
      expect(r.tokens.refreshToken).toBe("ref-tok");
      expect(r.tokens.accessToken).toBe("acc-tok");
      expect(r.tokens.accountId).toBe("user-ABC");

      const args = recorded[0]?.args ?? [];
      expect(args).toContain("--stateless");
      expect(args).toContain("--reveal-secrets");
      expect(args).toContain("--config-json-stdin");
      expect(args).toContain("--phone");
      expect(args[args.indexOf("--phone") + 1]).toBe("+1234567890");
      expect(args[args.indexOf("--password") + 1]).toBe("p4ss");
    });

    it("maps exit code 4 to verification error", async () => {
      const { spawner } = makeRecordingSpawner({
        exitCode: 4,
        stdout: JSON.stringify({
          ok: false,
          command: "login",
          run_id: null,
          data: null,
          error: "email OTP timeout",
          warnings: [],
          paths: {}
        }),
        stderr: "",
        timedOut: false,
        signal: null
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      await expect(adapter.login({ phone: "+1", password: "p" })).rejects.toMatchObject({
        kind: "verification",
        exitCode: 4
      });
    });

    it("maps exit code 3 to external_service error", async () => {
      const { spawner } = makeRecordingSpawner({
        exitCode: 3,
        stdout: JSON.stringify({
          ok: false,
          command: "login",
          run_id: null,
          data: null,
          error: "openai HTTP 500",
          warnings: [],
          paths: {}
        }),
        stderr: "",
        timedOut: false,
        signal: null
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      await expect(adapter.login({ phone: "+1", password: "p" })).rejects.toMatchObject({
        kind: "external_service",
        exitCode: 3
      });
    });

    it("throws timeout when spawner reports timeout", async () => {
      const { spawner } = makeRecordingSpawner({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: true,
        signal: "SIGKILL"
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      await expect(adapter.login({ phone: "+1", password: "p" })).rejects.toMatchObject({
        kind: "timeout"
      });
    });

    it("rejects envelope without required token fields", async () => {
      const { spawner } = makeRecordingSpawner({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          command: "login",
          run_id: null,
          data: { phone: "+1", email: "a@b", token: { tokens: {} } },
          error: null,
          warnings: [],
          paths: {}
        }),
        stderr: "",
        timedOut: false,
        signal: null
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      await expect(adapter.login({ phone: "+1", password: "p" })).rejects.toThrow(/id_token/);
    });
  });

  describe("registerOne", () => {
    it("returns token_ready when account in accounts[]", async () => {
      const { spawner } = makeRecordingSpawner({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          command: "all",
          run_id: null,
          data: {
            accounts: [
              {
                phone: "+999",
                password: "p4ss",
                email: "bob@e.com",
                batch_id: "all-260528-abcd",
                status: "token_ready",
                token: {
                  tokens: {
                    id_token: "id",
                    access_token: "ac",
                    refresh_token: "rt"
                  }
                }
              }
            ],
            recoverable_accounts: [],
            registration_failures: [],
            summary: { requested: 1, token_ready: 1, recoverable_failed: 0, registration_failed: 0 }
          },
          error: null,
          warnings: [],
          paths: {}
        }),
        stderr: "",
        timedOut: false,
        signal: null
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      const r = await adapter.registerOne();
      if (r.kind !== "token_ready") throw new Error("expected token_ready");
      expect(r.account.email).toBe("bob@e.com");
      expect(r.account.tokens.refreshToken).toBe("rt");
      expect(r.account.batchId).toBe("all-260528-abcd");
    });

    it("returns oauth_failed when recoverable_accounts has phone+password", async () => {
      const { spawner } = makeRecordingSpawner({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          command: "all",
          run_id: null,
          data: {
            accounts: [],
            recoverable_accounts: [
              {
                phone: "+888",
                password: "p4ss",
                batch_id: "all-260528-xxxx",
                status: "oauth_failed",
                error: "OAuth timeout",
                recovery_input: {
                  command: "login",
                  stateless: true,
                  phone: "+888",
                  password: "p4ss",
                  required_flags: ["--stateless", "--json", "--reveal-secrets"]
                }
              }
            ],
            registration_failures: [],
            summary: { requested: 1, token_ready: 0, recoverable_failed: 1, registration_failed: 0 }
          },
          error: null,
          warnings: [],
          paths: {}
        }),
        stderr: "",
        timedOut: false,
        signal: null
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      const r = await adapter.registerOne();
      if (r.kind !== "oauth_failed") throw new Error("expected oauth_failed");
      expect(r.recoverable.phone).toBe("+888");
      expect(r.recoverable.password).toBe("p4ss");
      expect(r.recoverable.error).toBe("OAuth timeout");
    });

    it("returns registration_failed when only registration_failures[]", async () => {
      const { spawner } = makeRecordingSpawner({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          command: "all",
          run_id: null,
          data: {
            accounts: [],
            recoverable_accounts: [],
            registration_failures: [{ index: 1, status: "registration_failed", error: "HeroSMS 取号失败" }],
            summary: { requested: 1, token_ready: 0, recoverable_failed: 0, registration_failed: 1 }
          },
          error: null,
          warnings: [],
          paths: {}
        }),
        stderr: "",
        timedOut: false,
        signal: null
      });
      const adapter = createCodexToolAdapter({ config: baseConfig, defaults, spawner });
      const r = await adapter.registerOne();
      if (r.kind !== "registration_failed") throw new Error("expected registration_failed");
      expect(r.error).toBe("HeroSMS 取号失败");
    });

  });
});
