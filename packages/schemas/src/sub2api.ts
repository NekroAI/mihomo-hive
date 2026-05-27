import { z } from "zod";

export const sub2ApiProxySchema = z.object({
  proxy_key: z.string().min(1),
  name: z.string().min(1),
  protocol: z.literal("socks5"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  status: z.literal("active")
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
  filename: z.string().min(1).default("sub2api-proxies.json")
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
