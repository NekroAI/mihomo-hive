#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import {
  assignStablePorts,
  createSub2ApiClient,
  enumeratePorts,
  findOccupiedPorts,
  groupAssignmentChangesByProxy,
  hashPassword,
  loadRuntimeConfig,
  mapWithConcurrency,
  parsePortRange,
  parseSubscription,
  planSub2ApiAssignments,
  renderMihomoConfig,
  resolveProxyTestTargets,
  resolveConfigPath,
  testProxyTarget,
  writeRuntimeConfig
} from "@mihomo-hive/core";
import { openSqlite, HiveRepository } from "@mihomo-hive/db";
import { exportSub2Api } from "@mihomo-hive/exporters";
import { readMihomoStatus, reloadMihomo, startMihomo, stopMihomo } from "@mihomo-hive/mihomo";
import { defaultRuntimeConfig, parseRuntimeConfig, sub2ApiAccountFiltersSchema, sub2ApiProtectedProxyRuleSchema } from "@mihomo-hive/schemas";
import type { Sub2ApiAssignmentOptions, SubscriptionSource } from "@mihomo-hive/schemas";

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

const auth = program.command("auth").description("Manage local access password");

auth
  .command("status")
  .description("Show whether an access password is configured")
  .action(async () => {
    const { repo } = await openRepo();
    console.log(JSON.stringify({ configured: repo.hasPassword() }, null, 2));
  });

auth
  .command("reset-password")
  .description("Reset the Web UI/API access password and revoke sessions")
  .option("--password <password>", "New password")
  .option("--password-stdin", "Read the new password from stdin")
  .action(async (options) => {
    const { repo } = await openRepo();
    const password = await readPasswordOption(options);
    repo.resetPassword(await hashPassword(password));
    console.log("Password reset; all sessions revoked.");
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

nodes
  .command("test")
  .description("Test assigned local listener ports and update node status")
  .option("--targets <targets>", "Comma-separated test targets: ip,openai,claude", "openai,claude")
  .option("--host <host>", "Listener host to test")
  .option("--timeout-ms <ms>", "Per-target timeout", parseIntegerOption, 15_000)
  .option("--concurrency <n>", "Parallel node tests", parseIntegerOption, 8)
  .action(async (options) => {
    const { config, repo } = await openRepo();
    const targets = resolveProxyTestTargets(
      String(options.targets)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    );
    const host = options.host ?? config.listenHost;
    const candidates = repo.listNodes().filter((node) => node.assignedPort);
    const tested = await mapWithConcurrency(candidates, options.concurrency, async (node) => {
      const results = [];
      for (const target of targets) {
        results.push(
          await testProxyTarget({
            host,
            port: Number(node.assignedPort),
            target,
            timeoutMs: options.timeoutMs
          })
        );
      }
      const passed = results.every((result) => result.ok);
      const statusText = results
        .map((result) => `${result.targetId}:${result.httpStatus ?? result.message}`)
        .join(",");
      const latencyMs = Math.max(...results.map((result) => result.latencyMs));
      console.log(`${node.assignedPort}\t${passed ? "pass" : "fail"}\t${statusText}\t${node.name}`);
      return {
        ...node,
        status: passed ? ("active" as const) : ("failed" as const),
        lastTestStatus: statusText,
        lastTestLatencyMs: latencyMs
      };
    });
    repo.saveNodes(tested);
    console.log(`Tested ${tested.length} nodes; passed: ${tested.filter((node) => node.status === "active").length}`);
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
      occupiedPorts: occupied,
      preserveExisting: false
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
  .option("--failed-node-status <status>", "Status for failed nodes: active or inactive", "inactive")
  .action(async (options) => {
    const { config, repo } = await openRepo();
    const payload = exportSub2Api(repo.listNodes(), {
      host: options.host ?? config.exportHost,
      failedNodeStatus: options.failedNodeStatus
    });
    await writeGenerated(options.output, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Exported ${payload.proxies.length} proxies to ${options.output}`);
  });

const sub2api = program.command("sub2api").description("Manage Sub2API integration");

sub2api
  .command("config")
  .description("Save Sub2API URL and admin API key")
  .requiredOption("--base-url <url>", "Sub2API base URL")
  .requiredOption("--api-key <key>", "Sub2API admin API key")
  .option("--timezone <timezone>", "Sub2API timezone", "Asia/Shanghai")
  .action(async (options) => {
    const { repo } = await openRepo();
    repo.setSub2ApiConnection({
      baseUrl: options.baseUrl,
      adminApiKey: options.apiKey,
      timezone: options.timezone
    });
    console.log(JSON.stringify(repo.getSafeSub2ApiConnection(), null, 2));
  });

sub2api
  .command("test")
  .description("Test Sub2API connection")
  .action(async () => {
    const client = createStoredSub2ApiClient((await openRepo()).repo);
    console.log(JSON.stringify(await client.testConnection(), null, 2));
  });

sub2api
  .command("preview")
  .description("Preview account to proxy assignment")
  .option("--platform <platform>", "Account platform", "openai")
  .option("--status <status>", "Account status", "active")
  .option("--type <type>", "Account type", "")
  .option("--group <group>", "Account group", "")
  .option("--search <search>", "Account search", "")
  .option("--protect-proxy-ids <ids>", "Comma-separated protected Sub2API proxy IDs", "")
  .option("--protect-name <text>", "Protect proxies whose name contains text", "")
  .option("--overwrite-existing", "Reassign non-protected accounts even when they already have an assignable proxy")
  .action(async (options) => {
    const { repo } = await openRepo();
    const preview = await previewSub2ApiAssignments(repo, buildSub2ApiAssignmentOptions(options));
    console.log(JSON.stringify(preview, null, 2));
  });

sub2api
  .command("apply")
  .description("Apply account to proxy assignment through Sub2API bulk-update")
  .option("--platform <platform>", "Account platform", "openai")
  .option("--status <status>", "Account status", "active")
  .option("--type <type>", "Account type", "")
  .option("--group <group>", "Account group", "")
  .option("--search <search>", "Account search", "")
  .option("--protect-proxy-ids <ids>", "Comma-separated protected Sub2API proxy IDs", "")
  .option("--protect-name <text>", "Protect proxies whose name contains text", "")
  .option("--overwrite-existing", "Reassign non-protected accounts even when they already have an assignable proxy")
  .action(async (options) => {
    const { repo } = await openRepo();
    const assignment = buildSub2ApiAssignmentOptions(options);
    const preview = await previewSub2ApiAssignments(repo, assignment);
    if (preview.errors.length > 0) {
      throw new Error(preview.errors.join("；"));
    }
    const client = createStoredSub2ApiClient(repo);
    let success = 0;
    let failed = 0;
    const successIds: number[] = [];
    const failedIds: number[] = [];
    for (const batch of groupAssignmentChangesByProxy(preview.changes)) {
      const result = await client.bulkUpdateProxy(batch.accountIds, batch.proxyId);
      success += result.success;
      failed += result.failed;
      successIds.push(...result.successIds);
      failedIds.push(...result.failedIds);
      console.log(`Updated proxy ${batch.proxyId}: success=${result.success}, failed=${result.failed}`);
    }
    console.log(JSON.stringify({ changed: preview.changes.length, success, failed, successIds, failedIds }, null, 2));
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

function createStoredSub2ApiClient(repo: HiveRepository) {
  const connection = repo.getSub2ApiConnection();
  if (!connection) {
    throw new Error("请先运行 hive sub2api config 配置 Sub2API。");
  }
  return createSub2ApiClient(connection);
}

async function previewSub2ApiAssignments(repo: HiveRepository, options: Sub2ApiAssignmentOptions) {
  const client = createStoredSub2ApiClient(repo);
  const [proxies, accounts] = await Promise.all([
    client.listAllProxies(),
    client.listAllAccounts(options.filters)
  ]);
  return planSub2ApiAssignments({ proxies, accounts, options });
}

function buildSub2ApiAssignmentOptions(options: Record<string, unknown>): Sub2ApiAssignmentOptions {
  return {
    filters: sub2ApiAccountFiltersSchema.parse({
      platform: options.platform,
      status: options.status,
      type: options.type,
      group: options.group,
      search: options.search
    }),
    protectedRule: sub2ApiProtectedProxyRuleSchema.parse({
      proxyIds: parseIdList(String(options.protectProxyIds ?? "")),
      nameIncludes: String(options.protectName ?? "")
    }),
    overwriteExisting: Boolean(options.overwriteExisting)
  };
}

function parseIdList(value: string): number[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const id = Number(item);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`Invalid proxy id: ${item}`);
      }
      return id;
    });
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

function parseIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

async function readPasswordOption(options: { password?: string; passwordStdin?: boolean }): Promise<string> {
  if (options.passwordStdin) {
    return (await readFile("/dev/stdin", "utf8")).trimEnd();
  }
  if (options.password) {
    return options.password;
  }
  if (process.env.HIVE_RESET_PASSWORD) {
    return process.env.HIVE_RESET_PASSWORD;
  }
  throw new Error("Provide --password, --password-stdin, or HIVE_RESET_PASSWORD");
}
