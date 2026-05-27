import { describe, expect, it } from "vitest";
import { parseSubscription } from "./subscription.js";
import { buildSubscriptionImportPreview, filterPreviewImportableNodes } from "./subscription-preview.js";

describe("buildSubscriptionImportPreview", () => {
  it("classifies importable, filtered, duplicate and existing nodes before import", () => {
    const content = `
proxies:
  - name: JP-1
    type: ss
    server: jp.example.com
    port: 443
  - name: JP-1
    type: ss
    server: jp.example.com
    port: 443
  - name: BadNode
    type: ss
    server: info.example.com
    port: 443
  - name: US-Existing
    type: vless
    server: us.example.com
    port: 443
`;
    const parsed = parseSubscription(content, "other-source");
    const existing = [{ ...parsed[3]!, sourceId: "other-source", lifecycleStatus: "schedulable" as const, schedulable: true }];

    const preview = buildSubscriptionImportPreview({
      source: { id: "source-1", name: "primary", kind: "url", value: "https://example.com/sub" },
      content,
      existingNodes: existing,
      excludeKeywords: ["BadNode"]
    });

    expect(preview.summary).toMatchObject({
      total: 4,
      importable: 1,
      duplicates: 1,
      existing: 1,
      filtered: 1
    });
    expect(preview.items.map((item) => item.action)).toEqual(["import", "skip_duplicate", "skip_filtered", "skip_existing"]);
    expect(filterPreviewImportableNodes({
      source: { id: "source-1", name: "primary", kind: "url", value: "https://example.com/sub" },
      content,
      existingNodes: existing,
      excludeKeywords: ["BadNode"]
    })).toHaveLength(1);
  });
});
