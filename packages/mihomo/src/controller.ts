import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync } from "node:fs";
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
    return { running: true, pid };
  } catch {
    return { running: false };
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
