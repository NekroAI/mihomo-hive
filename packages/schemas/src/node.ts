import { z } from "zod";

export const nodeStatusSchema = z.enum(["active", "inactive", "untested", "failed"]);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

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
  assignedPort: z.number().int().min(1).max(65535).optional(),
  lastTestStatus: z.string().optional(),
  lastTestLatencyMs: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type ProxyNode = z.infer<typeof proxyNodeSchema>;

export const nodeTestTargetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().default(10_000)
});

export type NodeTestTarget = z.infer<typeof nodeTestTargetSchema>;
