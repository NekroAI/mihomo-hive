import { z } from "zod";

export const filterRuleSchema = z.object({
  id: z.string().min(1),
  field: z.enum(["name", "region", "type"]),
  op: z.enum(["contains", "not_contains", "equals", "not_equals", "regex"]),
  value: z.string().min(1),
  caseSensitive: z.boolean().default(false)
});

export type FilterRule = z.infer<typeof filterRuleSchema>;

export const filterProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(["all", "any"]).default("all"),
  invert: z.boolean().default(false),
  rules: z.array(filterRuleSchema).default([])
});

export type FilterProfile = z.infer<typeof filterProfileSchema>;
