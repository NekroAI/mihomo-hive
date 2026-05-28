import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["url", "file"] }).notNull(),
  value: text("value").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastContent: text("last_content"),
  excludeKeywords: text("exclude_keywords").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const nodes = sqliteTable("nodes", {
  hash: text("hash").primaryKey(),
  sourceId: text("source_id").notNull(),
  name: text("name").notNull(),
  originalName: text("original_name").notNull(),
  type: text("type").notNull(),
  region: text("region").notNull(),
  rawJson: text("raw_json").notNull(),
  status: text("status", { enum: ["active", "inactive", "untested", "failed"] }).notNull(),
  lifecycleStatus: text("lifecycle_status", {
    enum: ["candidate", "testing", "schedulable", "disabled", "draining", "cooling_down", "retired", "deleted"]
  })
    .notNull()
    .default("candidate"),
  schedulable: integer("schedulable", { mode: "boolean" }).notNull().default(false),
  protected: integer("protected", { mode: "boolean" }).notNull().default(false),
  sub2apiProxyId: integer("sub2api_proxy_id"),
  qualityScore: integer("quality_score"),
  assignedPort: integer("assigned_port"),
  lastTestStatus: text("last_test_status"),
  lastTestLatencyMs: integer("last_test_latency_ms"),
  lastTestTargets: text("last_test_targets"),
  // 编排意图（ADR 0003）
  intentRole: text("intent_role", { enum: ["serving", "standby", "quarantined", "evicted"] })
    .notNull()
    .default("standby"),
  backoffUntil: text("backoff_until"),
  backoffAttempts: integer("backoff_attempts").notNull().default(0),
  healthScore: integer("health_score"),
  lastHealthCheck: text("last_health_check"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const reconcileTicks = sqliteTable("reconcile_ticks", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  skippedReason: text("skipped_reason").notNull(),
  errorMessage: text("error_message"),
  plannedTotal: integer("planned_total").notNull().default(0),
  appliedTotal: integer("applied_total").notNull().default(0),
  observedJson: text("observed_json").notNull(),
  nodeIntentsJson: text("node_intents_json").notNull(),
  plannedChangesJson: text("planned_changes_json").notNull(),
  appliedChangesJson: text("applied_changes_json").notNull(),
  operationId: text("operation_id")
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull()
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull()
});
