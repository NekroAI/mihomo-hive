import { describe, expect, it } from "vitest";
import { exportSub2Api } from "./sub2api.js";

describe("exportSub2Api", () => {
  it("keeps empty username and password fields in proxy_key", () => {
    const result = exportSub2Api(
      [
        {
          hash: "1234567890",
          sourceId: "s1",
          name: "node-001",
          originalName: "node-001",
          type: "ss",
          region: "jp",
          raw: { name: "node-001", type: "ss" },
          status: "active",
          assignedPort: 10001,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      { host: "127.0.0.1" }
    );

    expect(result.proxies[0]?.proxy_key).toBe("socks5|127.0.0.1|10001||");
  });
});
