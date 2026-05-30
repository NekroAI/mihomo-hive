import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntimeConfig } from "@mihomo-hive/schemas";
import { setProxyGroupSelection } from "./controller.js";

describe("setProxyGroupSelection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUT /proxies/{group} with {name} + bearer secret", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }));
    const cfg = { ...defaultRuntimeConfig, externalController: "127.0.0.1:9090", externalControllerSecret: "sek" };
    await setProxyGroupSelection(cfg, "codex-egress", "hive-001-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9090/proxies/codex-egress");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "hive-001-abc" });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sek");
  });

  it("throws on non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(setProxyGroupSelection(defaultRuntimeConfig, "g", "p")).rejects.toThrow(/失败/);
  });
});
