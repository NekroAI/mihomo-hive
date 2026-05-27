import { z } from "zod";

export const sub2ApiProxySchema = z.object({
  proxy_key: z.string().min(1),
  name: z.string().min(1),
  protocol: z.literal("socks5"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  status: z.enum(["active", "inactive"])
});

export type Sub2ApiProxy = z.infer<typeof sub2ApiProxySchema>;

export const sub2ApiExportSchema = z.object({
  proxies: z.array(sub2ApiProxySchema),
  accounts: z.array(z.unknown()).default([])
});

export type Sub2ApiExport = z.infer<typeof sub2ApiExportSchema>;

export const sub2ApiExportRequestSchema = z.object({
  selectedHashes: z.array(z.string().min(8)).default([]),
  host: z.string().min(1).optional(),
  filename: z.string().min(1).default("sub2api-proxies.json"),
  failedNodeStatus: z.enum(["active", "inactive"]).default("inactive")
});

export type Sub2ApiExportRequest = z.infer<typeof sub2ApiExportRequestSchema>;

export const sub2ApiExcludedNodeSchema = z.object({
  hash: z.string().min(8),
  name: z.string().min(1),
  reason: z.enum(["not_selected", "not_active", "missing_port"])
});

export type Sub2ApiExcludedNode = z.infer<typeof sub2ApiExcludedNodeSchema>;

export const sub2ApiExportPreviewSchema = z.object({
  export: sub2ApiExportSchema,
  selected: z.number().int().nonnegative(),
  exportable: z.number().int().nonnegative(),
  excluded: z.array(sub2ApiExcludedNodeSchema),
  summary: z.object({
    notSelected: z.number().int().nonnegative(),
    notActive: z.number().int().nonnegative(),
    missingPort: z.number().int().nonnegative()
  })
});

export type Sub2ApiExportPreview = z.infer<typeof sub2ApiExportPreviewSchema>;

export const sub2ApiConnectionConfigSchema = z.object({
  baseUrl: z.string().url(),
  adminApiKey: z.string().min(1),
  timezone: z.string().min(1).default("Asia/Shanghai"),
  managedProxyPrefix: z.string().min(1).default("MH-")
});

export type Sub2ApiConnectionConfig = z.infer<typeof sub2ApiConnectionConfigSchema>;

export const sub2ApiSafeConnectionConfigSchema = z.object({
  configured: z.boolean(),
  baseUrl: z.string().url().optional(),
  timezone: z.string().min(1).optional(),
  managedProxyPrefix: z.string().min(1).optional(),
  apiKeyConfigured: z.boolean()
});

export type Sub2ApiSafeConnectionConfig = z.infer<typeof sub2ApiSafeConnectionConfigSchema>;

export const sub2ApiProxyRecordSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  protocol: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  status: z.string().min(1),
  account_count: z.number().int().nonnegative().optional(),
  country: z.string().optional().nullable(),
  country_code: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  city: z.string().optional().nullable()
});

export type Sub2ApiProxyRecord = z.infer<typeof sub2ApiProxyRecordSchema>;

export const sub2ApiAccountRecordSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  platform: z.string().optional().nullable(),
  type: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  group_ids: z.array(z.number().int()).optional(),
  proxy_id: z.number().int().positive().optional().nullable(),
  proxy: sub2ApiProxyRecordSchema.partial().optional().nullable(),
  email: z.string().optional().nullable()
});

export type Sub2ApiAccountRecord = z.infer<typeof sub2ApiAccountRecordSchema>;

export const sub2ApiAccountFiltersSchema = z.object({
  platform: z.string().default("openai"),
  type: z.string().default(""),
  status: z.string().default("active"),
  privacyMode: z.string().default(""),
  group: z.string().default(""),
  search: z.string().default("")
});

export type Sub2ApiAccountFilters = z.infer<typeof sub2ApiAccountFiltersSchema>;

export const sub2ApiProtectedProxyRuleSchema = z.object({
  proxyIds: z.array(z.number().int().positive()).default([]),
  nameIncludes: z.string().default(""),
  hostIncludes: z.string().default(""),
  port: z.number().int().min(1).max(65535).optional(),
  countryIncludes: z.string().default(""),
  regionIncludes: z.string().default(""),
  status: z.string().default("")
});

export type Sub2ApiProtectedProxyRule = z.infer<typeof sub2ApiProtectedProxyRuleSchema>;

export const sub2ApiAssignmentOptionsSchema = z.object({
  filters: sub2ApiAccountFiltersSchema.default({}),
  protectedRule: sub2ApiProtectedProxyRuleSchema.default({}),
  overwriteExisting: z.boolean().default(false)
});

export type Sub2ApiAssignmentOptions = z.infer<typeof sub2ApiAssignmentOptionsSchema>;

export const sub2ApiAssignmentChangeSchema = z.object({
  accountId: z.number().int().positive(),
  accountName: z.string().min(1),
  oldProxyId: z.number().int().positive().nullable(),
  oldProxyName: z.string().nullable(),
  newProxyId: z.number().int().positive(),
  newProxyName: z.string().min(1),
  reason: z.enum(["missing_proxy", "invalid_proxy", "overwrite"])
});

export type Sub2ApiAssignmentChange = z.infer<typeof sub2ApiAssignmentChangeSchema>;

export const sub2ApiAssignmentPreviewSchema = z.object({
  options: sub2ApiAssignmentOptionsSchema,
  summary: z.object({
    accounts: z.number().int().nonnegative(),
    proxies: z.number().int().nonnegative(),
    protectedProxies: z.number().int().nonnegative(),
    assignableProxies: z.number().int().nonnegative(),
    protectedAccounts: z.number().int().nonnegative(),
    unchangedAccounts: z.number().int().nonnegative(),
    changedAccounts: z.number().int().nonnegative(),
    batches: z.number().int().nonnegative()
  }),
  protectedProxies: z.array(sub2ApiProxyRecordSchema),
  assignableProxies: z.array(sub2ApiProxyRecordSchema),
  protectedAccounts: z.array(sub2ApiAccountRecordSchema),
  unchangedAccounts: z.array(sub2ApiAccountRecordSchema),
  changes: z.array(sub2ApiAssignmentChangeSchema),
  errors: z.array(z.string())
});

export type Sub2ApiAssignmentPreview = z.infer<typeof sub2ApiAssignmentPreviewSchema>;

export const sub2ApiAssignmentApplyResultSchema = z.object({
  preview: sub2ApiAssignmentPreviewSchema,
  success: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  successIds: z.array(z.number().int().positive()),
  failedIds: z.array(z.number().int().positive()),
  results: z.array(
    z.object({
      accountId: z.number().int().positive(),
      proxyId: z.number().int().positive(),
      success: z.boolean(),
      message: z.string().optional()
    })
  )
});

export type Sub2ApiAssignmentApplyResult = z.infer<typeof sub2ApiAssignmentApplyResultSchema>;

export const sub2ApiSyncSummarySchema = z.object({
  proxies: z.number().int().nonnegative(),
  accounts: z.number().int().nonnegative(),
  matchedLocalNodes: z.number().int().nonnegative(),
  protectedProxies: z.number().int().nonnegative()
});

export type Sub2ApiSyncSummary = z.infer<typeof sub2ApiSyncSummarySchema>;

export const sub2ApiReconcilePlanSchema = sub2ApiAssignmentPreviewSchema.extend({
  mode: z.enum(["steady_balance", "drain_nodes", "enable_nodes"]).default("steady_balance"),
  affectedNodeHashes: z.array(z.string().min(8)).default([]),
  risks: z.array(z.string()).default([])
});

export type Sub2ApiReconcilePlan = z.infer<typeof sub2ApiReconcilePlanSchema>;

export const sub2ApiReconcileApplyResultSchema = sub2ApiAssignmentApplyResultSchema.extend({
  operationId: z.string().min(1)
});

export type Sub2ApiReconcileApplyResult = z.infer<typeof sub2ApiReconcileApplyResultSchema>;

export const sub2ApiMaintenancePreviewSchema = z.object({
  managedProxyPrefix: z.string().min(1),
  summary: z.object({
    proxies: z.number().int().nonnegative(),
    managedProxies: z.number().int().nonnegative(),
    managedAccounts: z.number().int().nonnegative(),
    emptyManagedProxies: z.number().int().nonnegative(),
    drainChanges: z.number().int().nonnegative(),
    protectedAccounts: z.number().int().nonnegative(),
    assignableTargets: z.number().int().nonnegative()
  }),
  managedProxies: z.array(sub2ApiProxyRecordSchema),
  emptyManagedProxies: z.array(sub2ApiProxyRecordSchema),
  drainPlan: sub2ApiAssignmentPreviewSchema,
  risks: z.array(z.string()).default([])
});

export type Sub2ApiMaintenancePreview = z.infer<typeof sub2ApiMaintenancePreviewSchema>;

export const sub2ApiMaintenanceApplyResultSchema = z.object({
  preview: sub2ApiMaintenancePreviewSchema,
  reassigned: z.number().int().nonnegative(),
  failedReassign: z.number().int().nonnegative(),
  deletedProxies: z.number().int().nonnegative(),
  failedDeleteProxies: z.array(
    z.object({
      proxyId: z.number().int().positive(),
      name: z.string().min(1),
      message: z.string().min(1)
    })
  )
});

export type Sub2ApiMaintenanceApplyResult = z.infer<typeof sub2ApiMaintenanceApplyResultSchema>;
