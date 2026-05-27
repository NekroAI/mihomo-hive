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
      assigned_port INTEGER,
      last_test_status TEXT,
      last_test_latency_ms INTEGER,
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
  `);
  addColumnIfMissing(sqlite, "subscriptions", "exclude_keywords", "TEXT NOT NULL DEFAULT '[]'");
}

function addColumnIfMissing(sqlite: HiveSqlite, table: string, column: string, definition: string): void {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
