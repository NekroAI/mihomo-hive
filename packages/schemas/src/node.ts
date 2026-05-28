import { z } from "zod";

export const nodeStatusSchema = z.enum(["active", "inactive", "untested", "failed"]);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const nodeLifecycleStatusSchema = z.enum([
  "candidate",
  "testing",
  "schedulable",
  "disabled",
  "draining",
  "cooling_down",
  "retired",
  "deleted"
]);
export type NodeLifecycleStatus = z.infer<typeof nodeLifecycleStatusSchema>;

export const subscriptionSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["url", "file"]),
  value: z.string().min(1),
  enabled: z.boolean().default(true),
  lastContent: z.string().optional(),
  excludeKeywords: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type SubscriptionSource = z.infer<typeof subscriptionSourceSchema>;

export const proxyNodeSchema = z.object({
  hash: z.string().min(8),
  sourceId: z.string().min(1),
  name: z.string().min(1),
  originalName: z.string().min(1),
  type: z.string().min(1),
  region: z.string().default("unknown"),
  raw: z.record(z.unknown()),
  status: nodeStatusSchema.default("untested"),
  lifecycleStatus: nodeLifecycleStatusSchema.default("candidate"),
  schedulable: z.boolean().default(false),
  protected: z.boolean().default(false),
  sub2apiProxyId: z.number().int().positive().optional().nullable(),
  qualityScore: z.number().min(0).max(100).optional().nullable(),
  assignedPort: z.number().int().min(1).max(65535).optional(),
  /** 旧格式 `openai:401,claude:405` —— 向后兼容；新逻辑写 lastTestTargets。 */
  lastTestStatus: z.string().optional(),
  /**
   * 语义已变更（P5-R 起）：从"OpenAI/Claude 测试中最大端到端延迟"改为
   * "服务直连代理 host:port 的 TCP 握手延迟（L1）"。
   * 不经过 mihomo、不经过任何业务目标；只反映"我方→代理"的网络距离。
   * 加入前置代理（dialer-proxy）后，这一值会变成"服务→前置代理→目标代理"链路的握手延迟。
   */
  lastTestLatencyMs: z.number().int().nonnegative().optional(),
  /** 每个测试目标（openai / claude / ...）的独立结果，JSON 字符串。优先于 lastTestStatus 显示。 */
  lastTestTargets: z.string().optional(),
  // ADR 0003 orchestration intent
  intentRole: z.enum(["serving", "standby", "quarantined", "evicted"]).optional(),
  backoffUntil: z.string().optional().nullable(),
  backoffAttempts: z.number().int().min(0).optional(),
  healthScore: z.number().int().min(0).max(100).optional().nullable(),
  lastHealthCheck: z.string().optional().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type ProxyNode = z.infer<typeof proxyNodeSchema>;

export const subscriptionImportPreviewItemSchema = z.object({
  hash: z.string().min(8),
  name: z.string().min(1),
  type: z.string().min(1),
  region: z.string().default("unknown"),
  action: z.enum(["import", "update", "skip_duplicate", "skip_existing", "skip_filtered"]),
  reason: z.string().min(1),
  matchedKeywords: z.array(z.string()).default([]),
  deletesExisting: z.boolean().default(false),
  existingAssignedPort: z.number().int().min(1).max(65535).optional()
});

export type SubscriptionImportPreviewItem = z.infer<typeof subscriptionImportPreviewItemSchema>;

export const subscriptionImportPreviewSchema = z.object({
  source: z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    kind: z.enum(["url", "file"]),
    value: z.string().min(1),
    fetchedBytes: z.number().int().nonnegative()
  }),
  items: z.array(subscriptionImportPreviewItemSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    importable: z.number().int().nonnegative(),
    updates: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    existing: z.number().int().nonnegative(),
    filtered: z.number().int().nonnegative(),
    deletedByFilter: z.number().int().nonnegative()
  })
});

export type SubscriptionImportPreview = z.infer<typeof subscriptionImportPreviewSchema>;

export const nodeDeletionPlanSchema = z.object({
  nodes: z.array(proxyNodeSchema),
  blockingAccounts: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().min(1),
      proxyId: z.number().int().positive(),
      proxyName: z.string().min(1)
    })
  ),
  canDeleteNow: z.boolean(),
  requiresDrain: z.boolean(),
  message: z.string()
});

export type NodeDeletionPlan = z.infer<typeof nodeDeletionPlanSchema>;

export const operationJobStatusSchema = z.enum(["queued", "running", "success", "failed", "cancelled"]);
export type OperationJobStatus = z.infer<typeof operationJobStatusSchema>;

export const operationJobSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  status: operationJobStatusSchema,
  title: z.string().min(1),
  detail: z.string().default(""),
  steps: z.array(
    z.object({
      name: z.string().min(1),
      status: operationJobStatusSchema,
      detail: z.string().default("")
    })
  ),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type OperationJob = z.infer<typeof operationJobSchema>;

export const nodeTestTargetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().default(10_000)
});

export type NodeTestTarget = z.infer<typeof nodeTestTargetSchema>;
