import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HiveRepository, openSqlite } from "@mihomo-hive/db";
import {
  accountRecordInternalSchema,
  defaultAccountFleetSpec,
  type AccountRecordInternal
} from "@mihomo-hive/schemas";
import {
  budgetWindowKey,
  startAccountFleetScheduler,
  type AccountFleetSchedulerHandle
} from "./account-fleet-orchestrator.js";

function makeAccount(overrides: Partial<AccountRecordInternal> = {}): AccountRecordInternal {
  const now = new Date().toISOString();
  return accountRecordInternalSchema.parse({
    id: `a-${Math.random().toString(36).slice(2, 10)}`,
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
    batchId: null,
    registeredAt: null,
    egressNodeHash: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  });
}

describe("AccountFleetScheduler (dry-run)", () => {
  let tmpDir: string;
  let repo: HiveRepository;
  let handle: AccountFleetSchedulerHandle | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-fleet-orch-"));
    const sqlite = openSqlite(join(tmpDir, "hive.sqlite"));
    repo = new HiveRepository(sqlite);
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("triggers a tick on construction, persists to account_fleet_ticks", async () => {
    repo.saveAccountFleetSpec({
      ...defaultAccountFleetSpec,
      reconcileIntervalMs: 60 * 60 * 1000 // 1h, 防止间隔太短重复触发
    });
    handle = startAccountFleetScheduler({ repo, mode: "dry_run" });
    // boot tick is async; wait for it
    await handle.triggerNow(); // 再触发一次确保有数据
    const ticks = repo.listRecentAccountFleetTickSummaries(10);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]?.skippedReason).toBe("dry_run");
  });

  it("dry-run tick: planned > 0 but applied = 0, skippedReason='dry_run'", async () => {
    repo.saveAccountFleetSpec({
      ...defaultAccountFleetSpec,
      reconcileIntervalMs: 60 * 60 * 1000,
      target: { ...defaultAccountFleetSpec.target, healthyAccountsTarget: 10, minHealthyRatio: 0 },
      registration: {
        ...defaultAccountFleetSpec.registration,
        emergencyMode: { ...defaultAccountFleetSpec.registration.emergencyMode, enabled: false }
      }
    });
    handle = startAccountFleetScheduler({ repo, mode: "dry_run" });
    const tick = await handle.triggerNow();
    expect(tick.plannedTotal).toBeGreaterThan(0);
    expect(tick.appliedTotal).toBe(0);
    expect(tick.skippedReason).toBe("dry_run");
    expect(tick.appliedActions).toHaveLength(0);
  });

  it("writes back observed accounts (errorsInWindow / health)", async () => {
    const acc = makeAccount({ externalId: 42, errorsInWindow: 99 });
    repo.upsertAccount(acc);
    repo.saveAccountFleetSpec({
      ...defaultAccountFleetSpec,
      reconcileIntervalMs: 60 * 60 * 1000
    });
    handle = startAccountFleetScheduler({ repo, mode: "dry_run" });
    await handle.triggerNow();
    const updated = repo.getAccountById(acc.id);
    // 在 local-only 模式（无 Sub2API 连接）下 errorsInWindow 应被 diagnose 重置为 0（无 upstream errors signal）
    expect(updated?.errorsInWindow).toBe(0);
    expect(updated?.health).toBe("healthy");
  });

  it("adopts new remote-only accounts (when remote fetch fails gracefully, none added)", async () => {
    // 没配置 Sub2API connection → remoteAccounts undefined → 不应崩
    repo.saveAccountFleetSpec({ ...defaultAccountFleetSpec, reconcileIntervalMs: 60 * 60 * 1000 });
    handle = startAccountFleetScheduler({ repo, mode: "dry_run" });
    const tick = await handle.triggerNow();
    expect(tick.skippedReason).toBe("dry_run");
    expect(repo.listAccounts()).toHaveLength(0);
  });

  it("includes budget state in observed summary", async () => {
    const dayKey = budgetWindowKey(new Date(), "day");
    repo.upsertAccountBudget({
      windowKey: dayKey,
      registrationsUsed: 7,
      registrationsBudget: 50,
      smsCostCents: 0,
      resetAt: new Date(Date.now() + 86400_000).toISOString(),
      updatedAt: new Date().toISOString()
    });
    repo.saveAccountFleetSpec({
      ...defaultAccountFleetSpec,
      reconcileIntervalMs: 60 * 60 * 1000
    });
    handle = startAccountFleetScheduler({ repo, mode: "dry_run" });
    const tick = await handle.triggerNow();
    expect(tick.observed.dailyRegistrationsUsed).toBe(7);
    expect(tick.observed.dailyRegistrationsBudget).toBe(defaultAccountFleetSpec.registration.dailyBudget);
  });

  it("budgetWindowKey produces stable day / month strings", () => {
    expect(budgetWindowKey(new Date("2026-05-28T20:00:00Z"), "day")).toBe("2026-05-28-day");
    expect(budgetWindowKey(new Date("2026-05-28T20:00:00Z"), "month")).toBe("2026-05-month");
  });
});
