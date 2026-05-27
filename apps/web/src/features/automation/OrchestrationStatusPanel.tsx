import React from "react";
import { Activity, AlertOctagon, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, ShieldCheck, XCircle } from "lucide-react";
import type {
  NodeIntentRole,
  OrchestrationStatusSnapshot,
  ReconcileNodeIntent,
  ReconcilePlannedChange,
  ReconcileTick
} from "@mihomo-hive/schemas";
import { Badge, EmptyState, Panel } from "../../components/ui.js";

/**
 * 状态右栏：用户主要"看"的页面。
 *
 * 4 KPI 卡 → 节点矩阵 → 最近 reconcile 摘要（自然语言句子）。
 * 所有操作按钮（暂停 / 立即调和）都在左栏；右栏纯展示。
 */
export function OrchestrationStatusPanel(props: {
  snapshot: OrchestrationStatusSnapshot | undefined;
  configured: boolean;
}) {
  if (!props.configured) {
    return (
      <div className="orchestration-status-panel">
        <Panel title="编排状态">
          <EmptyState
            title="先配置 Sub2API 连接"
            description="在左栏填写 Sub2API 地址 + 管理员 API Key 后，系统才会开始拉取真实数据并展示编排状态。"
          />
        </Panel>
      </div>
    );
  }

  const snapshot = props.snapshot;
  if (!snapshot) {
    return (
      <div className="orchestration-status-panel">
        <Panel title="编排状态">
          <EmptyState title="正在初始化..." description="第一次 reconcile 正在跑，稍候片刻。" />
        </Panel>
      </div>
    );
  }

  return (
    <div className="orchestration-status-panel">
      <KpiCards snapshot={snapshot} />
      <NodeMatrix intents={snapshot.nodeIntents} />
      <RecentReconcileCard ticks={snapshot.recentTicks} />
    </div>
  );
}

function KpiCards(props: { snapshot: OrchestrationStatusSnapshot }) {
  const { kpis, lastTick, spec } = props.snapshot;
  const healthRatio = kpis.totalProxies > 0 ? kpis.healthyProxies / kpis.totalProxies : 0;
  const healthTone = kpis.totalProxies === 0 ? "neutral" : healthRatio >= 0.8 ? "success" : healthRatio >= 0.5 ? "warning" : "danger";
  const utilTone =
    kpis.utilizationPercent === 0
      ? "neutral"
      : kpis.utilizationPercent < 50
        ? "warning"
        : kpis.utilizationPercent > 90
          ? "danger"
          : "success";
  const driftTone = kpis.driftCount24h === 0 ? "success" : kpis.driftCount24h < 30 ? "neutral" : "warning";
  const quarantineTone = kpis.quarantinedCount === 0 ? "success" : kpis.quarantinedCount < 3 ? "warning" : "danger";

  return (
    <section className="kpi-grid">
      <KpiCard
        title="节点池供给"
        primary={`${kpis.healthyProxies} / ${kpis.totalProxies}`}
        secondary="健康 / 总节点"
        tone={healthTone}
      />
      <KpiCard
        title="承载效率"
        primary={`${kpis.utilizationPercent}%`}
        secondary={
          kpis.utilizationPercent === 0
            ? "无承载数据"
            : kpis.utilizationPercent > 90
              ? "接近过载，考虑加节点"
              : kpis.utilizationPercent < 50
                ? "资源闲置，可考虑下线节点"
                : "健康承载"
        }
        tone={utilTone}
      />
      <KpiCard
        title="绑定稳定"
        primary={String(kpis.driftCount24h)}
        secondary="近 24h 漂移账号"
        tone={driftTone}
      />
      <KpiCard
        title="故障自愈"
        primary={String(kpis.quarantinedCount)}
        secondary="退避中节点"
        tone={quarantineTone}
      />
      <div className="kpi-meta">
        <Badge tone={spec.enabled ? "success" : "warning"}>{spec.enabled ? "自动协调运行中" : "已暂停"}</Badge>
        {lastTick ? (
          <span className="muted small">
            上次 reconcile {new Date(lastTick.startedAt).toLocaleTimeString()} · 计划 {lastTick.plannedTotal} · 执行 {lastTick.appliedTotal}
            {lastTick.skippedReason !== "applied" && lastTick.skippedReason !== "no_change"
              ? ` · ${formatSkipReason(lastTick.skippedReason)}`
              : ""}
          </span>
        ) : (
          <span className="muted small">尚未跑过 reconcile</span>
        )}
      </div>
    </section>
  );
}

function NodeMatrix(props: { intents: ReconcileNodeIntent[] }) {
  if (props.intents.length === 0) {
    return (
      <Panel title="节点矩阵">
        <EmptyState
          title="还没有 Hive 托管节点参与编排"
          description="本地节点需先启用调度，并通过推送同步到 Sub2API 后才会出现在这里。"
        />
      </Panel>
    );
  }
  return (
    <Panel title={`节点矩阵 (${props.intents.length})`}>
      <div className="node-matrix">
        <div className="node-matrix-row node-matrix-head">
          <span>节点</span>
          <span>角色</span>
          <span>承载 / 目标</span>
          <span>健康分</span>
          <span>下次动作</span>
        </div>
        {props.intents.map((intent) => (
          <div key={intent.hash} className="node-matrix-row">
            <span className="font-mono">{intent.hash.slice(0, 12)}…</span>
            <span>
              <RoleBadge role={intent.intentRole} />
            </span>
            <span>
              <strong>{intent.currentLoad}</strong>
              <span className="muted"> / {intent.targetLoad}</span>
            </span>
            <span>{intent.healthScore === null ? <span className="muted">—</span> : `${intent.healthScore}`}</span>
            <span className="muted small">{intent.nextAction}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RecentReconcileCard(props: { ticks: ReconcileTick[] }) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  if (props.ticks.length === 0) {
    return (
      <Panel title="最近调和">
        <EmptyState title="尚未跑过 reconcile" description="服务启动后 30 秒内会跑第一次。" />
      </Panel>
    );
  }
  return (
    <Panel title={`最近调和 (${props.ticks.length})`}>
      <div className="reconcile-feed">
        {props.ticks.map((tick) => {
          const isOpen = expanded.has(tick.id);
          return (
            <article key={tick.id} className={`reconcile-row reconcile-${tick.skippedReason}`}>
              <button
                type="button"
                className="reconcile-row-head"
                onClick={() =>
                  setExpanded((cur) => {
                    const next = new Set(cur);
                    if (next.has(tick.id)) next.delete(tick.id);
                    else next.add(tick.id);
                    return next;
                  })
                }
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <SkippedIcon skipped={tick.skippedReason} />
                <span className="font-mono muted small">{new Date(tick.startedAt).toLocaleTimeString()}</span>
                <span>{summarizeTick(tick)}</span>
                <SkippedBadge skipped={tick.skippedReason} />
              </button>
              {isOpen ? (
                <div className="reconcile-row-body">
                  {tick.errorMessage ? <div className="form-error">{tick.errorMessage}</div> : null}
                  {tick.appliedChanges.length > 0 ? (
                    <details open>
                      <summary>已执行变更 ({tick.appliedChanges.length})</summary>
                      <ul className="reconcile-change-list">
                        {tick.appliedChanges.slice(0, 30).map((change, i) => (
                          <li key={`${tick.id}-a-${i}`}>{summarizeChange(change)}</li>
                        ))}
                        {tick.appliedChanges.length > 30 ? (
                          <li className="muted small">还有 {tick.appliedChanges.length - 30} 条...</li>
                        ) : null}
                      </ul>
                    </details>
                  ) : null}
                  {tick.plannedChanges.length > tick.appliedChanges.length ? (
                    <details>
                      <summary>
                        计划但未执行 ({tick.plannedChanges.length - tick.appliedChanges.length})
                      </summary>
                      <ul className="reconcile-change-list">
                        {tick.plannedChanges
                          .slice(tick.appliedChanges.length, tick.appliedChanges.length + 30)
                          .map((change, i) => (
                            <li key={`${tick.id}-p-${i}`}>{summarizeChange(change)}</li>
                          ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

function RoleBadge(props: { role: NodeIntentRole }) {
  const tone: Record<NodeIntentRole, "success" | "warning" | "danger" | "neutral"> = {
    serving: "success",
    quarantined: "warning",
    evicted: "danger",
    standby: "neutral"
  };
  const label: Record<NodeIntentRole, string> = {
    serving: "服务中",
    quarantined: "退避中",
    evicted: "已驱逐",
    standby: "待命"
  };
  return <Badge tone={tone[props.role]}>{label[props.role]}</Badge>;
}

function KpiCard(props: {
  title: string;
  primary: string;
  secondary: string;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  return (
    <div className={`kpi-card kpi-${props.tone}`}>
      <div className="kpi-title">{props.title}</div>
      <div className="kpi-primary">{props.primary}</div>
      <div className="kpi-secondary">{props.secondary}</div>
    </div>
  );
}

function SkippedIcon(props: { skipped: string }) {
  switch (props.skipped) {
    case "applied":
      return <CheckCircle2 size={14} aria-hidden="true" />;
    case "no_change":
      return <ShieldCheck size={14} aria-hidden="true" />;
    case "paused":
      return <Clock size={14} aria-hidden="true" />;
    case "batch_capped":
      return <Activity size={14} aria-hidden="true" />;
    case "error":
      return <AlertOctagon size={14} aria-hidden="true" />;
    default:
      return <Loader2 size={14} aria-hidden="true" />;
  }
}

function SkippedBadge(props: { skipped: string }) {
  const tone =
    props.skipped === "applied" || props.skipped === "no_change"
      ? "success"
      : props.skipped === "error"
        ? "danger"
        : props.skipped === "paused"
          ? "warning"
          : "info";
  return <Badge tone={tone as "success" | "danger" | "warning" | "info"}>{formatSkipReason(props.skipped)}</Badge>;
}

function formatSkipReason(reason: string): string {
  switch (reason) {
    case "applied":
      return "已执行";
    case "no_change":
      return "无变更";
    case "paused":
      return "已暂停";
    case "batch_capped":
      return "灰度受限";
    case "error":
      return "错误";
    default:
      return reason;
  }
}

function summarizeTick(tick: ReconcileTick): string {
  if (tick.skippedReason === "error") return tick.errorMessage ?? "执行错误";
  if (tick.skippedReason === "no_change") return "状态符合预期，无变更";
  if (tick.skippedReason === "paused") {
    return `Dry-run 仅计划 ${tick.plannedTotal} 项（自动协调暂停中）`;
  }
  if (tick.skippedReason === "batch_capped") {
    return `计划 ${tick.plannedTotal} 项，受灰度限制 0 项执行`;
  }
  return `执行 ${tick.appliedTotal} / 计划 ${tick.plannedTotal} 项`;
}

function summarizeChange(change: ReconcilePlannedChange): string {
  const kindLabel: Record<ReconcilePlannedChange["kind"], string> = {
    drain_intake: "入站引流",
    bind_missing: "新绑",
    rebind_dead: "重绑（原代理失效）",
    rebalance_overload: "外迁（过载）",
    rebalance_fill: "填补（欠载）",
    drift_correction: "漂移校正"
  };
  const from = change.fromProxyId !== null ? `代理 #${change.fromProxyId}` : "未绑定";
  return `${kindLabel[change.kind]}：账号 ${change.accountName} ${from} → 代理 #${change.toProxyId}`;
}
