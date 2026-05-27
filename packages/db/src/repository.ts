import { readFile } from "node:fs/promises";
import { sub2ApiConnectionConfigSchema, sub2ApiProtectedProxyRuleSchema } from "@mihomo-hive/schemas";
import type {
  ProxyNode,
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
  assigned_port: number | null;
  last_test_status: string | null;
  last_test_latency_ms: number | null;
  created_at: string;
  updated_at: string;
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
        assigned_port, last_test_status, last_test_latency_ms, created_at, updated_at
      )
      VALUES (
        @hash, @sourceId, @name, @originalName, @type, @region, @rawJson, @status,
        @assignedPort, @lastTestStatus, @lastTestLatencyMs, @createdAt, @updatedAt
      )
      ON CONFLICT(hash) DO UPDATE SET
        source_id = excluded.source_id,
        name = excluded.name,
        original_name = excluded.original_name,
        type = excluded.type,
        region = excluded.region,
        raw_json = excluded.raw_json,
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
          assignedPort: node.assignedPort ?? null,
          lastTestStatus: node.lastTestStatus ?? null,
          lastTestLatencyMs: node.lastTestLatencyMs ?? null,
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
        assigned_port = @assignedPort,
        last_test_status = @lastTestStatus,
        last_test_latency_ms = @lastTestLatencyMs,
        updated_at = @updatedAt
      WHERE hash = @hash
    `);

    const transaction = this.sqlite.transaction((items: ProxyNode[]) => {
      for (const node of items) {
        statement.run({
          hash: node.hash,
          name: node.name,
          status: node.status,
          assignedPort: node.assignedPort ?? null,
          lastTestStatus: node.lastTestStatus ?? null,
          lastTestLatencyMs: node.lastTestLatencyMs ?? null,
          updatedAt: new Date().toISOString()
        });
      }
    });

    transaction(nodes);
  }

  setAllUntestedActive(): void {
    this.sqlite.prepare("UPDATE nodes SET status = 'active' WHERE status = 'untested'").run();
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
      ...(connection ? { baseUrl: connection.baseUrl, timezone: connection.timezone } : {}),
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
    ...(row.assigned_port ? { assignedPort: row.assigned_port } : {}),
    ...(row.last_test_status ? { lastTestStatus: row.last_test_status } : {}),
    ...(row.last_test_latency_ms ? { lastTestLatencyMs: row.last_test_latency_ms } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
