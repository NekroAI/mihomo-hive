/**
 * 账号 job 的实时日志缓冲（P5-AT）。
 *
 * worker 与 tRPC router 跑在同一个 Node 进程，所以用进程内 Map 即可让"正在运行的
 * job"把进度/codex-tool stderr 实时写进来、UI 通过 query 轮询读出。job 结束时把
 * 末尾若干行交给调用方持久化到 account_jobs.log_tail（这样"最近完成"也能回看日志）。
 *
 * 安全：codex-tool 的 **stdout 含 OAuth token，绝不进这里**；只接 stderr / worker
 * 自己产生的里程碑，且写入前统一 redact。每行截断、整体环形上限防止内存膨胀。
 */

export interface JobLogLine {
  /** ISO 时间戳 */
  ts: string;
  text: string;
}

const MAX_LINES = 300;
const MAX_LINE_LEN = 500;
const buffers = new Map<string, JobLogLine[]>();

function nowIso(): string {
  return new Date().toISOString();
}

/** 追加一行（自动截断 + 环形裁剪）。ts 由调用方传入以便测试可控，默认当前时间。 */
export function appendJobLog(jobId: string, text: string, ts?: string): void {
  const line: JobLogLine = { ts: ts ?? nowIso(), text: text.slice(0, MAX_LINE_LEN) };
  const arr = buffers.get(jobId);
  if (arr) {
    arr.push(line);
    if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
  } else {
    buffers.set(jobId, [line]);
  }
}

/** 读取某 job 的实时缓冲（运行中才有；已结束的从 DB log_tail 读）。 */
export function getJobLog(jobId: string): JobLogLine[] {
  return buffers.get(jobId) ?? [];
}

/**
 * job 结束时调用：返回末尾 tail 行拼成的字符串（供持久化到 log_tail），并清掉缓冲。
 * 限制 tailLines 行，避免 log_tail 列过大。
 */
export function finalizeJobLog(jobId: string, tailLines = 150): string {
  const arr = buffers.get(jobId);
  buffers.delete(jobId);
  if (!arr || arr.length === 0) return "";
  return arr
    .slice(-tailLines)
    .map((l) => `${l.ts.slice(11, 19)} ${l.text}`)
    .join("\n");
}

/** 测试辅助：清空所有缓冲。 */
export function __resetJobLogBuffers(): void {
  buffers.clear();
}
