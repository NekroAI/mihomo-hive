import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { accountRecordInternalSchema, defaultAccountFleetSpec, type AccountFleetTick, type AccountJob, type AccountRecordInternal } from "@mihomo-hive/schemas";
import { openSqlite } from "./client.js";
import { HiveRepository } from "./repository.js";

function makeAccount(overrides: Partial<AccountRecordInternal> = {}): AccountRecordInternal {
  const now = new Date().toISOString();
  return accountRecordInternalSchema.parse({
    id: `acc-${Math.random().toString(36).slice(2, 10)}`,
    externalId: null,
    origin: "hive_registered",
    intent: "active",
    health: "healthy",
    email: "test@example.com",
    organizationId: null,
    clientId: null,
    platform: "openai",
    type: "oauth",
    encPhone: null,
    encPassword: null,
    encRefreshToken: null,
    encAccessToken: null,
    encIdToken: null,
    encRecoveryInputJson: null,
    lastObservedAt: null,
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
    firstSeenAt: now,
    reloginCount: 0,
    lastRecoveredAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  });
}

describe("HiveRepository account-fleet", () => {
  let tmpDir: string;
  let repo: HiveRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-fleet-"));
    const sqlite = openSqlite(join(tmpDir, "hive.sqlite"));
    repo = new HiveRepository(sqlite);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("spec", () => {
    it("returns default spec when nothing saved", () => {
      expect(repo.getAccountFleetSpec()).toEqual(defaultAccountFleetSpec);
    });

    it("round-trips a saved spec", () => {
      const next = {
        ...defaultAccountFleetSpec,
        target: { ...defaultAccountFleetSpec.target, healthyAccountsTarget: 99 }
      };
      const returned = repo.saveAccountFleetSpec(next);
      expect(returned.target.healthyAccountsTarget).toBe(99);
      expect(repo.getAccountFleetSpec().target.healthyAccountsTarget).toBe(99);
    });

    it("falls back to default when stored JSON is malformed (no crash)", () => {
      // 写入坏数据走 settings 接口
      const sqlite = (repo as unknown as { sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } } })
        .sqlite;
      sqlite
        .prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)")
        .run("account_fleet.spec", "not json {");
      expect(repo.getAccountFleetSpec()).toEqual(defaultAccountFleetSpec);
    });
  });

  describe("accounts", () => {
    it("upsert + list round trip", () => {
      const a = makeAccount({ email: "alice@example.com" });
      const b = makeAccount({ email: "bob@example.com", origin: "adopted_observing", intent: "active" });
      repo.upsertAccount(a);
      repo.upsertAccount(b);
      const listed = repo.listAccounts();
      expect(listed).toHaveLength(2);
      expect(listed.map((x) => x.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    });

    it("ON CONFLICT updates by id", () => {
      const a = makeAccount({ email: "alice@example.com", health: "healthy" });
      repo.upsertAccount(a);
      repo.upsertAccount({ ...a, health: "broken" });
      const fetched = repo.getAccountById(a.id);
      expect(fetched?.health).toBe("broken");
    });

    it("getAccountByExternalId works", () => {
      const a = makeAccount({ externalId: 100 });
      repo.upsertAccount(a);
      expect(repo.getAccountByExternalId(100)?.id).toBe(a.id);
      expect(repo.getAccountByExternalId(999)).toBeUndefined();
    });

    it("rejects duplicate external_id (UNIQUE constraint)", () => {
      const a = makeAccount({ externalId: 7 });
      const b = makeAccount({ externalId: 7 });
      repo.upsertAccount(a);
      expect(() => repo.upsertAccount(b)).toThrow();
    });

    it("findAccountsByEmail returns all matches", () => {
      const a = makeAccount({ email: "shared@x.com" });
      const b = makeAccount({ email: "shared@x.com", externalId: 5 });
      repo.upsertAccount(a);
      repo.upsertAccount(b);
      expect(repo.findAccountsByEmail("shared@x.com")).toHaveLength(2);
      expect(repo.findAccountsByEmail("missing@x.com")).toHaveLength(0);
    });

    it("patchAccount updates select fields and bumps updated_at", async () => {
      const a = makeAccount();
      repo.upsertAccount(a);
      const original = repo.getAccountById(a.id)!;
      await new Promise((r) => setTimeout(r, 10)); // 保证 updated_at 不同
      const patched = repo.patchAccount(a.id, {
        health: "broken",
        externalId: 42,
        encRefreshToken: "v1:iv:tag:ct"
      });
      expect(patched?.health).toBe("broken");
      expect(patched?.externalId).toBe(42);
      expect(patched?.encRefreshToken).toBe("v1:iv:tag:ct");
      expect(patched?.updatedAt).not.toBe(original.updatedAt);
    });

    it("patchAccount no-op for empty patch", () => {
      const a = makeAccount();
      repo.upsertAccount(a);
      const result = repo.patchAccount(a.id, {});
      expect(result?.id).toBe(a.id);
    });

    it("deleteAccount removes by id", () => {
      const a = makeAccount();
      repo.upsertAccount(a);
      expect(repo.deleteAccount(a.id)).toBe(true);
      expect(repo.getAccountById(a.id)).toBeUndefined();
      expect(repo.deleteAccount("nope")).toBe(false);
    });

    it("origin / intent / health enum constraints enforced by DB", () => {
      const a = makeAccount();
      repo.upsertAccount(a);
      const sqlite = (repo as unknown as { sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } } })
        .sqlite;
      expect(() =>
        sqlite.prepare("UPDATE accounts SET origin = 'bad' WHERE id = ?").run(a.id)
      ).toThrow();
    });

    it("P5-AQ quality metrics roundtrip + relogin_count patch", () => {
      const a = makeAccount({
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        reloginCount: 2,
        lastRecoveredAt: "2026-05-01T00:00:00.000Z"
      });
      repo.upsertAccount(a);
      const got = repo.getAccountById(a.id)!;
      expect(got.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
      expect(got.reloginCount).toBe(2);
      expect(got.lastRecoveredAt).toBe("2026-05-01T00:00:00.000Z");

      const patched = repo.patchAccount(a.id, {
        reloginCount: 3,
        lastRecoveredAt: "2026-05-29T00:00:00.000Z"
      });
      expect(patched?.reloginCount).toBe(3);
      expect(patched?.lastRecoveredAt).toBe("2026-05-29T00:00:00.000Z");
      // firstSeenAt 不变
      expect(patched?.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("account_jobs", () => {
    function makeJob(overrides: Partial<AccountJob> = {}): AccountJob {
      const now = new Date().toISOString();
      return {
        id: `job-${Math.random().toString(36).slice(2)}`,
        kind: "codex_login",
        accountId: null,
        status: "queued",
        attempt: 0,
        maxAttempts: 1,
        priority: 100,
        scheduledAt: now,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        payloadJson: "{}",
        resultJson: null,
        errorMessage: null,
        triggeredBy: "scheduler",
        triggeredTickId: null,
        createdAt: now,
        updatedAt: now,
        ...overrides
      };
    }

    it("enqueue + claim FIFO by priority then scheduled_at", () => {
      const t0 = new Date("2026-05-28T10:00:00Z").toISOString();
      const t1 = new Date("2026-05-28T10:00:01Z").toISOString();
      const future = new Date("2030-01-01T00:00:00Z").toISOString();

      const lowPriority = makeJob({ id: "low", priority: 50, scheduledAt: t1 });
      const highPriority = makeJob({ id: "high", priority: 10, scheduledAt: t1 });
      const earlier = makeJob({ id: "early", priority: 10, scheduledAt: t0 });
      const futureJob = makeJob({ id: "future", priority: 5, scheduledAt: future });

      repo.enqueueAccountJob(lowPriority);
      repo.enqueueAccountJob(highPriority);
      repo.enqueueAccountJob(earlier);
      repo.enqueueAccountJob(futureJob);

      // claim 应该按 priority 升序 → scheduled_at 升序，且不取 future 的
      const claimed = repo.claimNextAccountJob(t1);
      expect(claimed?.id).toBe("early");
    });

    it("updateAccountJob mutates status + lifecycle fields", () => {
      const job = makeJob({ id: "j1" });
      repo.enqueueAccountJob(job);
      const updated = repo.updateAccountJob("j1", {
        status: "running",
        startedAt: new Date().toISOString(),
        attempt: 1
      });
      expect(updated?.status).toBe("running");
      expect(updated?.attempt).toBe(1);
      expect(updated?.startedAt).not.toBeNull();
    });

    it("countRunningAccountJobs", () => {
      repo.enqueueAccountJob(makeJob({ id: "a", status: "queued" }));
      repo.enqueueAccountJob(makeJob({ id: "b" }));
      repo.updateAccountJob("b", { status: "running" });
      expect(repo.countRunningAccountJobs()).toBe(1);
    });

    it("pruneAccountJobs only removes terminal old jobs", () => {
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      repo.enqueueAccountJob(makeJob({ id: "old-success" }));
      repo.updateAccountJob("old-success", { status: "succeeded", finishedAt: ancient });
      repo.enqueueAccountJob(makeJob({ id: "old-running" }));
      repo.updateAccountJob("old-running", { status: "running", startedAt: ancient });
      repo.enqueueAccountJob(makeJob({ id: "recent-failed" }));
      repo.updateAccountJob("recent-failed", { status: "failed", finishedAt: recent });

      const removed = repo.pruneAccountJobs(7);
      expect(removed).toBe(1); // 只 old-success 被删
      expect(repo.getAccountJob("old-running")).toBeDefined();
      expect(repo.getAccountJob("recent-failed")).toBeDefined();
    });
  });

  describe("account_fleet_ticks", () => {
    function makeTick(overrides: Partial<AccountFleetTick> = {}): AccountFleetTick {
      const now = new Date().toISOString();
      return {
        id: `tick-${Math.random().toString(36).slice(2)}`,
        startedAt: now,
        finishedAt: now,
        durationMs: 10,
        enabled: true,
        skippedReason: "no_change",
        plannedTotal: 0,
        appliedTotal: 0,
        observed: {
          totalAccounts: 0,
          byHealth: { healthy: 0, rate_limited: 0, quota_exhausted: 0, broken: 0, unknown: 0 },
          byOrigin: {
            hive_registered: 0,
            adopted_active: 0,
            adopted_recovered: 0,
            adopted_observing: 0,
            retired_legacy: 0
          },
          byIntent: { pending: 0, active: 0, recovering: 0, retired: 0 },
          healthyCount: 0,
          target: 50,
          targetGap: 50,
          minHealthyRatio: 0.8,
          emergencyMode: false,
          dailyRegistrationsUsed: 0,
          dailyRegistrationsBudget: 50,
          monthlyRegistrationsUsed: 0,
          monthlyRegistrationsBudget: 1000
        },
        plannedActions: [],
        appliedActions: [],
        triggeredJobIds: [],
        ...overrides
      };
    }

    it("append + read by id", () => {
      const t = makeTick();
      repo.appendAccountFleetTick(t);
      const fetched = repo.getAccountFleetTick(t.id);
      expect(fetched?.id).toBe(t.id);
      expect(fetched?.observed.target).toBe(50);
    });

    it("listRecentAccountFleetTickSummaries returns DESC by started_at", async () => {
      const t1 = makeTick({ id: "t1", startedAt: new Date("2026-05-28T10:00:00Z").toISOString() });
      const t2 = makeTick({ id: "t2", startedAt: new Date("2026-05-28T10:00:01Z").toISOString() });
      repo.appendAccountFleetTick(t1);
      repo.appendAccountFleetTick(t2);
      const summaries = repo.listRecentAccountFleetTickSummaries(10);
      expect(summaries.map((x) => x.id)).toEqual(["t2", "t1"]);
    });

    it("pruneAccountFleetTicks removes old entries", () => {
      const old = makeTick({ id: "old", startedAt: "2020-01-01T00:00:00Z" });
      const recent = makeTick({ id: "recent" });
      repo.appendAccountFleetTick(old);
      repo.appendAccountFleetTick(recent);
      const removed = repo.pruneAccountFleetTicks(7);
      expect(removed).toBe(1);
    });
  });

  describe("account_budgets", () => {
    it("upsert + read", () => {
      const now = new Date().toISOString();
      const r = repo.upsertAccountBudget({
        windowKey: "2026-05-28-day",
        registrationsUsed: 3,
        registrationsBudget: 50,
        smsCostCents: 20,
        resetAt: now,
        updatedAt: now
      });
      expect(r.registrationsUsed).toBe(3);
      expect(repo.getAccountBudget("2026-05-28-day")?.registrationsUsed).toBe(3);
    });

    it("incrementBudgetUsage accumulates atomically", () => {
      const resetAt = new Date(Date.now() + 86400_000).toISOString();
      repo.incrementBudgetUsage({
        windowKey: "2026-05-28-day",
        registrationsBudget: 50,
        resetAt,
        deltaRegistrations: 2,
        deltaSmsCostCents: 10
      });
      repo.incrementBudgetUsage({
        windowKey: "2026-05-28-day",
        registrationsBudget: 50,
        resetAt,
        deltaRegistrations: 3,
        deltaSmsCostCents: 15
      });
      const b = repo.getAccountBudget("2026-05-28-day")!;
      expect(b.registrationsUsed).toBe(5);
      expect(b.smsCostCents).toBe(25);
      expect(b.registrationsBudget).toBe(50);
    });
  });
});
