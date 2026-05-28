import { describe, expect, it } from "vitest";
import type { ProxyNode } from "@mihomo-hive/schemas";
import {
  buildEgressCandidates,
  buildEgressLoadMap,
  NoEgressAvailableError,
  selectEgressForLogin,
  selectEgressForRegister
} from "./account-fleet-egress.js";

function makeNode(overrides: Partial<ProxyNode> = {}): ProxyNode {
  const now = new Date().toISOString();
  return {
    hash: `h-${Math.random().toString(36).slice(2, 10)}`,
    sourceId: "src-1",
    name: "node",
    originalName: "node",
    type: "ss",
    region: "JP",
    raw: {},
    status: "active",
    lifecycleStatus: "schedulable",
    schedulable: true,
    protected: false,
    qualityScore: 80,
    assignedPort: 10001,
    lastTestTargets: JSON.stringify([
      { targetId: "openai", ok: true, latencyMs: 200, httpStatus: 401, message: "ok" },
      { targetId: "claude", ok: true, latencyMs: 250, httpStatus: 405, message: "ok" }
    ]),
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("buildEgressCandidates", () => {
  it("filters to schedulable + active + has assignedPort + openai.ok = strict", () => {
    const nodes = [
      makeNode({ hash: "ok" }),
      makeNode({ hash: "no-port", assignedPort: undefined }),
      makeNode({ hash: "inactive", status: "inactive" }),
      makeNode({ hash: "not-schedulable", schedulable: false }),
      makeNode({
        hash: "openai-fail",
        lastTestTargets: JSON.stringify([{ targetId: "openai", ok: false }])
      })
    ];
    const { strict, relaxed } = buildEgressCandidates({ nodes, egressLoadByNodeHash: new Map() });
    expect(strict.map((c) => c.hash)).toEqual(["ok"]);
    // relaxed: openai-fail 是"测过且确认失败"，必须被排除
    expect(relaxed.map((c) => c.hash)).toEqual(["ok"]);
  });

  it("unknown lastTestTargets format → not in strict but in relaxed (尚未测过，视为可能可用)", () => {
    const nodes = [makeNode({ hash: "stranded", lastTestTargets: "garbage" })];
    const { strict, relaxed } = buildEgressCandidates({ nodes, egressLoadByNodeHash: new Map() });
    expect(strict).toHaveLength(0);
    expect(relaxed).toHaveLength(1);
    expect(relaxed[0]?.tested).toBe(false);
    expect(relaxed[0]?.openaiOk).toBe(false);
  });

  it("relaxed excludes tested-but-openai-fail nodes (硬约束：宽松池仍至少保证不选明知失败的)", () => {
    const nodes = [
      makeNode({ hash: "untested", lastTestTargets: undefined }),
      makeNode({
        hash: "openai-fail",
        lastTestTargets: JSON.stringify([{ targetId: "openai", ok: false }])
      }),
      makeNode({
        hash: "openai-pass",
        lastTestTargets: JSON.stringify([{ targetId: "openai", ok: true }])
      })
    ];
    const { strict, relaxed } = buildEgressCandidates({ nodes, egressLoadByNodeHash: new Map() });
    expect(strict.map((c) => c.hash)).toEqual(["openai-pass"]);
    expect(relaxed.map((c) => c.hash).sort()).toEqual(["openai-pass", "untested"]);
  });

  it("includes egress load from map", () => {
    const node = makeNode({ hash: "n1" });
    const { strict } = buildEgressCandidates({
      nodes: [node],
      egressLoadByNodeHash: new Map([["n1", 5]])
    });
    expect(strict[0]?.load).toBe(5);
  });
});

describe("selectEgressForRegister", () => {
  it("throws when no nodes at all", () => {
    expect(() =>
      selectEgressForRegister({ nodes: [], egressLoadByNodeHash: new Map() })
    ).toThrow(NoEgressAvailableError);
  });

  it("returns a strict candidate when one exists", () => {
    const node = makeNode({ hash: "h1", assignedPort: 10001 });
    const r = selectEgressForRegister({ nodes: [node], egressLoadByNodeHash: new Map(), rand: () => 0.5 });
    expect(r.hash).toBe("h1");
    expect(r.port).toBe(10001);
    expect(r.reason).toBe("weighted_quality");
  });

  it("falls back to relaxed pool when strict is empty", () => {
    const node = makeNode({
      hash: "untested",
      lastTestTargets: undefined,
      assignedPort: 10002
    });
    const r = selectEgressForRegister({
      nodes: [node],
      egressLoadByNodeHash: new Map(),
      rand: () => 0.5
    });
    expect(r.hash).toBe("untested");
    expect(r.reason).toBe("fallback_relaxed");
  });

  it("spreads picks across multiple equal-weight nodes (statistical)", () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeNode({ hash: `h${i}`, assignedPort: 10001 + i, qualityScore: 80 })
    );
    const picks = new Map<string, number>();
    const trials = 1000;
    // 用循环递增伪随机模拟均匀分布
    for (let i = 0; i < trials; i++) {
      const fakeRand = ((seed: number) => () => ((seed * 9301 + 49297) % 233280) / 233280)(i + 1);
      const r = selectEgressForRegister({ nodes, egressLoadByNodeHash: new Map(), rand: fakeRand });
      picks.set(r.hash, (picks.get(r.hash) ?? 0) + 1);
    }
    // 每个节点期望 200 次；允许 ±50 的偏差
    for (const node of nodes) {
      const c = picks.get(node.hash) ?? 0;
      expect(c).toBeGreaterThan(150);
      expect(c).toBeLessThan(250);
    }
  });

  it("prefers higher quality nodes over lower quality", () => {
    const nodes = [
      makeNode({ hash: "high", qualityScore: 100 }),
      makeNode({ hash: "low", qualityScore: 20 })
    ];
    const picks = new Map<string, number>();
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      const fakeRand = ((seed: number) => () => ((seed * 9301 + 49297) % 233280) / 233280)(i + 1);
      const r = selectEgressForRegister({ nodes, egressLoadByNodeHash: new Map(), rand: fakeRand });
      picks.set(r.hash, (picks.get(r.hash) ?? 0) + 1);
    }
    // quality=100 vs 20，weight 比 5:1，期望 high ≈ 833 / low ≈ 167
    expect(picks.get("high") ?? 0).toBeGreaterThan(750);
    expect(picks.get("low") ?? 0).toBeGreaterThan(100);
    expect(picks.get("low") ?? 0).toBeLessThan(250);
  });

  it("penalizes high-load nodes (load awareness)", () => {
    const nodes = [
      makeNode({ hash: "loaded", qualityScore: 80 }),
      makeNode({ hash: "free", qualityScore: 80 })
    ];
    const loads = new Map<string, number>([
      ["loaded", 99] // load 高 → weight = 80/100 = 0.8
      // "free" load = 0 → weight = 80/1 = 80
    ]);
    const picks = new Map<string, number>();
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      const fakeRand = ((seed: number) => () => ((seed * 9301 + 49297) % 233280) / 233280)(i + 1);
      const r = selectEgressForRegister({ nodes, egressLoadByNodeHash: loads, rand: fakeRand });
      picks.set(r.hash, (picks.get(r.hash) ?? 0) + 1);
    }
    // free 应该压倒性多
    expect(picks.get("free") ?? 0).toBeGreaterThan(900);
    expect(picks.get("loaded") ?? 0).toBeLessThan(100);
  });
});

describe("selectEgressForLogin", () => {
  it("returns preferred when it's in the strict pool", () => {
    const nodes = [makeNode({ hash: "preferred" }), makeNode({ hash: "other" })];
    const r = selectEgressForLogin({
      nodes,
      egressLoadByNodeHash: new Map(),
      preferredHash: "preferred",
      rand: () => 0.5
    });
    expect(r.hash).toBe("preferred");
    expect(r.reason).toBe("preferred");
  });

  it("falls back to weighted when preferred not in strict pool", () => {
    const nodes = [
      makeNode({
        hash: "preferred-but-broken",
        lastTestTargets: JSON.stringify([{ targetId: "openai", ok: false }])
      }),
      makeNode({ hash: "ok" })
    ];
    const r = selectEgressForLogin({
      nodes,
      egressLoadByNodeHash: new Map(),
      preferredHash: "preferred-but-broken",
      rand: () => 0.5
    });
    expect(r.hash).toBe("ok");
    expect(r.reason).toBe("weighted_quality");
  });

  it("preferredHash=null behaves like register", () => {
    const node = makeNode({ hash: "only" });
    const r = selectEgressForLogin({
      nodes: [node],
      egressLoadByNodeHash: new Map(),
      preferredHash: null,
      rand: () => 0.5
    });
    expect(r.hash).toBe("only");
  });

  it("preferred not in either pool + no other nodes → throws", () => {
    const nodes = [
      makeNode({
        hash: "all-bad",
        schedulable: false // 完全不可调度
      })
    ];
    expect(() =>
      selectEgressForLogin({
        nodes,
        egressLoadByNodeHash: new Map(),
        preferredHash: "unrelated",
        rand: () => 0.5
      })
    ).toThrow(NoEgressAvailableError);
  });
});

describe("buildEgressLoadMap", () => {
  it("counts accounts per egressNodeHash, ignores null", () => {
    const map = buildEgressLoadMap([
      { egressNodeHash: "a" },
      { egressNodeHash: "a" },
      { egressNodeHash: "b" },
      { egressNodeHash: null },
      { egressNodeHash: null }
    ]);
    expect(map.get("a")).toBe(2);
    expect(map.get("b")).toBe(1);
    expect(map.size).toBe(2);
  });
});
