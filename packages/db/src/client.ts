import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type HiveSqlite = Database.Database;
export type HiveDb = ReturnType<typeof drizzle<typeof schema>>;

export function openSqlite(path: string): HiveSqlite {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  return sqlite;
}

export function openDrizzle(path: string): { sqlite: HiveSqlite; db: HiveDb } {
  const sqlite = openSqlite(path);
  return {
    sqlite,
    db: drizzle(sqlite, { schema })
  };
}

function ensureSchema(sqlite: HiveSqlite): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('url', 'file')),
      value TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_content TEXT,
      exclude_keywords TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      hash TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      type TEXT NOT NULL,
      region TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'untested', 'failed')),
      lifecycle_status TEXT NOT NULL DEFAULT 'candidate' CHECK (lifecycle_status IN ('candidate', 'testing', 'schedulable', 'disabled', 'draining', 'cooling_down', 'retired', 'deleted')),
      schedulable INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0,
      sub2api_proxy_id INTEGER,
      quality_score INTEGER,
      assigned_port INTEGER,
      last_test_status TEXT,
      last_test_latency_ms INTEGER,
      last_test_targets TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reconcile_ticks (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      skipped_reason TEXT NOT NULL,
      error_message TEXT,
      planned_total INTEGER NOT NULL DEFAULT 0,
      applied_total INTEGER NOT NULL DEFAULT 0,
      observed_json TEXT NOT NULL,
      node_intents_json TEXT NOT NULL,
      planned_changes_json TEXT NOT NULL,
      applied_changes_json TEXT NOT NULL,
      operation_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reconcile_ticks_started_at
      ON reconcile_ticks(started_at DESC);
  `);
  addColumnIfMissing(sqlite, "subscriptions", "exclude_keywords", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(sqlite, "nodes", "lifecycle_status", "TEXT NOT NULL DEFAULT 'candidate'");
  addColumnIfMissing(sqlite, "nodes", "schedulable", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "protected", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "sub2api_proxy_id", "INTEGER");
  addColumnIfMissing(sqlite, "nodes", "quality_score", "INTEGER");
  // ADR 0003: orchestration intent columns
  addColumnIfMissing(sqlite, "nodes", "intent_role", "TEXT NOT NULL DEFAULT 'standby'");
  addColumnIfMissing(sqlite, "nodes", "backoff_until", "TEXT");
  addColumnIfMissing(sqlite, "nodes", "backoff_attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "health_score", "INTEGER");
  addColumnIfMissing(sqlite, "nodes", "last_health_check", "TEXT");
  // P5-R: 每个测试目标（openai / claude / ...）的独立结果，JSON 数组字符串
  addColumnIfMissing(sqlite, "nodes", "last_test_targets", "TEXT");
  // Seed intent_role from lifecycle for nodes that pre-date this column.
  sqlite.exec(`
    UPDATE nodes
       SET intent_role = CASE
         WHEN lifecycle_status = 'schedulable' THEN 'serving'
         WHEN lifecycle_status IN ('disabled', 'candidate', 'testing') THEN 'standby'
         WHEN lifecycle_status IN ('cooling_down', 'draining') THEN 'quarantined'
         WHEN lifecycle_status IN ('retired', 'deleted') THEN 'evicted'
         ELSE intent_role
       END
     WHERE intent_role = 'standby' OR intent_role IS NULL;
  `);
  sqlite.exec(`
    UPDATE nodes
    SET lifecycle_status = CASE
      WHEN status = 'active' THEN 'schedulable'
      WHEN status = 'inactive' THEN 'disabled'
      WHEN status = 'failed' THEN 'cooling_down'
      ELSE lifecycle_status
    END
    WHERE lifecycle_status = 'candidate';

    UPDATE nodes
    SET schedulable = CASE WHEN lifecycle_status = 'schedulable' THEN 1 ELSE schedulable END;
  `);
}

function addColumnIfMissing(sqlite: HiveSqlite, table: string, column: string, definition: string): void {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
