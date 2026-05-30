import { describe, expect, it, vi } from "vitest";
import { createAgentSpawner } from "./codex-tool-agent.js";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

describe("createAgentSpawner", () => {
  it("POSTs /run with args/stdin/idempotencyKey + bearer, maps result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ stdout: "S", stderr: "E", exitCode: 0, timedOut: false, signal: null });
    }) as unknown as typeof fetch;
    const spawn = createAgentSpawner({
      url: "http://agent:8765/",
      token: "tok",
      idempotencyKey: "job-1",
      fetchImpl
    });
    const lines: string[] = [];
    const res = await spawn({
      args: ["login", "--stateless"],
      stdinJson: '{"a":1}',
      timeoutMs: 1000,
      onStderr: (l) => lines.push(l)
    });
    expect(res).toEqual({ stdout: "S", stderr: "E", exitCode: 0, timedOut: false, signal: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://agent:8765/run"); // 末尾斜杠规整
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      args: ["login", "--stateless"],
      stdin: '{"a":1}',
      timeoutMs: 1000,
      idempotencyKey: "job-1"
    });
    expect(lines).toEqual(["E"]); // stderr 批量回放
  });

  it("throws on non-ok HTTP", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const spawn = createAgentSpawner({ url: "http://agent:8765", token: "", fetchImpl });
    await expect(spawn({ args: [], stdinJson: null, timeoutMs: 100 })).rejects.toThrow(/HTTP 500/);
  });

  it("maps AbortError → timedOut result (not throw)", async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const spawn = createAgentSpawner({ url: "http://agent:8765", token: "", fetchImpl });
    const res = await spawn({ args: [], stdinJson: null, timeoutMs: 50 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });
});
