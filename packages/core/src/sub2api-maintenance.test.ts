import { describe, expect, it } from "vitest";
import { planSub2ApiManagedMaintenance } from "./sub2api-maintenance.js";
import type { Sub2ApiAccountRecord, Sub2ApiProtectedProxyRule, Sub2ApiProxyRecord } from "@mihomo-hive/schemas";

const protectedRule: Sub2ApiProtectedProxyRule = {
  proxyIds: [],
  nameIncludes: "",
  hostIncludes: "",
  countryIncludes: "",
  regionIncludes: "",
  status: ""
};

describe("planSub2ApiManagedMaintenance", () => {
  it("detects managed proxies by prefix and drains their accounts to non-managed targets", () => {
    const preview = planSub2ApiManagedMaintenance({
      proxies: [proxy(1, "MH-node-1", 2), proxy(2, "manual-node", 0)],
      accounts: [account(10, 1), account(11, 1)],
      protectedRule,
      managedProxyPrefix: "MH-"
    });

    expect(preview.summary.managedProxies).toBe(1);
    expect(preview.summary.managedAccounts).toBe(2);
    expect(preview.summary.drainChanges).toBe(2);
    expect(preview.drainPlan.changes.map((change) => change.newProxyId)).toEqual([2, 2]);
  });

  it("keeps protected managed proxy accounts untouched", () => {
    const preview = planSub2ApiManagedMaintenance({
      proxies: [proxy(1, "MH-protected", 1), proxy(2, "manual-node", 0)],
      accounts: [account(10, 1)],
      protectedRule: { ...protectedRule, proxyIds: [1] },
      managedProxyPrefix: "MH-"
    });

    expect(preview.summary.protectedAccounts).toBe(1);
    expect(preview.summary.drainChanges).toBe(0);
  });
});

function proxy(id: number, name: string, accountCount: number): Sub2ApiProxyRecord {
  return {
    id,
    name,
    protocol: "socks5",
    host: "127.0.0.1",
    port: 10000 + id,
    status: "active",
    account_count: accountCount
  };
}

function account(id: number, proxyId: number): Sub2ApiAccountRecord {
  return {
    id,
    name: `account-${id}`,
    status: "active",
    platform: "openai",
    proxy_id: proxyId
  };
}
