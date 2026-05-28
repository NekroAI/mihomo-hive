import React from "react";
import { Activity, AlertOctagon, BarChart3, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import type {
  AccountFleetStatusSnapshot,
  AccountFleetTickSummary,
  AccountJob,
  AccountRecordView
} from "@mihomo-hive/schemas";
import { Badge, EmptyState, Panel } from "../../components/ui.js";

export interface AccountFleetStatusPanelProps {
  snapshot: AccountFleetStatusSnapshot | undefined;
  loading: boolean;
}

export function AccountFleetStatusPanel(props: AccountFleetStatusPanelProps) {
  if (props.loading && !props.snapshot) {
    return (
      <Panel title="账号编排状态" hint="KPI / 桶分布 / 最近 ticks + jobs。">
        <EmptyState
          icon={<Loader2 size={22} className="animate-spin" />}
          title="正在加载..."
          description="首次拉取调和快照"
        />
      </Panel>
    );
  }
  if (!props.snapshot) {
    return (
      <Panel title="账号编排状态" hint="KPI / 桶分布 / 最近 ticks + jobs。">
        <EmptyState
          icon={<Activity size={22} />}
          title="还没有数据"
          description="调度器启动后会自动拉取首次快照；也可手动点【立即调和】触发。"
        />
      </Panel>
    );
  }
  const snap = props.snapshot;
  return (
    <section className="account-fleet-status-panel">
      <Panel title="KPI" hint="实时账号池概况">
        <div className="kpi-grid">
          <KpiCard
            label="健康 / 目标"
            primary={`${snap.kpis.healthyCount} / ${snap.kpis.target}`}
            tone={
              snap.kpis.target === 0
                ? "neutral"
                : snap.kpis.healthyCount >= snap.kpis.target
                  ? "success"
                  : snap.kpis.healthyCount >= snap.kpis.target * 0.8
                    ? "warning"
                    : "danger"
            }
          />
          <KpiCard label="账号总数" primary={String(snap.kpis.totalAccounts)} tone="neutral" />
          <KpiCard label="掉线 (broken)" primary={String(snap.kpis.brokenCount)} tone={snap.kpis.brokenCount > 0 ? "warning" : "neutral"} />
          <KpiCard label="修复中" primary={String(snap.kpis.recoveringCount)} tone={snap.kpis.recoveringCount > 0 ? "info" : "neutral"} />
          <KpiCard label="待落地 (pending)" primary={String(snap.kpis.pendingCount)} tone="neutral" />
          <KpiCard
            label="今日注册"
            primary={`${snap.kpis.todayRegistrationsUsed} / ${snap.kpis.todayRegistrationsBudget}`}
            tone={
              snap.kpis.todayRegistrationsBudget > 0 &&
              snap.kpis.todayRegistrationsUsed >= snap.kpis.todayRegistrationsBudget
                ? "danger"
                : "info"
            }
          />
          <KpiCard
            label="本月注册"
            primary={`${snap.kpis.monthlyRegistrationsUsed} / ${snap.kpis.monthlyRegistrationsBudget}`}
            tone="neutral"
          />
        </div>
      </Panel>

      <Panel title="账号分布" hint="按 health / origin / intent 分桶">
        <BucketRow
          label="按健康"
          items={Object.entries(snap.accounts.reduce(countBy("health"), {})).map(([k, v]) => ({
            label: HEALTH_LABEL[k] ?? k,
            count: v,
            tone: HEALTH_TONE[k] ?? "neutral"
          }))}
        />
        <BucketRow
          label="按来源"
          items={Object.entries(snap.accounts.reduce(countBy("origin"), {})).map(([k, v]) => ({
            label: ORIGIN_LABEL[k] ?? k,
            count: v,
            tone: ORIGIN_TONE[k] ?? "neutral"
          }))}
        />
        <BucketRow
          label="按 intent"
          items={Object.entries(snap.accounts.reduce(countBy("intent"), {})).map(([k, v]) => ({
            label: INTENT_LABEL[k] ?? k,
            count: v,
            tone: "neutral"
          }))}
        />
      </Panel>

      <Panel title={`最近 ticks (${snap.recentTicks.length})`} hint="调度循环执行记录">
        {snap.recentTicks.length === 0 ? (
          <EmptyState
            icon={<RefreshCw size={20} />}
            title="还没有 tick"
            description="调度器周期触发，或手动点【立即调和】。"
          />
        ) : (
          <ol className="tick-list">
            {snap.recentTicks.slice(0, 15).map((t) => (
              <TickRow key={t.id} tick={t} />
            ))}
          </ol>
        )}
      </Panel>

      <Panel title={`最近 jobs (${snap.recentJobs.length})`} hint="账号操作异步任务（codex-tool 调用 / Sub2API 写）">
        {snap.recentJobs.length === 0 ? (
          <EmptyState
            icon={<BarChart3 size={20} />}
            title="尚无 job 记录"
            description="P4 阶段不入队 jobs；P6 起调度器会产生 codex_login / codex_register 等任务。"
          />
        ) : (
          <ol className="job-list">
            {snap.recentJobs.slice(0, 20).map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </ol>
        )}
      </Panel>
    </section>
  );
}

const HEALTH_LABEL: Record<string, string> = {
  healthy: "健康",
  rate_limited: "限流",
  quota_exhausted: "配额耗尽",
  broken: "掉线",
  unknown: "未知"
};
const HEALTH_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  healthy: "success",
  rate_limited: "warning",
  quota_exhausted: "warning",
  broken: "danger",
  unknown: "neutral"
};
const ORIGIN_LABEL: Record<string, string> = {
  hive_registered: "Hive 注册",
  adopted_active: "接管(活)",
  adopted_recovered: "接管(救活)",
  adopted_observing: "接管(观察)",
  retired_legacy: "已弃用"
};
const ORIGIN_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  hive_registered: "success",
  adopted_active: "info",
  adopted_recovered: "info",
  adopted_observing: "warning",
  retired_legacy: "neutral"
};
const INTENT_LABEL: Record<string, string> = {
  pending: "待落地",
  active: "活跃",
  recovering: "修复中",
  retired: "已退役"
};

function countBy(field: keyof AccountRecordView) {
  return (acc: Record<string, number>, item: AccountRecordView) => {
    const k = String(item[field] ?? "");
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  };
}

function BucketRow(props: {
  label: string;
  items: Array<{ label: string; count: number; tone: "success" | "warning" | "danger" | "info" | "neutral" }>;
}) {
  if (props.items.length === 0) return null;
  return (
    <div className="bucket-row">
      <span className="bucket-label">{props.label}</span>
      <div className="bucket-items">
        {props.items.map((item) => (
          <Badge key={item.label} tone={item.tone}>
            {item.label}: {item.count}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function KpiCard(props: { label: string; primary: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }) {
  return (
    <div className={`kpi-card kpi-${props.tone}`}>
      <div className="kpi-label">{props.label}</div>
      <div className="kpi-primary">{props.primary}</div>
    </div>
  );
}

function TickRow(props: { tick: AccountFleetTickSummary }) {
  const reason = props.tick.skippedReason;
  const tone =
    reason === "applied"
      ? "success"
      : reason === "dry_run"
        ? "info"
        : reason === "error"
          ? "danger"
          : reason === "budget_exhausted" || reason === "batch_capped"
            ? "warning"
            : "neutral";
  return (
    <li className="tick-row">
      <span className="tick-time">{formatTime(props.tick.startedAt)}</span>
      <Badge tone={tone}>{reason}</Badge>
      <span className="muted">
        planned {props.tick.plannedTotal} / applied {props.tick.appliedTotal} · {props.tick.durationMs}ms
      </span>
      {props.tick.errorMessage ? <span className="error">{props.tick.errorMessage}</span> : null}
    </li>
  );
}

function JobRow(props: { job: AccountJob }) {
  const tone =
    props.job.status === "succeeded"
      ? "success"
      : props.job.status === "running"
        ? "info"
        : props.job.status === "failed"
          ? "danger"
          : props.job.status === "queued"
            ? "warning"
            : "neutral";
  const icon =
    props.job.status === "succeeded"
      ? <CheckCircle2 size={14} />
      : props.job.status === "running"
        ? <Loader2 size={14} className="animate-spin" />
        : props.job.status === "failed"
          ? <AlertOctagon size={14} />
          : null;
  return (
    <li className="job-row">
      <span className="job-time">{formatTime(props.job.createdAt)}</span>
      <Badge tone={tone}>
        {icon}
        <span style={{ marginLeft: 4 }}>{props.job.status}</span>
      </Badge>
      <span className="job-kind">{props.job.kind}</span>
      {props.job.accountId ? <span className="muted">{props.job.accountId}</span> : null}
      {props.job.errorMessage ? <span className="error">{props.job.errorMessage}</span> : null}
    </li>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}
