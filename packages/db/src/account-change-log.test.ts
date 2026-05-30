import { describe, expect, it } from "vitest";
import type { AccountChangeEntry } from "@mihomo-hive/schemas";
import { appendAccountChanges, type AccountChangeSnapshot } from "./account-change-log.js";

const snap = (over: Partial<AccountChangeSnapshot> = {}): AccountChangeSnapshot => ({
  health: "healthy",
  intent: "active",
  quota5hPercent: null,
  quota7dPercent: null,
  ...over
});

describe("appendAccountChanges", () => {
  it("new account (prev=null) records nothing", () => {
    expect(appendAccountChanges([], null, snap(), "t0", 10)).toEqual([]);
  });

  it("no change → history untouched", () => {
    const prev = snap({ quota5hPercent: 10 });
    expect(appendAccountChanges([], prev, snap({ quota5hPercent: 10 }), "t1", 10)).toEqual([]);
  });

  it("records a health flip at the head", () => {
    const out = appendAccountChanges([], snap(), snap({ health: "quota_exhausted" }), "t1", 10);
    expect(out).toEqual([{ kind: "health", at: "t1", from: "healthy", to: "quota_exhausted" }]);
  });

  it("records an intent flip", () => {
    const out = appendAccountChanges([], snap(), snap({ intent: "retired" }), "t1", 10);
    expect(out[0]).toEqual({ kind: "intent", at: "t1", from: "active", to: "retired" });
  });

  it("records a quota delta with from/to", () => {
    const out = appendAccountChanges(
      [],
      snap({ quota5hPercent: 10, quota7dPercent: 5 }),
      snap({ quota5hPercent: 40, quota7dPercent: 12 }),
      "t1",
      10
    );
    expect(out[0]).toEqual({ kind: "quota", at: "t1", q5From: 10, q5To: 40, q7From: 5, q7To: 12 });
  });

  it("coalesces consecutive quota deltas (keeps original from, advances to)", () => {
    let hist: AccountChangeEntry[] = [];
    hist = appendAccountChanges(hist, snap({ quota5hPercent: 0 }), snap({ quota5hPercent: 20 }), "t1", 10);
    hist = appendAccountChanges(hist, snap({ quota5hPercent: 20 }), snap({ quota5hPercent: 55 }), "t2", 10);
    hist = appendAccountChanges(hist, snap({ quota5hPercent: 55 }), snap({ quota5hPercent: 90 }), "t3", 10);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toEqual({ kind: "quota", at: "t3", q5From: 0, q5To: 90, q7From: null, q7To: null });
  });

  it("a health flip seals the quota run; later quota deltas start a fresh entry", () => {
    let hist: AccountChangeEntry[] = [];
    hist = appendAccountChanges(hist, snap({ quota5hPercent: 0 }), snap({ quota5hPercent: 80 }), "t1", 10);
    hist = appendAccountChanges(
      hist,
      snap({ quota5hPercent: 80 }),
      snap({ health: "quota_exhausted", quota5hPercent: 80 }),
      "t2",
      10
    );
    hist = appendAccountChanges(
      hist,
      snap({ health: "quota_exhausted", quota5hPercent: 80 }),
      snap({ health: "quota_exhausted", quota5hPercent: 3 }),
      "t3",
      10
    );
    expect(hist.map((e) => e.kind)).toEqual(["quota", "health", "quota"]);
    expect(hist[0]).toMatchObject({ kind: "quota", q5From: 80, q5To: 3 });
    expect(hist[2]).toMatchObject({ kind: "quota", q5From: 0, q5To: 80 });
  });

  it("caps history to the configured limit (newest kept)", () => {
    let hist: AccountChangeEntry[] = [];
    // 交替 health 翻转产生独立条目（避免被 quota 合并）
    let h: "healthy" | "broken" = "healthy";
    for (let i = 0; i < 8; i++) {
      const nextH: "healthy" | "broken" = h === "healthy" ? "broken" : "healthy";
      hist = appendAccountChanges(hist, snap({ health: h }), snap({ health: nextH }), `t${i}`, 3);
      h = nextH;
    }
    expect(hist).toHaveLength(3);
    expect(hist[0]?.at).toBe("t7"); // 最新在 head
  });
});
