import React from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, RefreshCw, XCircle } from "lucide-react";
import type { OperationJob, OperationJobStatus } from "@mihomo-hive/schemas";
import { Badge, Button, EmptyState, Panel } from "../../components/ui.js";

export function TasksPanel(props: {
  jobs: OperationJob[];
  loading: boolean;
  onRefresh: () => void;
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
