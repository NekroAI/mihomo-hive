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
