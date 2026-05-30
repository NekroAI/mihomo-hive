/**
 * codex-tool 外置 Agent 的 HTTP spawner —— 把"本地起 codex-tool 子进程"换成"POST 到
 * 桌面 agent 的 /run"。adapter / worker / 信封解析全不变,只换这一层传输。
 *
 * 契约与 `codex-tool serve` 对齐：
 *   POST {url}/run  (Authorization: Bearer <token>)
 *     body  {args, stdin, timeoutMs, graceMs, idempotencyKey?}
 *     resp  {stdout, stderr, exitCode, timedOut, signal}
 *
 * 注意:HTTP 是请求/响应,stderr 只在结束时一次性拿到 → onStderr 收尾时批量回放(日志进 job,
 * 非实时)。idempotencyKey 让 agent 对"已完成结果"去重(防响应丢失重复执行)。
 */

import type { CodexToolSpawner, CodexToolSpawnRequest, CodexToolSpawnResult } from "./codex-tool.js";

export interface AgentSpawnerOptions {
  /** agent 基址,如 http://192.168.5.20:8765 。 */
  url: string;
  /** 共享 bearer token;空则不带鉴权头。 */
  token: string;
  /** 幂等键(通常用 job id);agent 据此缓存已完成结果。 */
  idempotencyKey?: string;
  /** HTTP 超时在 codex 超时之上的余量(ms)。 */
  timeoutPaddingMs?: number;
  /** 测试可注入 fetch。 */
  fetchImpl?: typeof fetch;
}

interface AgentRunResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  signal?: string | null;
}

export function createAgentSpawner(opts: AgentSpawnerOptions): CodexToolSpawner {
  const base = opts.url.replace(/\/+$/, "");
  const padding = opts.timeoutPaddingMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? fetch;

  return async (req: CodexToolSpawnRequest): Promise<CodexToolSpawnResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs + padding);
    try {
      const res = await doFetch(`${base}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
        },
        body: JSON.stringify({
          args: req.args,
          stdin: req.stdinJson,
          timeoutMs: req.timeoutMs,
          graceMs: req.graceMs ?? 15_000,
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {})
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`codex-tool agent HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as AgentRunResponse;
      const stderr = body.stderr ?? "";
      // 批量回放 stderr(非实时):让 worker 的 appendJobLog 仍拿到 codex: 进度行
      if (req.onStderr && stderr) {
        for (const line of stderr.split("\n")) {
          if (line.trim()) req.onStderr(line);
        }
      }
      return {
        stdout: body.stdout ?? "",
        stderr,
        exitCode: body.exitCode ?? null,
        timedOut: Boolean(body.timedOut),
        signal: (body.signal as NodeJS.Signals | null) ?? null
      };
    } catch (err) {
      // 网络/中止类:映射成 spawn 失败信号,让 adapter 当作可重试失败处理
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        return { stdout: "", stderr: "agent request aborted (timeout)", exitCode: null, timedOut: true, signal: null };
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  };
}
