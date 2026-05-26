import { describe, expect, it } from "vitest";
import { defaultRuntimeConfig, type ProxyNode } from "@mihomo-hive/schemas";
import { renderMihomoConfig } from "./mihomo-render.js";

describe("renderMihomoConfig", () => {
  it("renders 300 fixed mixed listeners", () => {
    const nodes = Array.from({ length: 300 }, (_, index): ProxyNode => {
      const port = 10001 + index;
      return {
        hash: `${String(index).padStart(8, "0")}abcdef`,
        sourceId: "sample",
        name: `node-${index + 1}`,
        originalName: `node-${index + 1}`,
        type: "ss",
        region: "unknown",
        raw: {
          name: `node-${index + 1}`,
          type: "ss",
          server: `node-${index + 1}.example.com`,
          port: 443,
          cipher: "aes-128-gcm",
          password: "secret"
        },
        status: "active",
        assignedPort: port,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });

    const rendered = renderMihomoConfig(nodes, defaultRuntimeConfig);

    expect(rendered.egressMap).toHaveLength(300);
    expect(rendered.yaml).toContain("name: hive-10001");
    expect(rendered.yaml).toContain("port: 10300");
    expect(rendered.yaml).not.toContain("load-balance");
    expect(rendered.yaml).not.toContain("url-test");
    expect(rendered.yaml).not.toContain("fallback");
  });
});
