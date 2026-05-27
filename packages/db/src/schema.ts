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
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
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
