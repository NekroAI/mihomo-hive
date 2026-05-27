import { describe, expect, it } from "vitest";
import { groupAssignmentChangesByProxy, planSub2ApiAssignments } from "./sub2api-assignment.js";
import type { Sub2ApiAccountRecord, Sub2ApiAssignmentOptions, Sub2ApiProxyRecord } from "@mihomo-hive/schemas";

const defaultOptions: Sub2ApiAssignmentOptions = {
  filters: {
    platform: "openai",
    type: "",
    status: "active",
    privacyMode: "",
    group: "",
    search: ""
  },
  protectedRule: {
    proxyIds: [],
    nameIncludes: "",
    hostIncludes: "",
    countryIncludes: "",
    regionIncludes: "",
    status: ""
  },
  overwriteExisting: false
};

describe("planSub2ApiAssignments", () => {
  it("derives protected accounts from protected proxies", () => {
    const preview = planSub2ApiAssignments({
      proxies: [proxy(1), proxy(2)],
      accounts: [account(10, 1), account(11, null)],
      options: {
        ...defaultOptions,
        protectedRule: { ...defaultOptions.protectedRule, proxyIds: [1] }
      }
    });

    expect(preview.summary.protectedProxies).toBe(1);
    expect(preview.summary.protectedAccounts).toBe(1);
    expect(preview.protectedAccounts.map((item) => item.id)).toEqual([10]);
    expect(preview.changes.map((item) => item.accountId)).toEqual([11]);
  });

  it("keeps existing assignable proxies when overwrite is disabled", () => {
    const preview = planSub2ApiAssignments({
      proxies: [proxy(1), proxy(2)],
      accounts: [account(10, 1), account(11, null)],
      options: defaultOptions
    });

    expect(preview.summary.unchangedAccounts).toBe(1);
    expect(preview.summary.changedAccounts).toBe(1);
    expect(preview.changes[0]?.reason).toBe("missing_proxy");
  });

  it("rewrites non-protected accounts when overwrite is enabled", () => {
    const preview = planSub2ApiAssignments({
      proxies: [proxy(1), proxy(2)],
      accounts: [account(10, 1), account(11, 2)],
      options: { ...defaultOptions, overwriteExisting: true }
    });

    expect(preview.protectedAccounts).toHaveLength(0);
    expect(preview.changes.every((item) => item.reason === "overwrite")).toBe(true);
  });

  it("returns an error when every proxy is protected", () => {
    const preview = planSub2ApiAssignments({
      proxies: [proxy(1), proxy(2)],
      accounts: [account(10, null)],
      options: {
        ...defaultOptions,
        protectedRule: { ...defaultOptions.protectedRule, status: "active" }
      }
    });

    expect(preview.summary.assignableProxies).toBe(0);
    expect(preview.errors).toEqual(["没有可用于分配的 Sub2API active 代理。"]);
    expect(preview.changes).toHaveLength(0);
  });

  it("groups changes by target proxy id", () => {
    const groups = groupAssignmentChangesByProxy([
      change(10, 2),
      change(11, 1),
      change(12, 2)
    ]);

    expect(groups).toEqual([
      { proxyId: 1, accountIds: [11] },
      { proxyId: 2, accountIds: [10, 12] }
    ]);
  });
});

function proxy(id: number): Sub2ApiProxyRecord {
  return {
    id,
    name: `proxy-${id}`,
    protocol: "socks5",
    host: "127.0.0.1",
    port: 10000 + id,
    status: "active"
  };
}

function account(id: number, proxyId: number | null): Sub2ApiAccountRecord {
  return {
    id,
    name: `account-${id}`,
    platform: "openai",
    type: "oauth",
    status: "active",
    proxy_id: proxyId
  };
}

function change(accountId: number, newProxyId: number) {
  return {
    accountId,
    accountName: `account-${accountId}`,
    oldProxyId: null,
    oldProxyName: null,
    newProxyId,
    newProxyName: `proxy-${newProxyId}`,
    reason: "missing_proxy" as const
  };
}
