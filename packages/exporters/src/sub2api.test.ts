import { describe, expect, it } from "vitest";
import { exportSub2Api, previewSub2ApiExport } from "./sub2api.js";
import type { ProxyNode } from "@mihomo-hive/schemas";

describe("exportSub2Api", () => {
  it("keeps empty username and password fields in proxy_key", () => {
    const result = exportSub2Api([node({ hash: "1234567890", status: "active", assignedPort: 10001 })], {
      host: "127.0.0.1"
    });

    expect(result.proxies[0]?.proxy_key).toBe("socks5|127.0.0.1|10001||");
    expect(result.proxies[0]?.status).toBe("active");
  });

  it("exports selected nodes with assigned ports and marks failed nodes inactive by default", () => {
    const result = exportSub2Api(
      [
        node({ hash: "active0001", status: "active", assignedPort: 10001 }),
        node({ hash: "failed0001", status: "failed", assignedPort: 10002 }),
        node({ hash: "untested01", status: "untested", assignedPort: 10003 }),
        node({ hash: "inactive01", status: "inactive", assignedPort: 10004 }),
        node({ hash: "missing001", status: "active" })
      ],
      { host: "127.0.0.1" }
    );

    expect(result.proxies.map((proxy) => [proxy.port, proxy.status])).toEqual([
      [10001, "active"],
      [10002, "inactive"],
      [10003, "inactive"],
      [10004, "inactive"]
    ]);
  });

  it("honors selected hashes strictly when nodes have assigned ports", () => {
    const result = exportSub2Api(
      [
        node({ hash: "active0001", status: "active", assignedPort: 10001 }),
        node({ hash: "active0002", status: "active", assignedPort: 10002 }),
        node({ hash: "failed0001", status: "failed", assignedPort: 10003 })
      ],
      { host: "127.0.0.1", selectedHashes: ["active0002", "failed0001"] }
    );

    expect(result.proxies.map((proxy) => [proxy.port, proxy.status])).toEqual([
      [10002, "active"],
      [10003, "inactive"]
    ]);
  });

  it("can export failed nodes as active when requested", () => {
    const result = exportSub2Api([node({ hash: "failed0001", status: "failed", assignedPort: 10003 })], {
      host: "127.0.0.1",
      failedNodeStatus: "active"
    });

    expect(result.proxies[0]?.status).toBe("active");
  });

  it("previews exported and excluded nodes with stable counts", () => {
    const preview = previewSub2ApiExport(
      [
        node({ hash: "active0001", status: "active", assignedPort: 10001 }),
        node({ hash: "failed0001", status: "failed", assignedPort: 10002 }),
        node({ hash: "missing001", status: "active" }),
        node({ hash: "other00001", status: "active", assignedPort: 10003 })
      ],
      { host: "127.0.0.1", selectedHashes: ["active0001", "failed0001", "missing001"] }
    );

    expect(preview.selected).toBe(3);
    expect(preview.exportable).toBe(2);
    expect(preview.summary).toEqual({ notSelected: 1, notActive: 0, missingPort: 1 });
    expect(preview.export.proxies[0]?.proxy_key).toBe("socks5|127.0.0.1|10001||");
  });
});

function node(input: Partial<ProxyNode> & Pick<ProxyNode, "hash" | "status">): ProxyNode {
  return {
    hash: input.hash,
    sourceId: "s1",
    name: input.name ?? input.hash,
    originalName: input.originalName ?? input.name ?? input.hash,
    type: input.type ?? "ss",
    region: input.region ?? "jp",
    raw: input.raw ?? { name: input.name ?? input.hash, type: input.type ?? "ss" },
    status: input.status,
    lifecycleStatus: input.lifecycleStatus ?? (input.status === "active" ? "schedulable" : input.status === "failed" ? "cooling_down" : "candidate"),
    schedulable: input.schedulable ?? (input.status === "active"),
    protected: input.protected ?? false,
    ...(input.assignedPort ? { assignedPort: input.assignedPort } : {}),
    codexLoginSuccess: input.codexLoginSuccess ?? 0,
    codexLoginFailure: input.codexLoginFailure ?? 0,
    codexReserved: input.codexReserved ?? false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
