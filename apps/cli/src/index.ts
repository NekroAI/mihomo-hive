#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import {
  assignStablePorts,
  enumeratePorts,
  findOccupiedPorts,
  loadRuntimeConfig,
  parsePortRange,
  parseSubscription,
  renderMihomoConfig,
  resolveConfigPath,
  writeRuntimeConfig
} from "@mihomo-hive/core";
import { openSqlite, HiveRepository } from "@mihomo-hive/db";
import { exportSub2Api } from "@mihomo-hive/exporters";
import { readMihomoStatus, reloadMihomo, startMihomo, stopMihomo } from "@mihomo-hive/mihomo";
import { defaultRuntimeConfig, parseRuntimeConfig } from "@mihomo-hive/schemas";
import type { SubscriptionSource } from "@mihomo-hive/schemas";

const program = new Command();

program.name("hive").description("Mihomo Hive fixed-egress proxy pool manager").version("0.1.0");

program
  .command("init")
  .description("Create a default runtime config")
  .option("--config <path>", "Config path")
  .option("--listen-host <host>", "Mihomo listener bind host", "127.0.0.1")
  .option("--export-host <host>", "Host written to Sub2API exports", "127.0.0.1")
  .option("--range <range>", "Port range", "10001-10300")
  .action(async (options) => {
    const range = parsePortRange(options.range as string);
    const config = parseRuntimeConfig({
      ...defaultRuntimeConfig,
      listenHost: options.listenHost,
      exportHost: options.exportHost,
      portRangeStart: range.start,
      portRangeEnd: range.end
    });
    await writeRuntimeConfig(config, options.config ?? resolveConfigPath());
    console.log(`Created config: ${options.config ?? resolveConfigPath()}`);
  });

const sub = program.command("sub").description("Manage subscriptions");

sub
  .command("add")
  .requiredOption("--name <name>", "Subscription name")
  .option("--url <url>", "Subscription URL")
  .option("--file <file>", "Subscription file")
  .action(async (options) => {
    if (!options.url && !options.file) {
      throw new Error("Provide --url or --file");
    }
    const { repo } = await openRepo();
    const source = repo.addSubscription({
      id: randomUUID(),
      name: options.name,
      kind: options.url ? "url" : "file",
      value: options.url ?? options.file
    });
    console.log(
      JSON.stringify(
        {
          ...source,
          value: source.kind === "url" ? redactUrl(source.value) : source.value
        },
        null,
        2
      )
    );
  });

sub
  .command("list")
  .description("List subscriptions")
  .action(async () => {
    const { repo } = await openRepo();
    console.log(JSON.stringify(repo.listSubscriptions().map(summarizeSubscription), null, 2));
  });

sub
  .command("fetch")
  .description("Fetch enabled subscriptions")
  .action(async () => {
    const { repo } = await openRepo();
    const sources = repo.listSubscriptions().filter((source) => source.enabled);
    for (const source of sources) {
      const content = await repo.fetchSubscriptionContent(source);
      repo.updateSubscriptionContent(source.id, content);
      console.log(`Fetched ${source.name}: ${content.length} bytes`);
    }
  });

const nodes = program.command("nodes").description("Manage nodes");

nodes
  .command("import")
  .description("Parse fetched subscription content and upsert nodes")
  .action(async () => {
    const { repo } = await openRepo();
    let imported = 0;
    for (const source of repo.listSubscriptions().filter((item) => item.enabled)) {
      const content = source.lastContent ?? (await repo.fetchSubscriptionContent(source));
      const parsed = parseSubscription(content, source.id);
      repo.upsertNodes(parsed);
      imported += parsed.length;
      console.log(`Imported ${parsed.length} nodes from ${source.name}`);
    }
    console.log(`Total imported: ${imported}`);
  });

nodes
  .command("list")
  .description("List normalized nodes")
  .option("--json", "Print full JSON")
  .action(async (options) => {
    const { repo } = await openRepo();
    const all = repo.listNodes();
    if (options.json) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    for (const node of all) {
      console.log(
        `${node.assignedPort ?? "-"}\t${node.status}\t${node.region}\t${node.type}\t${node.name}\t${node.hash.slice(0, 8)}`
      );
    }
  });

const ports = program.command("ports").description("Manage local egress ports");

ports
  .command("assign")
  .description("Assign stable ports to active/untested nodes")
  .option("--range <range>", "Port range override")
  .option("--skip-port-check", "Do not probe occupied ports")
  .action(async (options) => {
    const { config, repo } = await openRepo();
    repo.setAllUntestedActive();
    const range = options.range
      ? parsePortRange(options.range)
      : { start: config.portRangeStart, end: config.portRangeEnd };
    const portList = enumeratePorts(range);
    const occupied = options.skipPortCheck ? new Set<number>() : await findOccupiedPorts(config.listenHost, portList);
    const nodesWithPorts = assignStablePorts({
      nodes: repo.listNodes(),
      range,
      occupiedPorts: occupied
    });
    repo.saveNodes(nodesWithPorts);
    console.log(`Assigned ports in ${range.start}-${range.end}; occupied skipped: ${occupied.size}`);
  });

const mihomo = program.command("mihomo").description("Render and control Mihomo");

mihomo
  .command("render")
  .description("Render generated/mihomo.yaml and egress-map.json")
  .action(async () => {
    const { config, repo } = await openRepo();
    const rendered = renderMihomoConfig(repo.listNodes(), config);
    await writeGenerated(config.mihomoConfigPath, rendered.yaml);
    await writeGenerated(`${config.generatedDir}/egress-map.json`, JSON.stringify(rendered.egressMap, null, 2));
    console.log(`Rendered ${rendered.egressMap.length} listeners to ${config.mihomoConfigPath}`);
  });

mihomo.command("start").action(async () => console.log(JSON.stringify(await startMihomo((await openRepo()).config), null, 2)));
mihomo.command("stop").action(async () => console.log(JSON.stringify(await stopMihomo((await openRepo()).config), null, 2)));
mihomo.command("reload").action(async () => console.log(JSON.stringify(await reloadMihomo((await openRepo()).config), null, 2)));
mihomo.command("status").action(async () => console.log(JSON.stringify(await readMihomoStatus((await openRepo()).config), null, 2)));

const exportCommand = program.command("export").description("Export generated formats");

exportCommand
  .command("sub2api")
  .description("Export Sub2API-compatible proxy JSON")
  .option("--host <host>", "Host written to proxy entries")
  .option("--output <file>", "Output file", "generated/sub2api-proxies.json")
  .action(async (options) => {
    const { config, repo } = await openRepo();
    const payload = exportSub2Api(repo.listNodes(), { host: options.host ?? config.exportHost });
    await writeGenerated(options.output, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Exported ${payload.proxies.length} proxies to ${options.output}`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function openRepo() {
  const config = await loadRuntimeConfig();
  const sqlite = openSqlite(config.databasePath);
  return {
    config,
    sqlite,
    repo: new HiveRepository(sqlite, { subscriptionUserAgent: config.subscriptionUserAgent })
  };
}

async function writeGenerated(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = url.search ? "?..." : "";
    return url.toString();
  } catch {
    return "<redacted>";
  }
}

function summarizeSubscription(source: SubscriptionSource) {
  const { lastContent, ...safeSource } = source;
  return {
    ...safeSource,
    value: source.kind === "url" ? redactUrl(source.value) : source.value,
    fetched: Boolean(lastContent),
    ...(lastContent ? { lastContentBytes: lastContent.length } : {})
  };
}
