import { readFile } from "node:fs/promises";
import {
  defaultOrchestrationSpec,
  orchestrationSpecSchema,
  reconcileTickSchema,
  sub2ApiConnectionConfigSchema,
  sub2ApiProtectedProxyRuleSchema
} from "@mihomo-hive/schemas";
import type {
  NodeIntentRole,
  NodeLifecycleStatus,
  OrchestrationSpec,
  ProxyNode,
  ReconcileTick,
  ReconcileTickSummary,
  Sub2ApiConnectionConfig,
  Sub2ApiProtectedProxyRule,
  Sub2ApiSafeConnectionConfig,
  SubscriptionSource
} from "@mihomo-hive/schemas";
import type { HiveSqlite } from "./client.js";

interface PasswordHash {
  algorithm: "scrypt";
  salt: string;
  hash: string;
  keyLength: number;
}

interface SubscriptionRow {
  id: string;
  name: string;
  kind: "url" | "file";
  value: string;
  enabled: 0 | 1;
  last_content: string | null;
  exclude_keywords: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  hash: string;
  source_id: string;
  name: string;
  original_name: string;
  type: string;
  region: string;
  raw_json: string;
  status: ProxyNode["status"];
  lifecycle_status: NodeLifecycleStatus;
  schedulable: 0 | 1;
  protected: 0 | 1;
  sub2api_proxy_id: number | null;
  quality_score: number | null;
  assigned_port: number | null;
  last_test_status: string | null;
  last_test_latency_ms: number | null;
  intent_role: NodeIntentRole;
  backoff_until: string | null;
  backoff_attempts: number;
  health_score: number | null;
  last_health_check: string | null;
  created_at: string;
  updated_at: string;
}

interface ReconcileTickRow {
  id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  enabled: 0 | 1;
  skipped_reason: string;
  error_message: string | null;
  planned_total: number;
  applied_total: number;
  observed_json: string;
  node_intents_json: string;
  planned_changes_json: string;
  applied_changes_json: string;
  operation_id: string | null;
}

interface AuthSessionRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
}

const authPasswordSettingKey = "auth.password";
const sub2ApiConnectionSettingKey = "sub2api.connection";
const sub2ApiProtectedRuleSettingKey = "sub2api.protectedRule";
const orchestrationSpecSettingKey = "orchestration.spec";

export class HiveRepository {
  constructor(
    private readonly sqlite: HiveSqlite,
    private readonly options: { subscriptionUserAgent?: string } = {}
  ) {}

  addSubscription(input: {
    id: string;
    name: string;
    kind: "url" | "file";
    value: string;
  }): SubscriptionSource {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `
        INSERT INTO subscriptions (id, name, kind, value, enabled, exclude_keywords, created_at, updated_at)
        VALUES (@id, @name, @kind, @value, 1, '[]', @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          kind = excluded.kind,
          value = excluded.value,
          enabled = 1,
          updated_at = excluded.updated_at
      `
      )
      .run({ ...input, now });
    return {
      id: input.id,
      name: input.name,
      kind: input.kind,
      value: input.value,
      enabled: true,
      excludeKeywords: [],
      createdAt: now,
      updatedAt: now
    };
  }

  listSubscriptions(): SubscriptionSource[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM subscriptions ORDER BY created_at ASC")
      .all() as SubscriptionRow[];
    return rows.map(subscriptionFromRow);
  }

  async fetchSubscriptionContent(source: SubscriptionSource): Promise<string> {
    if (source.kind === "file") {
      return readFile(source.value, "utf8");
    }
    const response = await fetch(source.value, {
      headers: {
        "User-Agent": this.options.subscriptionUserAgent ?? "Clash.Meta",
        Accept: "text/yaml, application/yaml, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch subscription ${source.name}: HTTP ${response.status}`);
    }
    return response.text();
  }

  updateSubscriptionContent(id: string, content: string): void {
    this.sqlite
      .prepare("UPDATE subscriptions SET last_content = ?, updated_at = ? WHERE id = ?")
      .run(content, new Date().toISOString(), id);
  }

  updateSubscriptionFilters(id: string, excludeKeywords: string[]): SubscriptionSource {
    const keywords = normalizeKeywords(excludeKeywords);
    this.sqlite
      .prepare("UPDATE subscriptions SET exclude_keywords = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(keywords), new Date().toISOString(), id);
    const row = this.sqlite.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined;
    if (!row) {
      throw new Error(`Subscription not found: ${id}`);
    }
    return subscriptionFromRow(row);
  }

  deleteSubscription(id: string): void {
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM nodes WHERE source_id = ?").run(id);
      this.sqlite.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
    });
    transaction();
  }

  upsertNodes(nodes: ProxyNode[]): void {
    const statement = this.sqlite.prepare(`
      INSERT INTO nodes (
        hash, source_id, name, original_name, type, region, raw_json, status,
        lifecycle_status, schedulable, protected, sub2api_proxy_id, quality_score,
        assigned_port, last_test_status, last_test_latency_ms,
        intent_role, backoff_until, backoff_attempts, health_score, last_health_check,
        created_at, updated_at
      )
      VALUES (
        @hash, @sourceId, @name, @originalName, @type, @region, @rawJson, @status,
        @lifecycleStatus, @schedulable, @protected, @sub2apiProxyId, @qualityScore,
        @assignedPort, @lastTestStatus, @lastTestLatencyMs,
        @intentRole, @backoffUntil, @backoffAttempts, @healthScore, @lastHealthCheck,
        @createdAt, @updatedAt
      )
      ON CONFLICT(hash) DO UPDATE SET
        source_id = excluded.source_id,
        name = excluded.name,
        original_name = excluded.original_name,
        type = excluded.type,
        region = excluded.region,
        raw_json = excluded.raw_json,
        lifecycle_status = CASE
          WHEN nodes.lifecycle_status IN ('deleted', 'retired') THEN nodes.lifecycle_status
          ELSE excluded.lifecycle_status
        END,
        updated_at = excluded.updated_at
    `);

    const transaction = this.sqlite.transaction((items: ProxyNode[]) => {
      for (const node of items) {
        statement.run({
          hash: node.hash,
          sourceId: node.sourceId,
          name: node.name,
          originalName: node.originalName,
          type: node.type,
          region: node.region,
          rawJson: JSON.stringify(node.raw),
          status: node.status,
          lifecycleStatus: node.lifecycleStatus ?? lifecycleFromStatus(node.status),
          schedulable: node.schedulable ? 1 : 0,
          protected: node.protected ? 1 : 0,
          sub2apiProxyId: node.sub2apiProxyId ?? null,
          qualityScore: node.qualityScore ?? null,
          assignedPort: node.assignedPort ?? null,
          lastTestStatus: node.lastTestStatus ?? null,
          lastTestLatencyMs: node.lastTestLatencyMs ?? null,
          intentRole: node.intentRole ?? intentFromLifecycle(node.lifecycleStatus ?? lifecycleFromStatus(node.status)),
          backoffUntil: node.backoffUntil ?? null,
          backoffAttempts: node.backoffAttempts ?? 0,
          healthScore: node.healthScore ?? null,
          lastHealthCheck: node.lastHealthCheck ?? null,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt
        });
      }
    });

    transaction(nodes);
  }

  listNodes(): ProxyNode[] {
    const rows = this.sqlite.prepare("SELECT * FROM nodes ORDER BY assigned_port, name").all() as NodeRow[];
    return rows.map(nodeFromRow);
  }

  saveNodes(nodes: ProxyNode[]): void {
    const statement = this.sqlite.prepare(`
      UPDATE nodes SET
        name = @name,
        status = @status,
        lifecycle_status = @lifecycleStatus,
        schedulable = @schedulable,
        protected = @protected,
        sub2api_proxy_id = @sub2apiProxyId,
        quality_score = @qualityScore,
        assigned_port = @assignedPort,
        last_test_status = @lastTestStatus,
        last_test_latency_ms = @lastTestLatencyMs,
        intent_role = @intentRole,
        backoff_until = @backoffUntil,
        backoff_attempts = @backoffAttempts,
        health_score = @healthScore,
        last_health_check = @lastHealthCheck,
        updated_at = @updatedAt
      WHERE hash = @hash
    `);

    const transaction = this.sqlite.transaction((items: ProxyNode[]) => {
      for (const node of items) {
        statement.run({
          hash: node.hash,
          name: node.name,
          status: node.status,
          lifecycleStatus: node.lifecycleStatus ?? lifecycleFromStatus(node.status),
          schedulable: node.schedulable ? 1 : 0,
          protected: node.protected ? 1 : 0,
          sub2apiProxyId: node.sub2apiProxyId ?? null,
          qualityScore: node.qualityScore ?? null,
          assignedPort: node.assignedPort ?? null,
          lastTestStatus: node.lastTestStatus ?? null,
          lastTestLatencyMs: node.lastTestLatencyMs ?? null,
          intentRole: node.intentRole ?? intentFromLifecycle(node.lifecycleStatus ?? lifecycleFromStatus(node.status)),
          backoffUntil: node.backoffUntil ?? null,
          backoffAttempts: node.backoffAttempts ?? 0,
          healthScore: node.healthScore ?? null,
          lastHealthCheck: node.lastHealthCheck ?? null,
          updatedAt: new Date().toISOString()
        });
      }
    });

    transaction(nodes);
  }

  setAllUntestedActive(): void {
    this.sqlite
      .prepare("UPDATE nodes SET status = 'active', lifecycle_status = 'schedulable', schedulable = 1 WHERE status = 'untested'")
      .run();
  }

  deleteNodes(hashes: string[]): number {
    if (hashes.length === 0) {
      return 0;
    }
    const statement = this.sqlite.prepare("DELETE FROM nodes WHERE hash = ?");
    const transaction = this.sqlite.transaction((items: string[]) => {
      let deleted = 0;
      for (const hash of items) {
        deleted += statement.run(hash).changes;
      }
      return deleted;
    });
    return transaction(hashes) as number;
  }

  markNodesLifecycle(hashes: string[], lifecycleStatus: NodeLifecycleStatus): ProxyNode[] {
    if (hashes.length === 0) {
      return [];
    }
    const status = statusFromLifecycle(lifecycleStatus);
    const schedulable = lifecycleStatus === "schedulable" ? 1 : 0;
    const statement = this.sqlite.prepare(`
      UPDATE nodes SET
        lifecycle_status = @lifecycleStatus,
        status = @status,
        schedulable = @schedulable,
        assigned_port = CASE WHEN @schedulable = 1 THEN assigned_port ELSE assigned_port END,
        updated_at = @updatedAt
      WHERE hash = @hash
    `);
    const now = new Date().toISOString();
    const transaction = this.sqlite.transaction((items: string[]) => {
      for (const hash of items) {
        statement.run({ hash, lifecycleStatus, status, schedulable, updatedAt: now });
      }
    });
    transaction(hashes);
    const wanted = new Set(hashes);
    return this.listNodes().filter((node) => wanted.has(node.hash));
  }

  updateSub2ApiProxyMappings(mappings: Array<{ hash: string; proxyId: number }>): void {
    const statement = this.sqlite.prepare("UPDATE nodes SET sub2api_proxy_id = ?, updated_at = ? WHERE hash = ?");
    const now = new Date().toISOString();
    const transaction = this.sqlite.transaction((items: Array<{ hash: string; proxyId: number }>) => {
      for (const item of items) {
        statement.run(item.proxyId, now, item.hash);
      }
    });
    transaction(mappings);
  }

  getPasswordHash(): PasswordHash | undefined {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(authPasswordSettingKey) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as PasswordHash) : undefined;
  }

  hasPassword(): boolean {
    return Boolean(this.getPasswordHash());
  }

  setPasswordHash(hash: PasswordHash): void {
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(authPasswordSettingKey, JSON.stringify(hash));
  }

  resetPassword(hash: PasswordHash): void {
    const transaction = this.sqlite.transaction(() => {
      this.setPasswordHash(hash);
      this.sqlite.prepare("DELETE FROM auth_sessions").run();
    });
    transaction();
  }

  createSession(input: { id: string; tokenHash: string; expiresAt: string }): void {
    this.deleteExpiredSessions();
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `
        INSERT INTO auth_sessions (id, token_hash, created_at, expires_at)
        VALUES (@id, @tokenHash, @now, @expiresAt)
      `
      )
      .run({ ...input, now });
  }

  findSessionByTokenHash(tokenHash: string): AuthSessionRow | undefined {
    this.deleteExpiredSessions();
    return this.sqlite
      .prepare("SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, new Date().toISOString()) as AuthSessionRow | undefined;
  }

  deleteSessionByTokenHash(tokenHash: string): void {
    this.sqlite.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteExpiredSessions(): void {
    this.sqlite.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }

  getSub2ApiConnection(): Sub2ApiConnectionConfig | undefined {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(sub2ApiConnectionSettingKey) as { value_json: string } | undefined;
    return row ? sub2ApiConnectionConfigSchema.parse(JSON.parse(row.value_json)) : undefined;
  }

  getSafeSub2ApiConnection(): Sub2ApiSafeConnectionConfig {
    const connection = this.getSub2ApiConnection();
    return {
      configured: Boolean(connection),
      ...(connection
        ? {
            baseUrl: connection.baseUrl,
            timezone: connection.timezone,
            managedProxyPrefix: connection.managedProxyPrefix
          }
        : {}),
      apiKeyConfigured: Boolean(connection?.adminApiKey)
    };
  }

  setSub2ApiConnection(config: Sub2ApiConnectionConfig): void {
    const parsed = sub2ApiConnectionConfigSchema.parse(config);
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(sub2ApiConnectionSettingKey, JSON.stringify(parsed));
  }

  getSub2ApiProtectedRule(): Sub2ApiProtectedProxyRule {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(sub2ApiProtectedRuleSettingKey) as { value_json: string } | undefined;
    return sub2ApiProtectedProxyRuleSchema.parse(row ? JSON.parse(row.value_json) : {});
  }

  setSub2ApiProtectedRule(rule: Sub2ApiProtectedProxyRule): void {
    const parsed = sub2ApiProtectedProxyRuleSchema.parse(rule);
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(sub2ApiProtectedRuleSettingKey, JSON.stringify(parsed));
  }

  // —— OrchestrationSpec (ADR 0003) ——

  getOrchestrationSpec(): OrchestrationSpec {
    const row = this.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(orchestrationSpecSettingKey) as { value_json: string } | undefined;
    if (!row) {
      return defaultOrchestrationSpec;
    }
    try {
      return orchestrationSpecSchema.parse(JSON.parse(row.value_json));
    } catch {
      // schema 升级后旧数据无法 parse，退回默认值，避免崩
      return defaultOrchestrationSpec;
    }
  }

  saveOrchestrationSpec(spec: OrchestrationSpec): OrchestrationSpec {
    const parsed = orchestrationSpecSchema.parse(spec);
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `
      )
      .run(orchestrationSpecSettingKey, JSON.stringify(parsed));
    return parsed;
  }

  // —— Reconcile tick 持久化 ——

  appendReconcileTick(tick: ReconcileTick): void {
    this.sqlite
      .prepare(
        `
        INSERT INTO reconcile_ticks (
          id, started_at, finished_at, duration_ms, enabled,
          skipped_reason, error_message, planned_total, applied_total,
          observed_json, node_intents_json, planned_changes_json,
          applied_changes_json, operation_id
        ) VALUES (
          @id, @startedAt, @finishedAt, @durationMs, @enabled,
          @skippedReason, @errorMessage, @plannedTotal, @appliedTotal,
          @observedJson, @nodeIntentsJson, @plannedChangesJson,
          @appliedChangesJson, @operationId
        )
      `
      )
      .run({
        id: tick.id,
        startedAt: tick.startedAt,
        finishedAt: tick.finishedAt,
        durationMs: tick.durationMs,
        enabled: tick.enabled ? 1 : 0,
        skippedReason: tick.skippedReason,
        errorMessage: tick.errorMessage ?? null,
        plannedTotal: tick.plannedTotal,
        appliedTotal: tick.appliedTotal,
        observedJson: JSON.stringify(tick.observedSummary),
        nodeIntentsJson: JSON.stringify(tick.nodeIntents),
        plannedChangesJson: JSON.stringify(tick.plannedChanges),
        appliedChangesJson: JSON.stringify(tick.appliedChanges),
        operationId: tick.operationId ?? null
      });
  }

  listRecentReconcileTicks(limit = 20): ReconcileTick[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM reconcile_ticks ORDER BY started_at DESC LIMIT ?")
      .all(limit) as ReconcileTickRow[];
    return rows.map(reconcileTickFromRow);
  }

  /**
   * 只读 tick 的摘要字段，跳过 4 个 JSON 大列 + 不走 zod schema parse。
   * 用于历史列表展示；单条详情走 getReconcileTick(id)。
   *
   * 性能：500 条记录从原来的 ~500ms（JSON.parse × 2000 + zod × 500）降到 ~5ms。
   */
  listRecentReconcileTickSummaries(limit = 200): ReconcileTickSummary[] {
    const rows = this.sqlite
      .prepare(
        "SELECT id, started_at, finished_at, duration_ms, enabled, planned_total, applied_total, skipped_reason, error_message FROM reconcile_ticks ORDER BY started_at DESC LIMIT ?"
      )
      .all(limit) as Array<{
      id: string;
      started_at: string;
      finished_at: string;
      duration_ms: number;
      enabled: number;
      planned_total: number;
      applied_total: number;
      skipped_reason: ReconcileTick["skippedReason"];
      error_message: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      enabled: Boolean(row.enabled),
      plannedTotal: row.planned_total,
      appliedTotal: row.applied_total,
      skippedReason: row.skipped_reason,
      ...(row.error_message ? { errorMessage: row.error_message } : {})
    }));
  }

  getReconcileTick(id: string): ReconcileTick | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM reconcile_ticks WHERE id = ? LIMIT 1")
      .get(id) as ReconcileTickRow | undefined;
    return row ? reconcileTickFromRow(row) : undefined;
  }

  /** SQL 聚合统计 24h 内 applied 类型变更总数（rebalance_overload / drift_correction / rebind_dead）。
   *  避免在 JS 层 reduce 500 条 ticks。 */
  countDriftAppliedChanges(sinceIso: string): number {
    // appliedChanges JSON 字段无法直接用 SQL 聚合 kind 字段，只能拉 applied_changes_json 列
    // 但 better-sqlite3 的 JSON1 扩展可用 json_each。如果不可用就退化为 JS reduce。
    try {
      const result = this.sqlite
        .prepare(
          `SELECT COUNT(*) as count FROM reconcile_ticks, json_each(reconcile_ticks.applied_changes_json) AS change
           WHERE reconcile_ticks.started_at >= ?
             AND json_extract(change.value, '$.kind') IN ('rebalance_overload', 'drift_correction', 'rebind_dead')`
        )
        .get(sinceIso) as { count: number } | undefined;
      return result?.count ?? 0;
    } catch {
      // JSON1 不可用，退化：只拉这一列做 JS reduce
      const rows = this.sqlite
        .prepare(
          "SELECT applied_changes_json FROM reconcile_ticks WHERE started_at >= ?"
        )
        .all(sinceIso) as Array<{ applied_changes_json: string }>;
      let total = 0;
      for (const row of rows) {
        try {
          const changes = JSON.parse(row.applied_changes_json) as Array<{ kind: string }>;
          total += changes.filter(
            (c) => c.kind === "rebalance_overload" || c.kind === "drift_correction" || c.kind === "rebind_dead"
          ).length;
        } catch {
          // skip
        }
      }
      return total;
    }
  }

  pruneReconcileTicks(keepDays = 7): number {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    return this.sqlite.prepare("DELETE FROM reconcile_ticks WHERE started_at < ?").run(cutoff).changes;
  }
}

function subscriptionFromRow(row: SubscriptionRow): SubscriptionSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    value: row.value,
    enabled: Boolean(row.enabled),
    ...(row.last_content ? { lastContent: row.last_content } : {}),
    excludeKeywords: parseKeywords(row.exclude_keywords),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseKeywords(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeKeywords(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return [];
  }
}

function normalizeKeywords(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function nodeFromRow(row: NodeRow): ProxyNode {
  return {
    hash: row.hash,
    sourceId: row.source_id,
    name: row.name,
    originalName: row.original_name,
    type: row.type,
    region: row.region,
    raw: JSON.parse(row.raw_json) as Record<string, unknown>,
    status: row.status,
    lifecycleStatus: row.lifecycle_status ?? lifecycleFromStatus(row.status),
    schedulable: Boolean(row.schedulable),
    protected: Boolean(row.protected),
    ...(row.sub2api_proxy_id ? { sub2apiProxyId: row.sub2api_proxy_id } : {}),
    ...(row.quality_score === null ? {} : { qualityScore: row.quality_score }),
    ...(row.assigned_port ? { assignedPort: row.assigned_port } : {}),
    ...(row.last_test_status ? { lastTestStatus: row.last_test_status } : {}),
    ...(row.last_test_latency_ms ? { lastTestLatencyMs: row.last_test_latency_ms } : {}),
    intentRole: row.intent_role ?? intentFromLifecycle(row.lifecycle_status),
    backoffUntil: row.backoff_until,
    backoffAttempts: row.backoff_attempts ?? 0,
    healthScore: row.health_score,
    lastHealthCheck: row.last_health_check,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function intentFromLifecycle(lifecycle: NodeLifecycleStatus): NodeIntentRole {
  switch (lifecycle) {
    case "schedulable":
      return "serving";
    case "candidate":
    case "testing":
    case "disabled":
      return "standby";
    case "draining":
    case "cooling_down":
      return "quarantined";
    case "retired":
    case "deleted":
      return "evicted";
    default:
      return "standby";
  }
}

function reconcileTickFromRow(row: ReconcileTickRow): ReconcileTick {
  return reconcileTickSchema.parse({
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    enabled: Boolean(row.enabled),
    skippedReason: row.skipped_reason,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    plannedTotal: row.planned_total,
    appliedTotal: row.applied_total,
    observedSummary: JSON.parse(row.observed_json),
    nodeIntents: JSON.parse(row.node_intents_json),
    plannedChanges: JSON.parse(row.planned_changes_json),
    appliedChanges: JSON.parse(row.applied_changes_json),
    ...(row.operation_id ? { operationId: row.operation_id } : {})
  });
}

function lifecycleFromStatus(status: ProxyNode["status"]): NodeLifecycleStatus {
  switch (status) {
    case "active":
      return "schedulable";
    case "inactive":
      return "disabled";
    case "failed":
      return "cooling_down";
    case "untested":
      return "candidate";
    default:
      return "candidate";
  }
}

function statusFromLifecycle(lifecycleStatus: NodeLifecycleStatus): ProxyNode["status"] {
  switch (lifecycleStatus) {
    case "schedulable":
      return "active";
    case "cooling_down":
      return "failed";
    case "candidate":
    case "testing":
      return "untested";
    case "disabled":
    case "draining":
    case "retired":
    case "deleted":
      return "inactive";
    default:
      return "inactive";
  }
}
