import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sub2ApiClient } from "./sub2api-client.js";
import type { Sub2ApiConnectionConfig } from "@mihomo-hive/schemas";

const config: Sub2ApiConnectionConfig = {
  baseUrl: "https://sub2api.example.com",
  adminApiKey: "test-key",
  timezone: "Asia/Shanghai",
  managedProxyPrefix: "MH-"
};

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setupFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    const next = queue.shift();
    if (!next) throw new Error("No more mocked responses");
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      async json() {
        return next.body;
      }
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

describe("Sub2ApiClient — account write APIs (P2)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("refreshOpenaiToken", () => {
    it("POSTs body with refresh_token + proxy_id and parses result", async () => {
      const { calls } = setupFetch([
        {
          body: {
            code: 0,
            data: {
              access_token: "at",
              refresh_token: "rt-new",
              id_token: "it",
              expires_in: 86400,
              expires_at: 1780832865,
              client_id: "app_X",
              email: "a@b.uk",
              organization_id: "org-1"
            }
          }
        }
      ]);
      const client = new Sub2ApiClient(config);
      const result = await client.refreshOpenaiToken({ refreshToken: "rt-old", proxyId: 1 });
      expect(result.refresh_token).toBe("rt-new");
      expect(result.email).toBe("a@b.uk");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/api/v1/admin/openai/refresh-token");
      expect(calls[0]?.init?.method).toBe("POST");
      const sent = JSON.parse(String(calls[0]?.init?.body));
      expect(sent).toEqual({ refresh_token: "rt-old", proxy_id: 1 });
    });

    it("throws on non-zero code", async () => {
      setupFetch([{ body: { code: 1, message: "rt invalid" } }]);
      const client = new Sub2ApiClient(config);
      await expect(
        client.refreshOpenaiToken({ refreshToken: "bad", proxyId: 1 })
      ).rejects.toThrow(/导入 refresh_token 失败/);
    });
  });

  describe("createAccount", () => {
    it("POSTs validated payload + parses created id", async () => {
      const { calls } = setupFetch([
        {
          body: {
            code: 0,
            data: { id: 387, name: "Hive-260528-001", status: "active", proxy_id: 1 }
          }
        }
      ]);
      const client = new Sub2ApiClient(config);
      const created = await client.createAccount({
        name: "Hive-260528-001",
        notes: "",
        platform: "openai",
        type: "oauth",
        credentials: {
          access_token: "at",
          refresh_token: "rt",
          id_token: "it",
          expires_at: 1780832865,
          client_id: "app_X",
          email: "a@b.uk",
          organization_id: "org-1",
          model_mapping: {}
        },
        extra: { email: "a@b.uk" },
        proxy_id: 1,
        concurrency: 10,
        priority: 1,
        rate_multiplier: 1,
        group_ids: [2],
        expires_at: null,
        auto_pause_on_expired: true
      });
      expect(created.id).toBe(387);
      expect(calls[0]?.url).toContain("/api/v1/admin/accounts");
      const sent = JSON.parse(String(calls[0]?.init?.body));
      expect(sent.name).toBe("Hive-260528-001");
      expect(sent.credentials.refresh_token).toBe("rt");
      expect(sent.group_ids).toEqual([2]);
    });

    it("validates payload via Zod (missing required credentials field rejects)", async () => {
      const client = new Sub2ApiClient(config);
      // 缺 client_id → Zod 抛
      await expect(
        client.createAccount({
          name: "x",
          notes: "",
          platform: "openai",
          type: "oauth",
          credentials: {
            access_token: "at",
            refresh_token: "rt",
            id_token: "it",
            expires_at: 1,
            email: "e",
            organization_id: "o",
            model_mapping: {}
          } as never,
          extra: {},
          proxy_id: 1,
          concurrency: 10,
          priority: 1,
          rate_multiplier: 1,
          group_ids: [],
          expires_at: null,
          auto_pause_on_expired: true
        })
      ).rejects.toThrow();
    });
  });

  describe("getAccountUsage", () => {
    it("GET with source + force + timezone params", async () => {
      const { calls } = setupFetch([
        {
          body: {
            code: 0,
            data: {
              updated_at: "2026-05-28T19:49:43.074170153+08:00",
              five_hour: { utilization: 0.5, resets_at: null, remaining_seconds: 0, window_stats: {} },
              seven_day: { utilization: 0.92, resets_at: 1, remaining_seconds: 100, window_stats: { requests: 50 } }
            }
          }
        }
      ]);
      const client = new Sub2ApiClient(config);
      const u = await client.getAccountUsage(387);
      expect(u.five_hour.utilization).toBe(0.5);
      expect(u.seven_day.utilization).toBe(0.92);
      expect(calls[0]?.url).toContain("/api/v1/admin/accounts/387/usage");
      expect(calls[0]?.url).toContain("source=active");
      expect(calls[0]?.url).toContain("force=true");
      expect(calls[0]?.url).toContain("timezone=Asia%2FShanghai");
    });

    it("force=false propagates to query", async () => {
      const { calls } = setupFetch([{ body: { code: 0, data: {} } }]);
      const client = new Sub2ApiClient(config);
      await client.getAccountUsage(1, { force: false });
      expect(calls[0]?.url).toContain("force=false");
    });
  });

  describe("deleteAccount", () => {
    it("DELETE /admin/accounts/{id}", async () => {
      const { calls } = setupFetch([{ body: { code: 0, data: { message: "ok" } } }]);
      const client = new Sub2ApiClient(config);
      await client.deleteAccount(387);
      expect(calls[0]?.url).toContain("/api/v1/admin/accounts/387");
      expect(calls[0]?.init?.method).toBe("DELETE");
    });

    it("throws on Sub2API error code", async () => {
      setupFetch([{ body: { code: 2, message: "not found" } }]);
      const client = new Sub2ApiClient(config);
      await expect(client.deleteAccount(999)).rejects.toThrow(/删除 Sub2API 账号失败/);
    });
  });

  describe("setAccountSchedulable", () => {
    it("PUT /accounts/{id}/schedulable", async () => {
      const { calls } = setupFetch([
        { body: { code: 0, data: { id: 24, schedulable: false, status: "active" } } }
      ]);
      const client = new Sub2ApiClient(config);
      const r = await client.setAccountSchedulable(24, false);
      expect(r.schedulable).toBe(false);
      expect(calls[0]?.init?.method).toBe("PUT");
      const sent = JSON.parse(String(calls[0]?.init?.body));
      expect(sent).toEqual({ schedulable: false });
    });
  });

  describe("listGroups", () => {
    it("GET /admin/groups returns parsed items", async () => {
      setupFetch([
        {
          body: {
            code: 0,
            data: {
              items: [
                { id: 2, name: "OpenAI", platform: "openai", status: "active" },
                { id: 3, name: "Gemini", platform: "gemini", status: "active" }
              ]
            }
          }
        }
      ]);
      const client = new Sub2ApiClient(config);
      const groups = await client.listGroups();
      expect(groups).toHaveLength(2);
      expect(groups[0]?.name).toBe("OpenAI");
      expect(groups[1]?.platform).toBe("gemini");
    });
  });

  describe("request layer", () => {
    it("includes x-api-key header", async () => {
      const { calls } = setupFetch([{ body: { code: 0, data: { message: "ok" } } }]);
      const client = new Sub2ApiClient(config);
      await client.deleteAccount(1);
      const headers = calls[0]?.init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-key");
    });

    it("throws on HTTP !ok", async () => {
      setupFetch([{ ok: false, status: 500, body: { error: "internal" } }]);
      const client = new Sub2ApiClient(config);
      await expect(client.deleteAccount(1)).rejects.toThrow(/HTTP 500/);
    });
  });
});
