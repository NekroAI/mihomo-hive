import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mihomo-hive/core": r("./packages/core/src/index.ts"),
      "@mihomo-hive/db": r("./packages/db/src/index.ts"),
      "@mihomo-hive/exporters": r("./packages/exporters/src/index.ts"),
      "@mihomo-hive/mihomo": r("./packages/mihomo/src/index.ts"),
      "@mihomo-hive/schemas": r("./packages/schemas/src/index.ts")
    }
  }
});
