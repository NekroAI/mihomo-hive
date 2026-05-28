import React from "react";
import {
  Activity,
  AlertOctagon,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  ShieldCheck,
  XCircle
} from "lucide-react";
import type {
  AccountFleetStatusSnapshot,
  AccountFleetTickSummary,
  AccountHealth,
  AccountIntent,
  AccountJob,
  AccountOrigin,
  AccountRecordView
} from "@mihomo-hive/schemas";
import { Badge, EmptyState, Panel } from "../../components/ui.js";

/**
 * 账号编排状态右栏 —— 跟 OrchestrationStatusPanel 同形：
 *   KPI 4 卡 → 账号矩阵 → 最近调和 feed → 最近 jobs feed
 *
 * 所有操作按钮在左栏；右栏纯展示 + 单条 tick / job 展开详情。
 */
export function AccountFleetStatusPanel(props: {
  snapshot: AccountFleetStatusSnapshot | undefined;
  loading: boolean;
}) {
  if (!props.snapshot && props.loading) {
    return (
      <div className="orchestration-status-panel">
        <Panel title="编排状态">
          <EmptyState
            icon={<Loader2 size={22} className="animate-spin" />}
            title="加载中…"
            description="正在从服务器拉取账号池快照。"
          />
        </Panel>
      </div>
    );
  }

  if (!props.snapshot) {
    return (
      <div className="orchestration-status-panel">
        <Panel title="编排状态">
          <EmptyState
            icon={<Activity size={22} />}
            title="无法拉取账号池状态"
            description="服务可能未启动或网络异常，5 秒后会自动重试。"
          />
        </Panel>
      </div>
    );
  }

  const snap = props.snapshot;

  return (
    <div className="orchestration-status-panel account-fleet-status-panel">
      <KpiCards snapshot={snap} />
      <AccountMatrix accounts={snap.accounts} />
      <RecentTicksCard ticks={snap.recentTicks} />
      <RecentJobsCard jobs={snap.recentJobs} />
    </div>
  );
}

function KpiCards(props: { snapshot: AccountFleetStatusSnapshot }) {
  const { kpis, lastTick, spec } = props.snapshot;

  const healthRatio = kpis.target > 0 ? kpis.healthyCount / kpis.target : 0;
  const healthTone: KpiTone =
    kpis.target === 0
      ? "neutral"
      : healthRatio >= 0.8
        ? "success"
        : healthRatio >= 0.5
          ? "warning"
          : "danger";

  const dailyRatio =
    kpis.todayRegistrationsBudget > 0 ? kpis.todayRegistrationsUsed / kpis.todayRegistrationsBudget : 0;
  const budgetTone: KpiTone =
    kpis.todayRegistrationsBudget === 0
      ? "neutral"
      : dailyRatio >= 1
        ? "danger"
        : dailyRatio >= 0.8
          ? "warning"
          : "success";

  const brokenTone: KpiTone = kpis.brokenCount === 0 ? "success" : kpis.brokenCount < 3 ? "warning" : "danger";
  const recoveringTone: KpiTone = kpis.recoveringCount === 0 ? "neutral" : "warning";

  return (
    <section className="kpi-grid">
      <KpiCard
        title="健康账号"
        primary={`${kpis.healthyCount} / ${kpis.target}`}
        secondary={kpis.target === 0 ? "未设目标" : describeTargetGap(kpis.healthyCount, kpis.target)}
        tone={healthTone}
      />
      <KpiCard
        title="掉线 / 修复中"
        primary={`${kpis.brokenCount} / ${kpis.recoveringCount}`}
        secondary={kpis.brokenCount + kpis.recoveringCount === 0 ? "无故障" : "broken / recovering"}
        tone={brokenTone === "danger" ? "danger" : recoveringTone === "warning" ? "warning" : "success"}
      />
      <KpiCard
        title="今日注册（SMS 预算）"
        primary={`${kpis.todayRegistrationsUsed} / ${kpis.todayRegistrationsBudget}`}
        secondary={describeBudgetTone(budgetTone, dailyRatio)}
        tone={budgetTone}
      />
      <KpiCard
        title="本月注册"
        primary={`${kpis.monthlyRegistrationsUsed} / ${kpis.monthlyRegistrationsBudget}`}
        secondary={
          kpis.monthlyRegistrationsBudget === 0
            ? "未设月预算"
            : `占月预算 ${Math.round((kpis.monthlyRegistrationsUsed / kpis.monthlyRegistrationsBudget) * 100)}%`
        }
        tone="neutral"
      />
      <div className="kpi-meta">
        <Badge tone={spec.enabled ? "success" : "warning"}>
          {spec.enabled ? "自动维护运行中" : "已暂停"}
        </Badge>
        {lastTick ? (
          <span className="muted small">
            上次调和 {new Date(lastTick.startedAt).toLocaleTimeString()} · 计划 {lastTick.plannedTotal} · 入队 {lastTick.appliedTotal}
            {lastTick.skippedReason !== "applied" && lastTick.skippedReason !== "no_change"
              ? ` · ${formatSkipReason(lastTick.skippedReason)}`
              : ""}
          </span>
        ) : (
          <span className="muted small">尚未跑过调和</span>
        )}
        <span className="muted small kpi-meta-totals">
          账号总数 {kpis.totalAccounts} · 待落地 {kpis.pendingCount}
        </span>
      </div>
    </section>
  );
}

function describeTargetGap(have: number, want: number): string {
  if (have >= want) return "已达目标";
  const gap = want - have;
  return `缺口 ${gap}，按出生策略补给`;
}

function describeBudgetTone(tone: KpiTone, ratio: number): string {
  if (tone === "neutral") return "未设日预算";
  if (tone === "danger") return "已耗尽，停止注册";
  if (tone === "warning") return `占 ${Math.round(ratio * 100)}%，接近上限`;
  return `占 ${Math.round(ratio * 100)}%，充裕`;
}

function AccountMatrix(props: { accounts: AccountRecordView[] }) {
  if (props.accounts.length === 0) {
    return (
      <Panel title="账号矩阵" className="status-pane-matrix">
        <EmptyState
          title="账号池为空"
          description="启用 apply 模式后，scheduler 会按出生策略自动注册；也可在收编工作台导入存量 Sub2API 账号。"
        />
      </Panel>
    );
  }
  // 排序：broken / recovering 在前，retired 在后；同状态下 quota 高的靠前
  const sorted = [...props.accounts].sort((a, b) => intentRank(a) - intentRank(b) || healthRank(a) - healthRank(b));

  return (
    <Panel title={`账号矩阵 (${props.accounts.length})`} className="status-pane-matrix">
      <div className="node-matrix-scroll">
        <table className="node-matrix-table account-matrix-table">
          <thead>
            <tr>
              <th>邮箱</th>
              <th>来源</th>
              <th>状态</th>
              <th>健康</th>
              <th className="num">配额 5h/7d</th>
              <th className="num">已重试</th>
              <th>出口节点</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((acc) => (
              <tr key={acc.id} className={`node-matrix-tr role-${rowRoleByHealth(acc.health)}`}>
                <td className="cell-name" title={acc.email}>
                  <span className="mono-strong">{acc.email}</span>
                  {acc.externalId ? <span className="muted small"> #{acc.externalId}</span> : null}
                </td>
                <td>
                  <OriginBadge origin={acc.origin} />
                </td>
                <td>
                  <IntentBadge intent={acc.intent} />
                </td>
                <td>
                  <HealthBadge health={acc.health} />
                </td>
                <td className="num">
                  <span className={`mono-strong ${quotaToneClass(acc.quota5hPercent)}`}>
                    {acc.quota5hPercent !== null ? `${acc.quota5hPercent}%` : "—"}
                  </span>
                  <span className="muted"> / </span>
                  <span className={`mono-strong ${quotaToneClass(acc.quota7dPercent)}`}>
                    {acc.quota7dPercent !== null ? `${acc.quota7dPercent}%` : "—"}
                  </span>
                </td>
                <td className="num">
                  {acc.recoveryAttempts > 0 ? (
                    <strong>{acc.recoveryAttempts}</strong>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="muted small cell-sub2api" title={acc.lastRecoveryError ?? undefined}>
                  {/* egressNodeHash 未在 view 中暴露 → 用 lastRecoveryPath 替代展示策略路径 */}
                  {acc.lastRecoveryPath ? `via ${acc.lastRecoveryPath}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

type FleetFeedItem =
  | { kind: "tick"; tick: AccountFleetTickSummary }
  | { kind: "dry_run_run"; count: number; latestAt: string; earliestAt: string }
  | { kind: "no_change_run"; count: number; latestAt: string; earliestAt: string };

/**
 * 把连续的 dry_run / no_change tick 合并成单行占位，给真有动作的 tick 让出空间。
 * ticks 是按 startedAt 倒序，所以"连续"是数组相邻。
 */
function mergeIdleRuns(ticks: AccountFleetTickSummary[]): FleetFeedItem[] {
  const items: FleetFeedItem[] = [];
  let drRun: { count: number; latestAt: string; earliestAt: string } | null = null;
  let ncRun: { count: number; latestAt: string; earliestAt: string } | null = null;
  function flushDr() {
    if (drRun) {
      items.push({ kind: "dry_run_run", ...drRun });
      drRun = null;
    }
  }
  function flushNc() {
    if (ncRun) {
      items.push({ kind: "no_change_run", ...ncRun });
      ncRun = null;
    }
  }
  for (const tick of ticks) {
    if (tick.skippedReason === "dry_run") {
      flushNc();
      if (!drRun) drRun = { count: 1, latestAt: tick.startedAt, earliestAt: tick.startedAt };
      else {
        drRun.count += 1;
        drRun.earliestAt = tick.startedAt;
      }
    } else if (tick.skippedReason === "no_change") {
      flushDr();
      if (!ncRun) ncRun = { count: 1, latestAt: tick.startedAt, earliestAt: tick.startedAt };
      else {
        ncRun.count += 1;
        ncRun.earliestAt = tick.startedAt;
      }
    } else {
      flushDr();
      flushNc();
      items.push({ kind: "tick", tick });
    }
  }
  flushDr();
  flushNc();
  return items;
}

function RecentTicksCard(props: { ticks: AccountFleetTickSummary[] }) {
  if (props.ticks.length === 0) {
    return (
      <Panel title="最近调和">
        <EmptyState title="尚未跑过调和" description="服务启动后会按 reconcileIntervalMs（默认 5 分钟）触发首次。" />
      </Panel>
    );
  }
  const items = mergeIdleRuns(props.ticks);
  const meaningful = props.ticks.filter(
    (t) => t.skippedReason !== "no_change" && t.skippedReason !== "dry_run"
  ).length;
  return (
    <Panel
      title={`最近调和 (${meaningful} 有变化 / 共 ${props.ticks.length})`}
      className="status-pane-feed"
    >
      <div className="reconcile-feed">
        {items.map((item, idx) => {
          if (item.kind === "dry_run_run" || item.kind === "no_change_run") {
            const fromTs = new Date(item.earliestAt).toLocaleTimeString();
            const toTs = new Date(item.latestAt).toLocaleTimeString();
            const sameMoment = fromTs === toTs;
            const label = item.kind === "dry_run_run" ? "dry-run" : "无变更";
            return (
              <article
                key={`run-${idx}`}
                className={`reconcile-row reconcile-${item.kind === "dry_run_run" ? "paused" : "no_change"} reconcile-run`}
              >
                <div className="reconcile-row-head reconcile-run-head">
                  <ShieldCheck size={14} aria-hidden="true" />
                  <span className="muted small">
                    {item.count} 次 {label}（{sameMoment ? toTs : `${fromTs} – ${toTs}`}）
                  </span>
                </div>
              </article>
            );
          }
          return <TickRow key={item.tick.id} tick={item.tick} />;
        })}
      </div>
    </Panel>
  );
}

function TickRow(props: { tick: AccountFleetTickSummary }) {
  const tick = props.tick;
  return (
    <article className={`reconcile-row reconcile-${tick.skippedReason}`}>
      <div className="reconcile-row-head">
        <SkippedIcon skipped={tick.skippedReason} />
        <span className="font-mono muted small">{new Date(tick.startedAt).toLocaleTimeString()}</span>
        <span>{summarizeTick(tick)}</span>
        <SkippedBadge skipped={tick.skippedReason} />
      </div>
      {tick.errorMessage ? (
        <div className="reconcile-row-body">
          <div className="form-error">{tick.errorMessage}</div>
        </div>
      ) : null}
    </article>
  );
}

function RecentJobsCard(props: { jobs: AccountJob[] }) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  if (props.jobs.length === 0) {
    return (
      <Panel title="最近 jobs">
        <EmptyState
          title="尚无 job 记录"
          description="dry-run 模式不入队 jobs；切到 apply 模式后会出现 codex_login / codex_register / observe_usage 等任务。"
        />
      </Panel>
    );
  }
  return (
    <Panel title={`最近 jobs (${props.jobs.length})`}>
      <div className="reconcile-feed">
        {props.jobs.slice(0, 20).map((job) => {
          const isOpen = expanded.has(job.id);
          return (
            <article key={job.id} className={`reconcile-row reconcile-${jobReason(job.status)}`}>
              <button
                type="button"
                className="reconcile-row-head"
                onClick={() =>
                  setExpanded((cur) => {
                    const next = new Set(cur);
                    if (next.has(job.id)) next.delete(job.id);
                    else next.add(job.id);
                    return next;
                  })
                }
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <JobStatusIcon status={job.status} />
                <span className="font-mono muted small">{new Date(job.createdAt).toLocaleTimeString()}</span>
                <span>
                  <strong>{jobKindLabel(job.kind)}</strong>
                  {job.accountId ? <span className="muted small"> · {job.accountId.slice(0, 8)}</span> : null}
                </span>
                <Badge tone={jobBadgeTone(job.status)}>{jobStatusLabel(job.status)}</Badge>
              </button>
              {isOpen ? (
                <div className="reconcile-row-body">
                  <ul className="reconcile-change-list">
                    <li className="muted small">触发 {job.triggeredBy} · 尝试 {job.attempt}/{job.maxAttempts}</li>
                    {job.durationMs !== null ? (
                      <li className="muted small">耗时 {job.durationMs}ms</li>
                    ) : null}
                    {job.errorMessage ? (
                      <li>
                        <span className="form-error">{job.errorMessage}</span>
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

// ─── badges / icons ───────────────────────────────

type KpiTone = "success" | "warning" | "danger" | "neutral";

function KpiCard(props: { title: string; primary: string; secondary: string; tone: KpiTone }) {
  return (
    <div className={`kpi-card kpi-${props.tone}`}>
      <div className="kpi-title">{props.title}</div>
      <div className="kpi-primary">{props.primary}</div>
      <div className="kpi-secondary">{props.secondary}</div>
    </div>
  );
}

function OriginBadge(props: { origin: AccountOrigin }) {
  const label: Record<AccountOrigin, string> = {
    hive_registered: "Hive 注册",
    adopted_active: "接管(活)",
    adopted_recovered: "接管(救活)",
    adopted_observing: "接管(观察)",
    retired_legacy: "已弃用"
  };
  const tone: Record<AccountOrigin, "success" | "warning" | "danger" | "neutral" | "info"> = {
    hive_registered: "success",
    adopted_active: "info",
    adopted_recovered: "success",
    adopted_observing: "warning",
    retired_legacy: "neutral"
  };
  return <Badge tone={tone[props.origin]}>{label[props.origin]}</Badge>;
}

function IntentBadge(props: { intent: AccountIntent }) {
  const label: Record<AccountIntent, string> = {
    pending: "待落地",
    active: "活跃",
    recovering: "修复中",
    retired: "已退役"
  };
  const tone: Record<AccountIntent, "success" | "warning" | "danger" | "neutral" | "info"> = {
    pending: "warning",
    active: "success",
    recovering: "info",
    retired: "neutral"
  };
  return <Badge tone={tone[props.intent]}>{label[props.intent]}</Badge>;
}

function HealthBadge(props: { health: AccountHealth }) {
  const label: Record<AccountHealth, string> = {
    healthy: "健康",
    rate_limited: "限流",
    quota_exhausted: "配额耗尽",
    broken: "掉线",
    unknown: "未知"
  };
  const tone: Record<AccountHealth, "success" | "warning" | "danger" | "neutral" | "info"> = {
    healthy: "success",
    rate_limited: "warning",
    quota_exhausted: "warning",
    broken: "danger",
    unknown: "neutral"
  };
  return <Badge tone={tone[props.health]}>{label[props.health]}</Badge>;
}

function quotaToneClass(percent: number | null): string {
  if (percent === null) return "muted";
  if (percent >= 95) return "text-danger";
  if (percent >= 80) return "text-warning";
  return "";
}

function rowRoleByHealth(health: AccountHealth): "serving" | "quarantined" | "evicted" | "standby" | "paused" {
  // 复用现有 .node-matrix-table tr.role-XXX 颜色：broken → danger 行底，rate/quota → warning 底
  switch (health) {
    case "broken":
      return "evicted";
    case "rate_limited":
    case "quota_exhausted":
      return "quarantined";
    case "unknown":
      return "standby";
    case "healthy":
    default:
      return "serving";
  }
}

function intentRank(acc: AccountRecordView): number {
  switch (acc.intent) {
    case "recovering":
      return 0;
    case "pending":
      return 1;
    case "active":
      return 2;
    case "retired":
      return 3;
  }
}
function healthRank(acc: AccountRecordView): number {
  switch (acc.health) {
    case "broken":
      return 0;
    case "rate_limited":
      return 1;
    case "quota_exhausted":
      return 2;
    case "unknown":
      return 3;
    case "healthy":
      return 4;
  }
}

function SkippedIcon(props: { skipped: AccountFleetTickSummary["skippedReason"] }) {
  switch (props.skipped) {
    case "applied":
      return <CheckCircle2 size={14} aria-hidden="true" />;
    case "no_change":
      return <ShieldCheck size={14} aria-hidden="true" />;
    case "paused":
    case "dry_run":
      return <Clock size={14} aria-hidden="true" />;
    case "batch_capped":
    case "budget_exhausted":
      return <Activity size={14} aria-hidden="true" />;
    case "error":
      return <AlertOctagon size={14} aria-hidden="true" />;
    default:
      return <Loader2 size={14} aria-hidden="true" />;
  }
}

function SkippedBadge(props: { skipped: AccountFleetTickSummary["skippedReason"] }) {
  const tone =
    props.skipped === "applied" || props.skipped === "no_change"
      ? "success"
      : props.skipped === "error"
        ? "danger"
        : props.skipped === "paused" || props.skipped === "budget_exhausted" || props.skipped === "batch_capped"
          ? "warning"
          : "info";
  return <Badge tone={tone}>{formatSkipReason(props.skipped)}</Badge>;
}

function formatSkipReason(reason: AccountFleetTickSummary["skippedReason"]): string {
  switch (reason) {
    case "applied":
      return "已入队";
    case "no_change":
      return "无变更";
    case "paused":
      return "已暂停";
    case "dry_run":
      return "dry-run";
    case "batch_capped":
      return "灰度受限";
    case "budget_exhausted":
      return "预算耗尽";
    case "error":
      return "错误";
    default:
      return reason;
  }
}

function summarizeTick(tick: AccountFleetTickSummary): string {
  if (tick.skippedReason === "error") return tick.errorMessage ?? "调和异常";
  if (tick.skippedReason === "no_change") return "状态符合预期，无需变更";
  if (tick.skippedReason === "dry_run") {
    return `dry-run：计划 ${tick.plannedTotal} 项（未入队）`;
  }
  if (tick.skippedReason === "paused") {
    return `自动维护已暂停（计划 ${tick.plannedTotal} 项）`;
  }
  if (tick.skippedReason === "budget_exhausted") {
    return `预算耗尽：计划 ${tick.plannedTotal} 项，入队 0`;
  }
  if (tick.skippedReason === "batch_capped") {
    return `灰度受限：计划 ${tick.plannedTotal} 项，入队 ${tick.appliedTotal}`;
  }
  return `入队 ${tick.appliedTotal} / 计划 ${tick.plannedTotal} 项`;
}

function jobReason(status: AccountJob["status"]): string {
  switch (status) {
    case "succeeded":
      return "no_change"; // 借用 success 配色（绿色 row）
    case "failed":
      return "error";
    case "running":
      return "paused"; // 借用 info 灰
    case "queued":
      return "paused";
    case "cancelled":
      return "no_change";
  }
}

function JobStatusIcon(props: { status: AccountJob["status"] }) {
  switch (props.status) {
    case "succeeded":
      return <CheckCircle2 size={14} aria-hidden="true" />;
    case "failed":
      return <XCircle size={14} aria-hidden="true" />;
    case "running":
      return <Loader2 size={14} className="animate-spin" aria-hidden="true" />;
    case "queued":
      return <Clock size={14} aria-hidden="true" />;
    case "cancelled":
      return <AlertOctagon size={14} aria-hidden="true" />;
  }
}

function jobBadgeTone(status: AccountJob["status"]): "success" | "warning" | "danger" | "neutral" | "info" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
    case "queued":
      return "warning";
    case "cancelled":
      return "neutral";
  }
}

function jobStatusLabel(status: AccountJob["status"]): string {
  return {
    succeeded: "成功",
    failed: "失败",
    running: "运行中",
    queued: "排队",
    cancelled: "已取消"
  }[status];
}

function jobKindLabel(kind: AccountJob["kind"]): string {
  return {
    codex_login: "codex_login（修复）",
    codex_register: "codex_register（注册）",
    import_to_sub2api: "导入 refresh_token",
    delete_sub2api: "删 Sub2API 账号",
    toggle_schedulable: "切 schedulable",
    observe_usage: "查配额"
  }[kind];
}
