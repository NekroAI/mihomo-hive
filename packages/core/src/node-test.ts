import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProxyTestTarget {
  id: string;
  name: string;
  url: string;
  expectedStatuses: number[];
}

export interface ProxyTargetTestResult {
  targetId: string;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  message: string;
}

export const defaultProxyTestTargets: Record<string, ProxyTestTarget> = {
  ip: {
    id: "ip",
    name: "IP echo",
    url: "https://api.ipify.org",
    expectedStatuses: [200]
  },
  openai: {
    id: "openai",
    name: "OpenAI API",
    url: "https://api.openai.com/v1/models",
    expectedStatuses: [401]
  },
  claude: {
    id: "claude",
    name: "Claude API",
    url: "https://api.anthropic.com/v1/messages",
    expectedStatuses: [405]
  }
};

export function resolveProxyTestTargets(ids: string[]): ProxyTestTarget[] {
  return ids.map((id) => {
    const target = defaultProxyTestTargets[id];
    if (!target) {
      throw new Error(`Unknown test target: ${id}. Available: ${Object.keys(defaultProxyTestTargets).join(", ")}`);
    }
    return target;
  });
}

export async function testProxyTarget(input: {
  host: string;
  port: number;
  target: ProxyTestTarget;
  timeoutMs: number;
}): Promise<ProxyTargetTestResult> {
  const startedAt = Date.now();
  const maxTimeSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));

  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "--max-time",
        String(maxTimeSeconds),
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-x",
        `socks5h://${input.host}:${input.port}`,
        input.target.url
      ],
      { timeout: input.timeoutMs + 1000 }
    );
    const latencyMs = Date.now() - startedAt;
    const httpStatus = Number(String(stdout).trim());
    const ok = input.target.expectedStatuses.includes(httpStatus);
    return {
      targetId: input.target.id,
      ok,
      httpStatus,
      latencyMs,
      message: ok ? "ok" : `unexpected_http_${httpStatus || "none"}`
    };
  } catch (error) {
    return {
      targetId: input.target.id,
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: summarizeError(error)
    };
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index] as T, index);
      }
    })
  );

  return results;
}

function summarizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown_error";
  }
  const firstLine = error.message.split(/\r?\n/)[0] ?? error.message;
  if (/timed out|timeout/i.test(firstLine)) {
    return "timeout";
  }
  return firstLine.replace(/^Command failed:\s*/i, "").slice(0, 160);
}
