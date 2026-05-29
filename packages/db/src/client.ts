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

    -- ─── Account Fleet (notes/account-fleet-design.md) ───────────
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      external_id INTEGER,
      origin TEXT NOT NULL DEFAULT 'adopted_active'
        CHECK (origin IN ('hive_registered', 'adopted_active', 'adopted_recovered', 'adopted_observing', 'retired_legacy')),
      intent TEXT NOT NULL DEFAULT 'active'
        CHECK (intent IN ('pending', 'active', 'recovering', 'retired')),
      health TEXT NOT NULL DEFAULT 'unknown'
        CHECK (health IN ('healthy', 'rate_limited', 'quota_exhausted', 'broken', 'unknown')),
      email TEXT NOT NULL,
      organization_id TEXT,
      client_id TEXT,
      platform TEXT NOT NULL DEFAULT 'openai',
      type TEXT NOT NULL DEFAULT 'oauth',
      enc_phone TEXT,
      enc_password TEXT,
      enc_refresh_token TEXT,
      enc_access_token TEXT,
      enc_id_token TEXT,
      enc_recovery_input_json TEXT,
      last_observed_at TEXT,
      last_used_at TEXT,
      rate_limited_at TEXT,
      rate_limit_reset_at TEXT,
      quota_5h_percent INTEGER,
      quota_7d_percent INTEGER,
      errors_in_window INTEGER NOT NULL DEFAULT 0,
      broken_since_tick TEXT,
      broken_consecutive_ticks INTEGER NOT NULL DEFAULT 0,
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      next_recovery_after TEXT,
      last_recovery_error TEXT,
      last_recovery_path TEXT
        CHECK (last_recovery_path IS NULL OR last_recovery_path IN ('codex_login', 'codex_register')),
      last_recovery_failure_category TEXT
        CHECK (last_recovery_failure_category IS NULL
               OR last_recovery_failure_category IN ('account_unusable', 'network_or_proxy', 'oauth_failed')),
      batch_id TEXT,
      registered_at TEXT,
      sms_country TEXT,
      sms_cost_cents INTEGER,
      egress_node_hash TEXT,
      first_seen_at TEXT,
      relogin_count INTEGER NOT NULL DEFAULT 0,
      last_recovered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_external_id
      ON accounts(external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_accounts_origin_intent_health
      ON accounts(origin, intent, health);
    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
    CREATE INDEX IF NOT EXISTS idx_accounts_next_recovery
      ON accounts(next_recovery_after);

    CREATE TABLE IF NOT EXISTS account_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
        CHECK (kind IN ('codex_login', 'codex_register', 'import_to_sub2api',
                        'import_codex_tool_account',
                        'delete_sub2api', 'toggle_schedulable', 'observe_usage')),
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      scheduled_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'scheduler'
        CHECK (triggered_by IN ('scheduler', 'manual', 'adopter')),
      triggered_tick_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_jobs_dispatch
      ON account_jobs(status, scheduled_at, priority);
    CREATE INDEX IF NOT EXISTS idx_account_jobs_account
      ON account_jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_account_jobs_tick
      ON account_jobs(triggered_tick_id);

    CREATE TABLE IF NOT EXISTS account_fleet_ticks (
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
      planned_actions_json TEXT NOT NULL,
      applied_actions_json TEXT NOT NULL,
      triggered_job_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_account_fleet_ticks_started_at
      ON account_fleet_ticks(started_at DESC);

    CREATE TABLE IF NOT EXISTS account_budgets (
      window_key TEXT PRIMARY KEY,
      registrations_used INTEGER NOT NULL DEFAULT 0,
      registrations_budget INTEGER NOT NULL,
      sms_cost_cents INTEGER NOT NULL DEFAULT 0,
      reset_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
  // P5-AS: 节点 codex_login 实战反馈（能否过 Cloudflare Sentinel，区别于 openai 连通性测试）
  addColumnIfMissing(sqlite, "nodes", "codex_login_success", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "codex_login_failure", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "nodes", "codex_last_outcome", "TEXT");
  addColumnIfMissing(sqlite, "nodes", "codex_last_outcome_at", "TEXT");
  // P5-AS: 保留节点标记（专用于注册/登录的高质量备用出口）
  addColumnIfMissing(sqlite, "nodes", "codex_reserved", "INTEGER NOT NULL DEFAULT 0");
  // P5-AT: job 结束时持久化的日志末尾（redact 过），供"最近完成"回看
  addColumnIfMissing(sqlite, "account_jobs", "log_tail", "TEXT");
  // notes/account-fleet-design.md proxy-aware orchestration（增量 migration）：
  // 旧 accounts 表升级时补 egress_node_hash 字段
  addColumnIfMissing(sqlite, "accounts", "egress_node_hash", "TEXT");
  // P5-AI: 持久化 codex-tool 注册阶段返回的元信息（external-integration.md §"成本上限
  // 和选区策略" + §"OAuth 失败分类"）。三列都允许 NULL —— 老账号 / adopted 路径不会有。
  addColumnIfMissing(sqlite, "accounts", "sms_country", "TEXT");
  addColumnIfMissing(sqlite, "accounts", "sms_cost_cents", "INTEGER");
  addColumnIfMissing(sqlite, "accounts", "last_recovery_failure_category", "TEXT");
  // P5-AQ: 账号质量指标。first_seen_at 回填为 created_at（接管/创建时间）作首次时间兜底；
  // relogin_count 累计 codex_login 成功修复次数；last_recovered_at 最近一次修复成功时间。
  addColumnIfMissing(sqlite, "accounts", "first_seen_at", "TEXT");
  addColumnIfMissing(sqlite, "accounts", "relogin_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "accounts", "last_recovered_at", "TEXT");
  sqlite.exec("UPDATE accounts SET first_seen_at = created_at WHERE first_seen_at IS NULL;");
  // P5-AK/3: account_jobs.kind 加 import_codex_tool_account。SQLite 不能 ALTER CHECK，
  // 老 DB 必须 rebuild 表（rename → create → copy → drop → 重建 indexes）。
  rebuildAccountJobsCheckIfNeeded(sqlite);
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

/**
 * 重建 account_jobs 表，让 kind CHECK 接受新加的 'import_codex_tool_account'（P5-AK/3）。
 *
 * SQLite ALTER TABLE 不支持改 CHECK，只能 rename → create_new → copy → drop_old →
 * rename 回去。检测条件：用 sqlite_master 的 sql 字段判断 CHECK 是否含新 kind 字符串。
 * 已是新结构 → 跳过。
 */
function rebuildAccountJobsCheckIfNeeded(sqlite: HiveSqlite): void {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='account_jobs'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql) return;
  if (row.sql.includes("import_codex_tool_account")) return; // 已是新结构

  sqlite.exec(`
    BEGIN TRANSACTION;
    ALTER TABLE account_jobs RENAME TO account_jobs_old;
    CREATE TABLE account_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
        CHECK (kind IN ('codex_login', 'codex_register', 'import_to_sub2api',
                        'import_codex_tool_account',
                        'delete_sub2api', 'toggle_schedulable', 'observe_usage')),
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      scheduled_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'scheduler'
        CHECK (triggered_by IN ('scheduler', 'manual', 'adopter')),
      triggered_tick_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO account_jobs SELECT * FROM account_jobs_old;
    DROP TABLE account_jobs_old;
    CREATE INDEX IF NOT EXISTS idx_account_jobs_dispatch
      ON account_jobs(status, scheduled_at, priority);
    CREATE INDEX IF NOT EXISTS idx_account_jobs_account
      ON account_jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_account_jobs_tick
      ON account_jobs(triggered_tick_id);
    COMMIT;
  `);
}

function addColumnIfMissing(sqlite: HiveSqlite, table: string, column: string, definition: string): void {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
