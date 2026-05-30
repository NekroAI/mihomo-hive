import { describe, expect, it } from "vitest";
import { defaultAccountFleetSpec, type AccountFleetSpec } from "@mihomo-hive/schemas";
import { codexEgressAuth, codexEgressRuntime } from "./codex-egress.js";

function spec(over: Partial<AccountFleetSpec["codexTool"]>): AccountFleetSpec {
  return {
    ...defaultAccountFleetSpec,
    codexTool: { ...defaultAccountFleetSpec.codexTool, ...over }
  } as AccountFleetSpec;
}

describe("codexEgressAuth", () => {
  it("returns a stable singleton across calls", () => {
    const a = codexEgressAuth();
    const b = codexEgressAuth();
    expect(a).toBe(b);
    expect(a.user).toBe("codex");
    expect(a.pass.length).toBeGreaterThan(16);
  });
});

describe("codexEgressRuntime", () => {
  it("disabled by default", () => {
    expect(codexEgressRuntime(defaultAccountFleetSpec).enabled).toBe(false);
  });

  it("requires remoteAgent.enabled AND dynamic AND host", () => {
    const base = {
      remoteAgent: { ...defaultAccountFleetSpec.codexTool.remoteAgent, enabled: true, url: "http://a:8765" },
      codexEgress: { ...defaultAccountFleetSpec.codexTool.codexEgress, dynamic: true, host: "192.168.5.16", port: 19000 }
    };
    expect(codexEgressRuntime(spec(base)).enabled).toBe(true);
    // 缺 host → 关
    expect(codexEgressRuntime(spec({ ...base, codexEgress: { ...base.codexEgress, host: "" } })).enabled).toBe(false);
    // dynamic 关 → 关
    expect(codexEgressRuntime(spec({ ...base, codexEgress: { ...base.codexEgress, dynamic: false } })).enabled).toBe(false);
    // agent 关 → 关
    expect(codexEgressRuntime(spec({ ...base, remoteAgent: { ...base.remoteAgent, enabled: false } })).enabled).toBe(false);
  });

  it("carries port/host/auth", () => {
    const rt = codexEgressRuntime(
      spec({
        remoteAgent: { ...defaultAccountFleetSpec.codexTool.remoteAgent, enabled: true, url: "http://a:8765" },
        codexEgress: { dynamic: true, host: "h", port: 12345, bindHost: "0.0.0.0" }
      })
    );
    expect(rt).toMatchObject({ enabled: true, port: 12345, host: "h", user: "codex" });
    expect(rt.pass.length).toBeGreaterThan(16);
  });
});
