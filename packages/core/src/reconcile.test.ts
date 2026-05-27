import { describe, expect, it } from "vitest";
import {
  defaultOrchestrationSpec,
  type OrchestrationSpec,
  type ProxyNode,
  type Sub2ApiAccountRecord,
  type Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";
import { reconcile, validateIntakeAgainstSpec } from "./reconcile.js";

const NOW = new Date("2026-05-27T12:00:00Z");
const PREFIX = "MH-";

function buildProxy(input: Partial<Sub2ApiProxyRecord> & { id: number; name?: string }): Sub2ApiProxyRecord {
  return {
    id: input.id,
    name: input.name ?? `MH-node-${input.id}`,
    protocol: "socks5",
    host: input.host ?? "127.0.0.1",
    port: input.port ?? 10000 + input.id,
    status: input.status ?? "active",
    ...(input.account_count !== undefined ? { account_count: input.account_count } : {})
  };
}

function buildNode(input: Partial<ProxyNode> & { hash: string; sub2apiProxyId: number }): ProxyNode {
  return {
    hash: input.hash,
    sourceId: "src",
    name: input.name ?? `local-${input.sub2apiProxyId}`,
    originalName: input.name ?? `local-${input.sub2apiProxyId}`,
    type: "vless",
    region: "jp",
    raw: {},
    status: "active",
    lifecycleStatus: input.lifecycleStatus ?? "schedulable",
    schedulable: true,
    protected: input.protected ?? false,
    sub2apiProxyId: input.sub2apiProxyId,
    assignedPort: 10000 + input.sub2apiProxyId,
    intentRole: input.intentRole ?? "serving",
    ...(input.backoffUntil !== undefined ? { backoffUntil: input.backoffUntil } : {}),
    backoffAttempts: input.backoffAttempts ?? 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function buildAccount(input: { id: number; proxy_id: number | null; name?: string }): Sub2ApiAccountRecord {
  return {
    id: input.id,
    name: input.name ?? `acct-${input.id}`,
    proxy_id: input.proxy_id
  };
}

function specWith(overrides: Partial<OrchestrationSpec>): OrchestrationSpec {
  return { ...defaultOrchestrationSpec, ...overrides };
}

describe("reconcile", () => {
  it("paused spec produces dry-run output (no applied changes, intents still built)", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1 }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: null })];

    const result = reconcile({
      now: NOW,
      spec: specWith({ enabled: false }),
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    expect(result.skippedReason).toBe("paused");
    expect(result.appliedChanges).toHaveLength(0);
    expect(result.plannedChanges.length).toBeGreaterThan(0); // dry-run 仍规划
    expect(result.nodeIntents).toHaveLength(2);
  });

  it("no changes needed → skippedReason = no_change", () => {
    const proxies = [buildProxy({ id: 1 })];
    const localNodes = [buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1 })];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    expect(result.plannedChanges).toEqual([]);
    expect(result.skippedReason).toBe("no_change");
  });

  it("intake drain: accounts on intake proxy get rerouted to serving nodes", () => {
    const intake = buildProxy({ id: 99, name: "intake-handoff" }); // 不带 MH- 前缀
    const serving = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1 }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 })
    ];
    const accounts = [
      buildAccount({ id: 10, proxy_id: 99 }),
      buildAccount({ id: 11, proxy_id: 99 }),
      buildAccount({ id: 12, proxy_id: 99 })
    ];

    const result = reconcile({
      now: NOW,
      spec: specWith({ intake: { proxyId: 99, bypassGraceBatch: true } }),
      localNodes,
      remoteProxies: [intake, ...serving],
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    const drainChanges = result.plannedChanges.filter((c) => c.kind === "drain_intake");
    expect(drainChanges).toHaveLength(3);
    for (const change of drainChanges) {
      expect(change.fromProxyId).toBe(99);
      expect([1, 2]).toContain(change.toProxyId);
    }
  });

  it("protected proxies are excluded from assignable pool and their accounts never move", () => {
    const protectedProxy = buildProxy({ id: 50, name: "WRT-home", host: "192.168.5.8" });
    const serving = [buildProxy({ id: 1 })];
    const localNodes = [buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1 })];
    const accounts = [
      buildAccount({ id: 10, proxy_id: 50 }), // 受保护账号
      buildAccount({ id: 20, proxy_id: null }) // 未绑定，应分配到 #1
    ];

    const result = reconcile({
      now: NOW,
      spec: specWith({
        protectedRule: {
          proxyIds: [],
          nameIncludes: "WRT",
          hostIncludes: "",
          countryIncludes: "",
          regionIncludes: "",
          status: ""
        }
      }),
      localNodes,
      remoteProxies: [protectedProxy, ...serving],
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    // 账号 10 不能出现在 planned 里（受保护）
    expect(result.plannedChanges.find((c) => c.accountId === 10)).toBeUndefined();
    // 账号 20 应被 bind_missing 到 #1
    const account20 = result.plannedChanges.find((c) => c.accountId === 20);
    expect(account20).toBeDefined();
    expect(account20?.kind).toBe("bind_missing");
    expect(account20?.toProxyId).toBe(1);
  });

  it("overload triggers rebalance with capped per-tick migrations", () => {
    const proxies = [
      buildProxy({ id: 1 }),
      buildProxy({ id: 2 }),
      buildProxy({ id: 3 })
    ];
    const localNodes = proxies.map((p) =>
      buildNode({ hash: `n${p.id}xxxxxx`, sub2apiProxyId: p.id })
    );
    // 12 个账号全堆在 #1 → target = ceil(12/3) = 4，overload upper = 4*1.2 = 5
    // 节点 1 实际承载 12 > 5，需要外迁 (12 - 4) = 8 个
    const accounts = Array.from({ length: 12 }, (_, i) =>
      buildAccount({ id: 100 + i, proxy_id: 1 })
    );

    const result = reconcile({
      now: NOW,
      spec: specWith({
        // 关掉灰度阀让规划全跑出来，但保留 stickiness.perTickMigrationCap
        graceBatchPercent: 100,
        graceBatchAbs: 999,
        stickiness: { strategy: "stable-hash", rebalanceTriggerPercent: 15, perTickMigrationCap: 3 }
      }),
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    const overloadChanges = result.plannedChanges.filter((c) => c.kind === "rebalance_overload");
    expect(overloadChanges.length).toBe(8); // planned full
    const appliedOverload = result.appliedChanges.filter((c) => c.kind === "rebalance_overload");
    expect(appliedOverload.length).toBe(3); // 受 perTickMigrationCap 限制
  });

  it("graceBatch caps general changes but lets intake drain pass through (bypass=true)", () => {
    const intake = buildProxy({ id: 99 });
    const serving = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = serving.map((p) =>
      buildNode({ hash: `n${p.id}xxxxxx`, sub2apiProxyId: p.id })
    );

    // 5 个账号在 intake + 5 个未绑定（bind_missing）
    const accounts = [
      ...Array.from({ length: 5 }, (_, i) => buildAccount({ id: 100 + i, proxy_id: 99 })),
      ...Array.from({ length: 5 }, (_, i) => buildAccount({ id: 200 + i, proxy_id: null }))
    ];

    const result = reconcile({
      now: NOW,
      spec: specWith({
        intake: { proxyId: 99, bypassGraceBatch: true },
        graceBatchPercent: 100,
        graceBatchAbs: 2 // 强制 general cap = 2
      }),
      localNodes,
      remoteProxies: [intake, ...serving],
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    const intakeApplied = result.appliedChanges.filter((c) => c.kind === "drain_intake");
    const generalApplied = result.appliedChanges.filter((c) => c.kind === "bind_missing");
    expect(intakeApplied.length).toBe(5); // bypass，全部通过
    expect(generalApplied.length).toBe(2); // 受 general cap = 2 限制
  });

  it("quarantined node's accounts stay put (stability-first invariant)", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({
        hash: "n1xxxxxx",
        sub2apiProxyId: 1,
        intentRole: "quarantined",
        backoffUntil: new Date(NOW.getTime() + 60_000).toISOString()
      }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 })
    ];
    const accounts = [buildAccount({ id: 10, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    // 退避节点上的账号不应该出现在 planned changes 里（因为 quarantined ≠ dead；只有 evicted 才硬迁）
    const moved = result.plannedChanges.find((c) => c.accountId === 10);
    expect(moved).toBeUndefined();
  });

  it("evicted proxy's accounts get rebind_dead to a serving node", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "evicted" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2 })
    ];
    const accounts = [buildAccount({ id: 10, proxy_id: 1 })];

    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX
    });

    const moved = result.plannedChanges.find((c) => c.accountId === 10);
    expect(moved?.kind).toBe("rebind_dead");
    expect(moved?.toProxyId).toBe(2);
  });
});

describe("reconcile health state machine", () => {
  it("serving node with errors over budget enters quarantined + records backoff", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 8 }]]); // 8 ≥ 5 (default budget)
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("quarantined");
    expect(node1?.backoffAttempts).toBe(1);
    expect(node1?.backoffUntil).not.toBeNull();
    expect(new Date(node1!.backoffUntil!).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("quarantined node with active backoff stays put even with new signal", () => {
    const proxies = [buildProxy({ id: 1 })];
    const localNodes = [
      buildNode({
        hash: "n1xxxxxx",
        sub2apiProxyId: 1,
        intentRole: "quarantined",
        backoffUntil: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
        backoffAttempts: 1
      })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 25 }]]); // 大量错误也无所谓
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("quarantined");
    expect(node1?.backoffAttempts).toBe(1); // 不变
  });

  it("quarantined node with expired backoff returns to serving when no new errors", () => {
    const proxies = [buildProxy({ id: 1 })];
    const localNodes = [
      buildNode({
        hash: "n1xxxxxx",
        sub2apiProxyId: 1,
        intentRole: "quarantined",
        backoffUntil: new Date(NOW.getTime() - 1_000).toISOString(),
        backoffAttempts: 2
      })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 0 }]]);
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("serving");
    expect(node1?.backoffUntil).toBeNull();
    expect(node1?.healthScore).toBe(100);
  });

  it("evicted when consecutive backoff attempts exceed evictAfterBackoffs", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({
        hash: "n1xxxxxx",
        sub2apiProxyId: 1,
        intentRole: "quarantined",
        backoffUntil: new Date(NOW.getTime() - 1_000).toISOString(),
        backoffAttempts: 5
      }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 12 }]]);
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("evicted");
    expect(node1?.backoffAttempts).toBe(6);
    const moved = result.plannedChanges.find((c) => c.accountId === 100);
    expect(moved?.kind).toBe("rebind_dead");
    expect(moved?.toProxyId).toBe(2);
  });

  it("errors below budget do NOT trigger backoff", () => {
    const proxies = [buildProxy({ id: 1 }), buildProxy({ id: 2 })];
    const localNodes = [
      buildNode({ hash: "n1xxxxxx", sub2apiProxyId: 1, intentRole: "serving" }),
      buildNode({ hash: "n2xxxxxx", sub2apiProxyId: 2, intentRole: "serving" })
    ];
    const accounts = [buildAccount({ id: 100, proxy_id: 1 })];
    const healthSignals = new Map([[1, { errorsInWindow: 3 }]]); // 3 < 5
    const result = reconcile({
      now: NOW,
      spec: defaultOrchestrationSpec,
      localNodes,
      remoteProxies: proxies,
      remoteAccounts: accounts,
      managedProxyPrefix: PREFIX,
      healthSignals
    });
    const node1 = result.nodeIntents.find((n) => n.proxyId === 1);
    expect(node1?.intentRole).toBe("serving");
    expect(node1?.backoffAttempts).toBe(0);
    expect(node1?.healthScore).toBe(85); // 100 - 3*5
  });
});

describe("validateIntakeAgainstSpec", () => {
  it("returns null when proxy is plain (not managed, not protected)", () => {
    const proxies = [buildProxy({ id: 50, name: "handoff" })];
    const spec = specWith({ intake: { proxyId: 50, bypassGraceBatch: true } });
    expect(validateIntakeAgainstSpec(spec, proxies, PREFIX)).toBeNull();
  });

  it("rejects managed proxy as intake", () => {
    const proxies = [buildProxy({ id: 50, name: "MH-hive-handoff" })];
    const spec = specWith({ intake: { proxyId: 50, bypassGraceBatch: true } });
    expect(validateIntakeAgainstSpec(spec, proxies, PREFIX)).toMatch(/托管/);
  });

  it("rejects protected proxy as intake", () => {
    const proxies = [buildProxy({ id: 50, name: "WRT-home" })];
    const spec = specWith({
      intake: { proxyId: 50, bypassGraceBatch: true },
      protectedRule: {
        proxyIds: [],
        nameIncludes: "WRT",
        hostIncludes: "",
        countryIncludes: "",
        regionIncludes: "",
        status: ""
      }
    });
    expect(validateIntakeAgainstSpec(spec, proxies, PREFIX)).toMatch(/保护/);
  });

  it("rejects unknown proxy id", () => {
    const proxies: Sub2ApiProxyRecord[] = [];
    const spec = specWith({ intake: { proxyId: 50, bypassGraceBatch: true } });
    expect(validateIntakeAgainstSpec(spec, proxies, PREFIX)).toMatch(/不存在/);
  });
});
