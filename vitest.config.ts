import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    // Playwright e2e specs are in apps/web/e2e and must not be collected by vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"]
  },
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
