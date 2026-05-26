import { describe, expect, it } from "vitest";
import { parseSubscription } from "./subscription.js";

describe("parseSubscription", () => {
  it("parses Clash YAML proxies", () => {
    const nodes = parseSubscription(
      `
proxies:
  - name: JP-1
    type: ss
    server: example.com
    port: 443
`,
      "source-1"
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe("JP-1");
    expect(nodes[0]?.region).toBe("jp");
  });

  it("skips subscription info and unsupported-client placeholder proxies", () => {
    const nodes = parseSubscription(
      `
proxies:
  - name: 剩余流量：97.03 GB
    type: vless
    server: example.com
    port: 443
  - name: 当前Clash客户端不支持本机场协议
    type: ss
    server: 127.0.0.1
    port: 65535
  - name: JP-Real
    type: vless
    server: jp.example.com
    port: 443
`,
      "source-1"
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe("JP-Real");
  });
});
