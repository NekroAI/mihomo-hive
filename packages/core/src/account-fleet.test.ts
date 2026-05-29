import { describe, expect, it } from "vitest";
import { defaultAccountFleetSpec, type AccountFleetSpec, type AccountRecordInternal } from "@mihomo-hive/schemas";
import { planAccountFleet, type AccountFleetInput } from "./account-fleet.js";

const NOW = new Date("2026-05-28T20:00:00Z");

function makeSpec(overrides: Partial<AccountFleetSpec> = {}): AccountFleetSpec {
  // 测试默认要求自动维护开启，并打开 recovery + registration 子开关
  // （默认 Spec 现在全部 disabled，方便用户安全启动 —— 但测试要看决策树各分支）
  return {
    ...defaultAccountFleetSpec,
    enabled: true,
    recovery: { ...defaultAccountFleetSpec.recovery, enabled: true },
    registration: { ...defaultAccountFleetSpec.registration, enabled: true },
    ...overrides
  };
}

function makeAcc(overrides: Partial<AccountRecordInternal> = {}): AccountRecordInternal {
  return {
    id: `a-${Math.random().toString(36).slice(2)}`,
    externalId: 100,
    origin: "hive_registered",
    intent: "active",
    health: "healthy",
    email: "test@example.com",
    organizationId: null,
    clientId: null,
    platform: "openai",
    type: "oauth",
    encPhone: "enc-phone",
    encPassword: "enc-pass",
    encRefreshToken: null,
    encAccessToken: null,
    encIdToken: null,
    encRecoveryInputJson: null,
    lastObservedAt: NOW.toISOString(),
    lastUsedAt: null,
    rateLimitedAt: null,
    rateLimitResetAt: null,
    quota5hPercent: null,
    quota7dPercent: null,
    errorsInWindow: 0,
    brokenSinceTick: null,
    brokenConsecutiveTicks: 0,
    recoveryAttempts: 0,
    nextRecoveryAfter: null,
    lastRecoveryError: null,
    lastRecoveryPath: null,
    lastRecoveryFailureCategory: null,
    batchId: null,
    registeredAt: null,
    smsCountry: null,
    smsCostCents: null,
    egressNodeHash: null,
    firstSeenAt: NOW.toISOString(),
    reloginCount: 0,
    lastRecoveredAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides
  };
}

function baseInput(overrides: Partial<AccountFleetInput> = {}): AccountFleetInput {
  return {
    now: NOW,
    spec: makeSpec(),
    localAccounts: [],
    budgetState: {
      dailyUsed: 0,
      dailyBudget: 50,
      monthlyUsed: 0,
      monthlyBudget: 1000
    },
    ...overrides
  };
}

describe("planAccountFleet", () => {
  describe("paused spec", () => {
    it("returns inferredSkippedReason='paused' and empty gated actions", () => {
      const r = planAccountFleet(
        baseInput({
          spec: makeSpec({ enabled: false }),
          localAccounts: [makeAcc({ health: "broken" })]
        })
      );
      expect(r.inferredSkippedReason).toBe("paused");
      expect(r.gatedActions).toHaveLength(0);
    });
  });

  describe("retired accounts never re-planned (P6-14)", () => {
    it("retired + broken account gets no recover_via_login / demote", () => {
      const r = planAccountFleet(
        baseInput({
          spec: makeSpec({
            recovery: { ...defaultAccountFleetSpec.recovery, enabled: true },
            registration: { ...defaultAccountFleetSpec.registration, enabled: false }
          }),
          localAccounts: [
            makeAcc({
              id: "dead-1",
              externalId: 1,
              intent: "retired",
              health: "broken",
              origin: "adopted_recovered",
              encPhone: "v1:x:y:z",
              encPassword: "v1:x:y:z"
            })
          ]
        })
      );
      const forDead = r.plannedActions.filter((a) => a.accountId === "dead-1");
      expect(forDead.filter((a) => a.kind === "recover_via_login")).toHaveLength(0);
      expect(forDead.filter((a) => a.kind === "recover_via_register")).toHaveLength(0);
      expect(forDead.filter((a) => a.kind === "demote_to_observing")).toHaveLength(0);
    });
  });

  describe("diagnose", () => {
    it("clears rate_limited when reset_at is past", () => {
      const acc = makeAcc({
        rateLimitedAt: "2026-05-27T00:00:00Z",
        rateLimitResetAt: "2026-05-28T00:00:00Z" // 已过期
      });
      const r = planAccountFleet(baseInput({ localAccounts: [acc] }));
      const updated = r.observedAccounts[0]!;
      expect(updated.rateLimitedAt).toBeNull();
      expect(updated.health).toBe("healthy");
    });

    it("keeps rate_limited when reset_at in future", () => {
      const acc = makeAcc({
        rateLimitedAt: "2026-05-28T19:00:00Z",
        rateLimitResetAt: "2026-05-30T00:00:00Z"
      });
      const r = planAccountFleet(baseInput({ localAccounts: [acc] }));
      const updated = r.observedAccounts[0]!;
      expect(updated.health).toBe("rate_limited");
    });

    it("quota >= threshold → quota_exhausted", () => {
      const acc = makeAcc({ quota7dPercent: 96 });
      const r = planAccountFleet(baseInput({ localAccounts: [acc] }));
      expect(r.observedAccounts[0]!.health).toBe("quota_exhausted");
    });

    it("upstream errors ≥ budget → broken", () => {
      const acc = makeAcc({ externalId: 42 });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      expect(r.observedAccounts[0]!.health).toBe("broken");
    });

    it("Sub2API status=error（token revoked）→ broken，优先于配额判定（P5-AM）", () => {
      // 即便配额很低（healthy 区间），只要 Sub2API 标了 auth error 就应判 broken
      const acc = makeAcc({ externalId: 42, quota7dPercent: 10 });
      const r = planAccountFleet(
        baseInput({
          localAccounts: [acc],
          remoteAuthErrorByExternalId: new Map([[42, "Sub2API: Token revoked (401)"]])
        })
      );
      expect(r.observedAccounts[0]!.health).toBe("broken");
      expect(r.observedAccounts[0]!.lastRecoveryError).toContain("Token revoked");
    });

    it("brokenConsecutiveTicks increments while broken, resets when healthy", () => {
      let acc = makeAcc({ externalId: 42, brokenConsecutiveTicks: 2 });
      let r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      expect(r.observedAccounts[0]!.brokenConsecutiveTicks).toBe(3);
      acc = makeAcc({ externalId: 42, brokenConsecutiveTicks: 5 });
      r = planAccountFleet(baseInput({ localAccounts: [acc] }));
      expect(r.observedAccounts[0]!.brokenConsecutiveTicks).toBe(0);
      expect(r.observedAccounts[0]!.brokenSinceTick).toBeNull();
    });
  });

  describe("path A: codex_login (has phone+password)", () => {
    it("broken hive_registered with phone+pwd → recover_via_login", () => {
      const acc = makeAcc({
        origin: "hive_registered",
        encPhone: "enc",
        encPassword: "enc",
        externalId: 42
      });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const recovers = r.gatedActions.filter((a) => a.kind === "recover_via_login");
      expect(recovers).toHaveLength(1);
      expect(recovers[0]?.accountId).toBe(acc.id);
    });
  });

  describe("path B: codex_register (no phone+password)", () => {
    it("broken hive_registered without phone+pwd → recover_via_register", () => {
      const acc = makeAcc({
        origin: "hive_registered",
        encPhone: null,
        encPassword: null,
        externalId: 42
      });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const recovers = r.gatedActions.filter((a) => a.kind === "recover_via_register");
      expect(recovers).toHaveLength(1);
    });

    it("register disabled → defer instead of register", () => {
      const acc = makeAcc({
        origin: "hive_registered",
        encPhone: null,
        encPassword: null,
        externalId: 42
      });
      const r = planAccountFleet(
        baseInput({
          spec: makeSpec({
            recovery: { ...defaultAccountFleetSpec.recovery, enabled: true, pathPriority: ["codex_login"] }
          }),
          localAccounts: [acc],
          upstreamErrorsByAccountId: new Map([[42, 10]])
        })
      );
      const recovers = r.gatedActions.filter(
        (a) => a.kind === "recover_via_login" || a.kind === "recover_via_register"
      );
      expect(recovers).toHaveLength(0);
      const defers = r.gatedActions.filter((a) => a.kind === "defer");
      expect(defers).toHaveLength(1);
    });
  });

  describe("origin gating", () => {
    it("retired_legacy is skipped entirely", () => {
      const acc = makeAcc({ origin: "retired_legacy", externalId: 42 });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      expect(r.gatedActions.filter((a) => a.kind === "recover_via_login" || a.kind === "recover_via_register")).toHaveLength(0);
      expect(r.gatedActions.filter((a) => a.kind === "retire")).toHaveLength(0);
    });

    it("adopted_observing broken: no recover, no retire, no demote", () => {
      const acc = makeAcc({ origin: "adopted_observing", externalId: 42 });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const ours = r.gatedActions.filter((a) => a.accountId === acc.id);
      // 只能有 observe_usage（如果到时间了）；不会有 recover/retire
      const meaningful = ours.filter((a) => a.kind !== "observe_usage");
      expect(meaningful).toHaveLength(0);
    });

    it("adopted_active broken < demotion threshold: no demote, no recover", () => {
      const acc = makeAcc({
        origin: "adopted_active",
        externalId: 42,
        brokenConsecutiveTicks: 1 // < 默认 3
      });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const ours = r.gatedActions.filter((a) => a.accountId === acc.id && a.kind !== "observe_usage");
      // 不该 demote / recover；可能有 defer（如果还有计划）
      expect(ours.filter((a) => a.kind === "demote_to_observing")).toHaveLength(0);
      expect(ours.filter((a) => a.kind === "recover_via_login")).toHaveLength(0);
    });

    it("adopted_active broken ≥ demotion threshold: triggers demote", () => {
      const acc = makeAcc({
        origin: "adopted_active",
        externalId: 42,
        brokenConsecutiveTicks: 2 // 经过 plan 再 +1 = 3，满足默认阈值
      });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const demotes = r.gatedActions.filter((a) => a.kind === "demote_to_observing");
      expect(demotes).toHaveLength(1);
    });
  });

  describe("retirement", () => {
    it("max attempts exhausted → retire", () => {
      const acc = makeAcc({
        recoveryAttempts: 5, // = default max
        externalId: 42
      });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const retires = r.gatedActions.filter((a) => a.kind === "retire");
      expect(retires).toHaveLength(1);
    });

    it("dead for > N days → retire", () => {
      const acc = makeAcc({
        lastUsedAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        externalId: 42
      });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const retires = r.gatedActions.filter((a) => a.kind === "retire");
      expect(retires).toHaveLength(1);
    });
  });

  describe("supply (register_new)", () => {
    it("plans register_new to fill gap, capped by perTickCap (non-emergency)", () => {
      const spec = makeSpec({
        target: {
          ...defaultAccountFleetSpec.target,
          healthyAccountsTarget: 10,
          minHealthyRatio: 0, // 关掉 emergency 触发
          registerBias: 100 // 全力注册补满，隔离 cap 行为（不受均衡度影响）
        },
        registration: {
          ...defaultAccountFleetSpec.registration,
          enabled: true,
          emergencyMode: { ...defaultAccountFleetSpec.registration.emergencyMode, enabled: false }
        }
      });
      const r = planAccountFleet(
        baseInput({
          spec,
          localAccounts: [] // healthy = 0, gap = 10
        })
      );
      const news = r.gatedActions.filter((a) => a.kind === "register_new");
      expect(news).toHaveLength(spec.registration.perTickCap); // default 5
    });

    it("registerBias 缩减注册数量，缺口其余留给重登 (P5-AW)", () => {
      const spec = makeSpec({
        target: {
          ...defaultAccountFleetSpec.target,
          healthyAccountsTarget: 10,
          minHealthyRatio: 0,
          registerBias: 30 // 缺口 10 → ceil(10*0.3)=3
        },
        registration: {
          ...defaultAccountFleetSpec.registration,
          enabled: true,
          perTickCap: 20, // 不让 cap 成为约束
          emergencyMode: { ...defaultAccountFleetSpec.registration.emergencyMode, enabled: false }
        }
      });
      const r = planAccountFleet(baseInput({ spec, localAccounts: [] }));
      expect(r.gatedActions.filter((a) => a.kind === "register_new")).toHaveLength(3);
    });

    it("daily budget exhausted → no register, inferredSkippedReason=budget_exhausted", () => {
      const spec = makeSpec({
        target: { ...defaultAccountFleetSpec.target, healthyAccountsTarget: 10 }
      });
      const r = planAccountFleet(
        baseInput({
          spec,
          localAccounts: [],
          budgetState: { dailyUsed: 50, dailyBudget: 50, monthlyUsed: 50, monthlyBudget: 1000 }
        })
      );
      const news = r.gatedActions.filter((a) => a.kind === "register_new");
      expect(news).toHaveLength(0);
      expect(r.inferredSkippedReason).toBe("budget_exhausted");
    });

    it("monthly budget exhausted blocks register even with daily room", () => {
      const spec = makeSpec({
        target: { ...defaultAccountFleetSpec.target, healthyAccountsTarget: 10 }
      });
      const r = planAccountFleet(
        baseInput({
          spec,
          localAccounts: [],
          budgetState: { dailyUsed: 0, dailyBudget: 50, monthlyUsed: 1000, monthlyBudget: 1000 }
        })
      );
      expect(r.gatedActions.filter((a) => a.kind === "register_new")).toHaveLength(0);
    });

    it("emergency mode boosts perTickCap when healthy/target < minHealthyRatio", () => {
      const spec = makeSpec({
        target: {
          ...defaultAccountFleetSpec.target,
          healthyAccountsTarget: 100,
          minHealthyRatio: 0.8
        },
        registration: {
          ...defaultAccountFleetSpec.registration,
          enabled: true,
          emergencyMode: { ...defaultAccountFleetSpec.registration.emergencyMode, enabled: true }
        }
      });
      // healthy=10/100=0.1 < 0.8 → emergency mode → perTickCap=10
      const r = planAccountFleet(baseInput({ spec, localAccounts: [] }));
      expect(r.observedSummary.emergencyMode).toBe(true);
      const news = r.gatedActions.filter((a) => a.kind === "register_new");
      expect(news).toHaveLength(spec.registration.emergencyMode.perTickCap);
    });
  });

  describe("sense (adopt from remote)", () => {
    it("remote account not in local → adopted_active when has_refresh_token=true", () => {
      const r = planAccountFleet(
        baseInput({
          localAccounts: [],
          remoteAccounts: [
            {
              id: 555,
              name: "Remote-1",
              status: "active",
              credentials_status: { has_refresh_token: true },
              credentials: { email: "remote@x.com" }
            } as never
          ]
        })
      );
      const adopted = r.observedAccounts.find((a) => a.externalId === 555);
      expect(adopted).toBeDefined();
      expect(adopted?.origin).toBe("adopted_active");
      // 关键回归：email 必须从 credentials.email 取，不是 "unknown-555"
      expect(adopted?.email).toBe("remote@x.com");
    });

    it("remote has_refresh_token=false → adopted_observing", () => {
      const r = planAccountFleet(
        baseInput({
          localAccounts: [],
          remoteAccounts: [
            {
              id: 666,
              name: "Remote-2",
              status: "rate_limited",
              credentials_status: { has_refresh_token: false },
              credentials: { email: "r@x.com" }
            } as never
          ]
        })
      );
      const adopted = r.observedAccounts.find((a) => a.externalId === 666);
      expect(adopted?.origin).toBe("adopted_observing");
      expect(adopted?.email).toBe("r@x.com");
    });

    it("syncs rate_limited_at + quota + last_used_at from Sub2API record", () => {
      const r = planAccountFleet(
        baseInput({
          localAccounts: [],
          remoteAccounts: [
            {
              id: 777,
              name: "Remote-3",
              status: "active",
              credentials_status: { has_refresh_token: true },
              credentials: { email: "x@y.com", organization_id: "org-1", client_id: "app_x" },
              extra: { codex_5h_used_percent: 30, codex_7d_used_percent: 87 },
              last_used_at: "2026-05-28T10:00:00Z",
              rate_limited_at: "2026-05-27T00:00:00Z",
              rate_limit_reset_at: "2026-05-28T23:00:00Z"
            } as never
          ]
        })
      );
      const adopted = r.observedAccounts.find((a) => a.externalId === 777);
      expect(adopted?.email).toBe("x@y.com");
      expect(adopted?.organizationId).toBe("org-1");
      expect(adopted?.clientId).toBe("app_x");
      expect(adopted?.lastUsedAt).toBe("2026-05-28T10:00:00Z");
      expect(adopted?.rateLimitedAt).toBe("2026-05-27T00:00:00Z");
      expect(adopted?.rateLimitResetAt).toBe("2026-05-28T23:00:00Z");
      expect(adopted?.quota5hPercent).toBe(30);
      expect(adopted?.quota7dPercent).toBe(87);
    });

    it("diagnose: rate_limited record with future reset_at → rate_limited (not healthy)", () => {
      const futureReset = new Date(NOW.getTime() + 3600_000).toISOString();
      const r = planAccountFleet(
        baseInput({
          localAccounts: [],
          remoteAccounts: [
            {
              id: 888,
              name: "Remote-RL",
              status: "rate_limited",
              credentials_status: { has_refresh_token: true },
              credentials: { email: "rl@x.com" },
              rate_limited_at: "2026-05-28T19:00:00Z",
              rate_limit_reset_at: futureReset
            } as never
          ]
        })
      );
      const adopted = r.observedAccounts.find((a) => a.externalId === 888);
      // 经过 diagnose 后应该是 rate_limited，不是 healthy
      expect(adopted?.health).toBe("rate_limited");
    });

    it("diagnose: quota 7d ≥ 95% → quota_exhausted", () => {
      const r = planAccountFleet(
        baseInput({
          localAccounts: [],
          remoteAccounts: [
            {
              id: 999,
              name: "Remote-Q",
              status: "active",
              credentials_status: { has_refresh_token: true },
              credentials: { email: "q@x.com" },
              extra: { codex_7d_used_percent: 97 }
            } as never
          ]
        })
      );
      const adopted = r.observedAccounts.find((a) => a.externalId === 999);
      expect(adopted?.health).toBe("quota_exhausted");
    });

    it("update existing record: backfills email from credentials when prior value was unknown-XX", () => {
      const existing = makeAcc({ externalId: 1000, email: "unknown-1000" });
      const r = planAccountFleet(
        baseInput({
          localAccounts: [existing],
          remoteAccounts: [
            {
              id: 1000,
              name: "Old",
              status: "active",
              credentials_status: { has_refresh_token: true },
              credentials: { email: "real@x.com" }
            } as never
          ]
        })
      );
      const updated = r.observedAccounts.find((a) => a.id === existing.id);
      expect(updated?.email).toBe("real@x.com");
    });

    it("local active but remote gone → marked retired", () => {
      const acc = makeAcc({ externalId: 777, intent: "active" });
      const r = planAccountFleet(baseInput({ localAccounts: [acc], remoteAccounts: [] }));
      const lost = r.observedAccounts.find((a) => a.externalId === 777);
      expect(lost?.intent).toBe("retired");
    });

    it("local pending (register in flight) + remote gone → stays pending", () => {
      const acc = makeAcc({ externalId: null, intent: "pending" });
      const r = planAccountFleet(baseInput({ localAccounts: [acc], remoteAccounts: [] }));
      const same = r.observedAccounts.find((a) => a.id === acc.id);
      expect(same?.intent).toBe("pending");
    });
  });

  describe("observe_usage scheduling", () => {
    it("recently observed account skipped", () => {
      const acc = makeAcc({
        externalId: 42,
        lastObservedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() // 10min ago, < 30min default
      });
      const r = planAccountFleet(baseInput({ localAccounts: [acc] }));
      expect(r.gatedActions.filter((a) => a.kind === "observe_usage")).toHaveLength(0);
    });

    it("stale account triggers observe_usage", () => {
      const acc = makeAcc({
        externalId: 42,
        lastObservedAt: new Date(NOW.getTime() - 45 * 60_000).toISOString() // > 30min
      });
      const r = planAccountFleet(baseInput({ localAccounts: [acc] }));
      expect(r.gatedActions.filter((a) => a.kind === "observe_usage")).toHaveLength(1);
    });
  });

  describe("backoff", () => {
    it("broken account in backoff window → defer, no recover", () => {
      const acc = makeAcc({
        origin: "hive_registered",
        externalId: 42,
        nextRecoveryAfter: new Date(NOW.getTime() + 10 * 60_000).toISOString() // 10 min in future
      });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const defers = r.gatedActions.filter((a) => a.kind === "defer" && a.accountId === acc.id);
      expect(defers).toHaveLength(1);
      expect(r.gatedActions.filter((a) => a.kind === "recover_via_login")).toHaveLength(0);
    });

    it("backoff expired → recover proceeds", () => {
      const acc = makeAcc({
        origin: "hive_registered",
        externalId: 42,
        nextRecoveryAfter: new Date(NOW.getTime() - 1).toISOString()
      });
      const r = planAccountFleet(
        baseInput({ localAccounts: [acc], upstreamErrorsByAccountId: new Map([[42, 10]]) })
      );
      const recovers = r.gatedActions.filter((a) => a.kind === "recover_via_login");
      expect(recovers).toHaveLength(1);
    });
  });

  describe("graceBatch + perTickRecoveryCap", () => {
    it("perTickRecoveryCap limits the number of recover actions", () => {
      const spec = makeSpec({
        recovery: { ...defaultAccountFleetSpec.recovery, enabled: true, perTickRecoveryCap: 2 },
        graceBatchAbs: 100
      });
      // 5 broken hive_registered accounts
      const accounts = Array.from({ length: 5 }, (_, i) =>
        makeAcc({ id: `a${i}`, externalId: 100 + i })
      );
      const errors = new Map<number, number>();
      for (const a of accounts) errors.set(a.externalId!, 10);
      const r = planAccountFleet(baseInput({ spec, localAccounts: accounts, upstreamErrorsByAccountId: errors }));
      const recovers = r.gatedActions.filter((a) => a.kind === "recover_via_login");
      expect(recovers).toHaveLength(2);
    });

    it("graceBatch caps total changes", () => {
      const spec = makeSpec({
        graceBatchPercent: 0, // 用 graceBatchAbs only
        graceBatchAbs: 2,
        recovery: { ...defaultAccountFleetSpec.recovery, enabled: true, perTickRecoveryCap: 100 },
        target: { ...defaultAccountFleetSpec.target, healthyAccountsTarget: 0 }
      });
      const accounts = Array.from({ length: 5 }, (_, i) =>
        makeAcc({ id: `a${i}`, externalId: 100 + i })
      );
      const errors = new Map<number, number>();
      for (const a of accounts) errors.set(a.externalId!, 10);
      const r = planAccountFleet(baseInput({ spec, localAccounts: accounts, upstreamErrorsByAccountId: errors }));
      const recovers = r.gatedActions.filter((a) => a.kind === "recover_via_login");
      expect(recovers).toHaveLength(2); // capped by graceBatchAbs
    });
  });
});
