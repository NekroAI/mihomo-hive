import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  defaultRuntimeConfig,
  parseRuntimeConfig,
  type RuntimeConfig
} from "@mihomo-hive/schemas";

export function resolveConfigPath(pathFromEnv = process.env.HIVE_CONFIG): string {
  return resolve(pathFromEnv ?? "runtime/hive.config.json");
}

export async function loadRuntimeConfig(configPath = resolveConfigPath()): Promise<RuntimeConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parseRuntimeConfig(JSON.parse(raw));
    return {
      ...parsed,
      dataDir: process.env.HIVE_DATA_DIR ?? parsed.dataDir,
      mihomoBin: process.env.MIHOMO_BIN ?? parsed.mihomoBin
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return {
      ...defaultRuntimeConfig,
      dataDir: process.env.HIVE_DATA_DIR ?? defaultRuntimeConfig.dataDir,
      mihomoBin: process.env.MIHOMO_BIN ?? defaultRuntimeConfig.mihomoBin
    };
  }
}

export async function writeRuntimeConfig(
  config: RuntimeConfig,
  configPath = resolveConfigPath()
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(parseRuntimeConfig(config), null, 2)}\n`);
}
