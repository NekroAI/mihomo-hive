import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadRuntimeConfig, renderMihomoConfig } from "@mihomo-hive/core";
import { openSqlite, HiveRepository } from "@mihomo-hive/db";
import { exportSub2Api } from "@mihomo-hive/exporters";
import { appRouter } from "./router.js";

const config = await loadRuntimeConfig();
const sqlite = openSqlite(config.databasePath);
const repo = new HiveRepository(sqlite, { subscriptionUserAgent: config.subscriptionUserAgent });
const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/api/exports/sub2api", (c) => {
  const host = c.req.query("host") ?? config.exportHost;
  return c.json(exportSub2Api(repo.listNodes(), { host }));
});

app.post("/api/mihomo/render", async (c) => {
  const rendered = renderMihomoConfig(repo.listNodes(), config);
  await writeGenerated(config.mihomoConfigPath, rendered.yaml);
  await writeGenerated(`${config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
  return c.json({ listeners: rendered.egressMap.length });
});

app.use("/trpc/*", async (c) =>
  fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => ({ config, repo })
  })
);

const staticRoot = resolve("apps/web/dist");
app.use("/*", serveStatic({ root: staticRoot }));

const host = process.env.HIVE_HOST ?? "127.0.0.1";
const port = Number(process.env.HIVE_PORT ?? 9990);

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`Mihomo Hive listening on http://${info.address}:${info.port}`);
});

async function writeGenerated(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
