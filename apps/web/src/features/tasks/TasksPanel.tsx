import React from "react";
import { Activity, AlertOctagon, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, RefreshCw, XCircle } from "lucide-react";
import type { OperationJob, OperationJobStatus } from "@mihomo-hive/schemas";
import { Badge, Button, EmptyState, Panel, SelectInput } from "../../components/ui.js";

export interface UpstreamErrorBucket {
  proxyId: number;
  proxyName: string;
  nodeHash: string | null;
  errors: number;
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
}

export interface UpstreamErrorSummary {
  timeRange: string;
  total: number;
  attributed: number;
  unattributed: number;
  byProxy: UpstreamErrorBucket[];
}

export function TasksPanel(props: {
  jobs: OperationJob[];
  loading: boolean;
  onRefresh: () => void;
  errorSummary?: UpstreamErrorSummary | undefined;
  errorSummaryLoading?: boolean | undefined;
  errorSummaryEnabled?: boolean | undefined;
  errorTimeRange?: string | undefined;
  onErrorTimeRangeChange?: ((value: string) => void) | undefined;
  onErrorSummaryRefresh?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const running = props.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const succeeded = props.jobs.filter((job) => job.status === "success").length;
  const failed = props.jobs.filter((job) => job.status === "failed").length;

  return (
    <section className="workspace-grid tasks-workspace">
      {props.errorSummaryEnabled ? (
        <UpstreamErrorCard
          summary={props.errorSummary}
          loading={Boolean(props.errorSummaryLoading)}
          timeRange={props.errorTimeRange ?? "1h"}
          onTimeRangeChange={props.onErrorTimeRangeChange ?? (() => {})}
          onRefresh={props.onErrorSummaryRefresh ?? (() => {})}
        />
      ) : null}
      <Panel
        title="任务与审计"
        actions={
          <div className="button-row">
            <Badge tone={running > 0 ? "info" : succeeded > 0 ? "success" : "neutral"}>
              {running > 0 ? `${running} 个进行中` : `${succeeded} 个成功 / ${failed} 个失败`}
            </Badge>
            <Button variant="secondary" icon={<RefreshCw size={16} />} loading={props.loading} onClick={props.onRefresh}>
              刷新
            </Button>
          </div>
        }
      >
        {props.jobs.length === 0 ? (
          <EmptyState
            title="还没有后台任务"
            description="发布出口池、同步 Sub2API、删除节点、质量检查等异步操作会在此追溯。"
          />
        ) : (
          <div className="task-list">
            {props.jobs.map((job) => (
              <TaskRow
                key={job.id}
                job={job}
                open={expanded.has(job.id)}
                onToggle={() => toggle(job.id)}
              />
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}

function TaskRow(props: { job: OperationJob; open: boolean; onToggle: () => void }) {
  const { job } = props;
  const startedAt = new Date(job.createdAt);
  const updatedAt = new Date(job.updatedAt);
  const durationMs = Math.max(0, updatedAt.getTime() - startedAt.getTime());

  return (
    <article className={`task-row task-${job.status}`}>
      <button type="button" className="task-row-head" onClick={props.onToggle}>
        {props.open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <StatusIcon status={job.status} />
        <div className="task-row-main">
          <strong>{job.title}</strong>
          <span className="muted small">{job.detail || job.type}</span>
        </div>
        <div className="task-row-meta">
          <StatusBadge status={job.status} />
          <span className="muted small">
            {startedAt.toLocaleTimeString()} · {formatDuration(durationMs)}
          </span>
        </div>
      </button>
      {props.open ? (
        <div className="task-row-body">
          {job.steps.length === 0 ? (
            <p className="muted small">无子步骤。</p>
          ) : (
            <ol className="task-steps">
              {job.steps.map((step, index) => (
                <li key={`${job.id}-${index}`} className={`task-step task-step-${step.status}`}>
                  <StatusIcon status={step.status} small />
                  <div>
                    <strong>{step.name}</strong>
                    {step.detail ? <span className="muted small">{step.detail}</span> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <dl className="task-meta-grid">
            <div>
              <dt>类型</dt>
              <dd className="font-mono">{job.type}</dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd className="font-mono">{startedAt.toLocaleString()}</dd>
            </div>
            <div>
              <dt>最近更新</dt>
              <dd className="font-mono">{updatedAt.toLocaleString()}</dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd className="font-mono">{formatDuration(durationMs)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </article>
  );
}

function StatusBadge(props: { status: OperationJobStatus }) {
  const tone: Record<OperationJobStatus, "info" | "success" | "danger" | "warning" | "neutral"> = {
    queued: "neutral",
    running: "info",
    success: "success",
    failed: "danger",
    cancelled: "warning"
  };
  const label: Record<OperationJobStatus, string> = {
    queued: "等待",
    running: "进行中",
    success: "成功",
    failed: "失败",
    cancelled: "已取消"
  };
  return <Badge tone={tone[props.status]}>{label[props.status]}</Badge>;
}

function StatusIcon(props: { status: OperationJobStatus; small?: boolean }) {
  const size = props.small ? 14 : 18;
  switch (props.status) {
    case "running":
      return <Loader2 className="animate-spin" size={size} aria-hidden="true" />;
    case "queued":
      return <Clock size={size} aria-hidden="true" />;
    case "success":
      return <CheckCircle2 size={size} aria-hidden="true" />;
    case "failed":
    case "cancelled":
      return <XCircle size={size} aria-hidden="true" />;
    default:
      return <Clock size={size} aria-hidden="true" />;
  }
}

function UpstreamErrorCard(props: {
  summary: UpstreamErrorSummary | undefined;
  loading: boolean;
  timeRange: string;
  onTimeRangeChange: (value: string) => void;
  onRefresh: () => void;
}) {
  const buckets = props.summary?.byProxy ?? [];
  const topBuckets = buckets.slice(0, 10);
  return (
    <Panel
      title="上游错误聚合"
      actions={
        <div className="button-row">
          <SelectInput
            value={props.timeRange}
            onChange={props.onTimeRangeChange}
            options={[
              { label: "最近 1 小时", value: "1h" },
              { label: "最近 6 小时", value: "6h" },
              { label: "最近 24 小时", value: "24h" },
              { label: "最近 7 天", value: "7d" }
            ]}
          />
          <Button variant="secondary" icon={<RefreshCw size={16} />} loading={props.loading} onClick={props.onRefresh}>
            刷新
          </Button>
        </div>
      }
    >
      {!props.summary ? (
        <EmptyState
          icon={<Activity size={22} />}
          title={props.loading ? "正在拉取上游错误..." : "配置 Sub2API 后即可查看上游错误聚合"}
          description="错误按 account → proxy → 本地节点逐层归因，便于找出最不稳的节点。"
        />
      ) : (
        <>
          <div className="error-summary-stats">
            <SmallStat label="总错误" value={props.summary.total} tone="danger" />
            <SmallStat label="已归因节点" value={props.summary.attributed} tone="warning" />
            <SmallStat label="无法归因" value={props.summary.unattributed} tone="neutral" />
            <SmallStat label="受影响代理" value={buckets.length} tone="info" />
          </div>
          {buckets.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={22} />}
              title="时间窗口内没有上游错误"
              description="如果观察到稳定性问题，请放宽时间范围或检查 Sub2API 是否在收集对应阶段。"
            />
          ) : (
            <ol className="error-bucket-list">
              {topBuckets.map((bucket) => (
                <li key={bucket.proxyId} className="error-bucket">
                  <div className="error-bucket-head">
                    <AlertOctagon size={16} aria-hidden="true" />
                    <strong>{bucket.proxyName}</strong>
                    <span className="muted small">#{bucket.proxyId}{bucket.nodeHash ? ` · 本地 ${bucket.nodeHash.slice(0, 8)}` : ""}</span>
                    <Badge tone="danger">{bucket.errors} 次</Badge>
                  </div>
                  <div className="error-bucket-breakdown">
                    {Object.entries(bucket.byStatus).length > 0 ? (
                      <div>
                        <span className="muted small">HTTP</span>
                        <div className="badge-row">
                          {Object.entries(bucket.byStatus)
                            .sort((a, b) => b[1] - a[1])
                            .map(([status, count]) => (
                              <Badge key={status} tone={statusTone(status)}>{`${status}×${count}`}</Badge>
                            ))}
                        </div>
                      </div>
                    ) : null}
                    {Object.entries(bucket.bySeverity).length > 0 ? (
                      <div>
                        <span className="muted small">Severity</span>
                        <div className="badge-row">
                          {Object.entries(bucket.bySeverity)
                            .sort((a, b) => b[1] - a[1])
                            .map(([severity, count]) => (
                              <Badge key={severity} tone="warning">{`${severity}×${count}`}</Badge>
                            ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
              {buckets.length > topBuckets.length ? (
                <li className="muted small">还有 {buckets.length - topBuckets.length} 个代理未展示。</li>
              ) : null}
            </ol>
          )}
        </>
      )}
    </Panel>
  );
}

function SmallStat(props: { label: string; value: number; tone: "danger" | "warning" | "info" | "neutral" }) {
  return (
    <div className={`small-stat tone-${props.tone}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function statusTone(status: string): "danger" | "warning" | "info" | "neutral" {
  const code = Number(status);
  if (Number.isFinite(code)) {
    if (code >= 500) return "danger";
    if (code === 429 || code === 408) return "warning";
    if (code >= 400) return "info";
  }
  return "neutral";
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(1)} min`;
  }
  const hours = minutes / 60;
  return `${hours.toFixed(1)} h`;
}
