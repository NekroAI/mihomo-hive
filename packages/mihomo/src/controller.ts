import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeConfig } from "@mihomo-hive/schemas";

export interface MihomoStatus {
  running: boolean;
  pid?: number;
}

export async function readMihomoStatus(config: RuntimeConfig): Promise<MihomoStatus> {
  try {
    const pid = Number((await readFile(config.mihomoPidPath, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return { running: false };
    }
    process.kill(pid, 0);
    // pid 存在 ≠ 是 mihomo。容器重建后 /data/mihomo.pid（挂载卷）残留旧 pid，新容器里
    // 该 pid 可能被别的进程占用 → 误判 running → mihomo 永不启动 → 所有代理失效。
    // 在 Linux 用 /proc/{pid}/cmdline 校验确实是 mihomo；非 Linux（开发机）/proc 读不到
    // 时退回只靠 kill 探活（保持原行为）。
    if (!processIsMihomo(pid)) {
      return { running: false };
    }
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/**
 * 校验 pid 对应进程确实是 mihomo（防容器重建后残留 pidfile 误判）。
 * 读 /proc/{pid}/cmdline：含 "mihomo" 才算。/proc 不存在（非 Linux）→ 返回 true
 * 退回 kill 探活语义，不破坏开发机行为。
 */
function processIsMihomo(pid: number): boolean {
  try {
    // cmdline 用 \0 分隔参数；mihomo 二进制路径里含 "mihomo"
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!cmdline) return true; // 空读不到 → 不否定
    return cmdline.toLowerCase().includes("mihomo");
  } catch {
    return true; // /proc 不可用 → 保持原 kill 探活结果
  }
}

export async function startMihomo(config: RuntimeConfig): Promise<MihomoStatus> {
  const status = await readMihomoStatus(config);
  if (status.running) {
    return status;
  }

  await mkdir(dirname(config.mihomoPidPath), { recursive: true });
  await mkdir(dirname(config.mihomoLogPath), { recursive: true });

  if (!existsSync(config.mihomoConfigPath)) {
    throw new Error(`Mihomo config does not exist: ${config.mihomoConfigPath}`);
  }

  const logFd = openSync(config.mihomoLogPath, "a");
  const child = spawn(config.mihomoBin, ["-d", config.dataDir, "-f", config.mihomoConfigPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  closeSync(logFd);

  if (!child.pid) {
    throw new Error("Failed to start Mihomo");
  }

  await writeFile(config.mihomoPidPath, `${child.pid}\n`);
  return { running: true, pid: child.pid };
}

export async function stopMihomo(config: RuntimeConfig): Promise<MihomoStatus> {
  const status = await readMihomoStatus(config);
  if (!status.running || !status.pid) {
    return { running: false };
  }
  process.kill(status.pid, "SIGTERM");
  await rm(config.mihomoPidPath, { force: true });
  return { running: false };
}

export async function reloadMihomo(config: RuntimeConfig): Promise<MihomoStatus> {
  const status = await readMihomoStatus(config);
  if (!status.running || !status.pid) {
    return startMihomo(config);
  }
  process.kill(status.pid, "SIGHUP");
  return status;
}
