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
      <div className="node-matrix-scroll">
        <table className="node-matrix-table">
          <thead>
            <tr>
              <th>节点名</th>
              <th>地区</th>
              <th>角色</th>
              <th>Sub2API</th>
              <th className="num">承载 / 目标</th>
              <th className="num">健康分</th>
              <th>下次动作</th>
            </tr>
          </thead>
          <tbody>
            {props.intents.map((intent) => {
              const name = intent.localName ?? intent.proxyName ?? `${intent.hash.slice(0, 8)}…`;
              const regionFlag = intent.country ? formatCountry(intent.country) : "—";
              const sub2api = formatSub2Api(intent);
              return (
                <tr key={intent.hash} className={`node-matrix-tr role-${intent.intentRole}`}>
                  <td className="cell-name" title={name}>
                    <span className="mono-strong">{name}</span>
                  </td>
                  <td className="muted small">{regionFlag}</td>
                  <td>
                    <RoleBadge role={intent.intentRole} />
                  </td>
                  <td className="cell-sub2api muted small" title={sub2api}>
                    {sub2api}
                  </td>
                  <td className="num">
                    <strong>{intent.currentLoad}</strong>
                    <span className="muted"> / {intent.targetLoad}</span>
                  </td>
                  <td className="num">
                    {intent.healthScore === null ? <span className="muted">—</span> : intent.healthScore}
                  </td>
                  <td className="muted small">{intent.nextAction}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function formatSub2Api(intent: ReconcileNodeIntent): string {
  const id = intent.proxyId ? `#${intent.proxyId}` : "—";
  const proto = intent.protocol ? intent.protocol.toLowerCase() : "";
  const where = intent.host && intent.port ? `${intent.host}:${intent.port}` : "";
  if (proto && where) return `${id} ${proto}://${where}`;
  if (where) return `${id} ${where}`;
  return id;
}

const FLAG_REGEX = /^[A-Z]{2}$/;

function formatCountry(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!FLAG_REGEX.test(upper)) return code;
  const A = 0x1f1e6;
  const codePoint1 = A + (upper.charCodeAt(0) - 65);
  const codePoint2 = A + (upper.charCodeAt(1) - 65);
  return `${String.fromCodePoint(codePoint1)}${String.fromCodePoint(codePoint2)} ${upper}`;
}

type ReconcileFeedItem =
  | { kind: "tick"; tick: ReconcileTick }
  | { kind: "no_change_run"; count: number; latestAt: string; earliestAt: string };

/**
 * 把连续的 no_change tick 合并成单行"X 次无变更"占位，给真正有动作的 tick 让出空间。
 * ticks 是按 startedAt 倒序，所以"连续"是数组相邻。
 */
function mergeNoChangeRuns(ticks: ReconcileTick[]): ReconcileFeedItem[] {
  const items: ReconcileFeedItem[] = [];
  let run: { count: number; latestAt: string; earliestAt: string } | null = null;
  for (const tick of ticks) {
    if (tick.skippedReason === "no_change") {
      if (!run) run = { count: 1, latestAt: tick.startedAt, earliestAt: tick.startedAt };
      else {
        run.count += 1;
        run.earliestAt = tick.startedAt; // 倒序 → 越后越早
      }
    } else {
      if (run) {
        items.push({ kind: "no_change_run", ...run });
        run = null;
      }
      items.push({ kind: "tick", tick });
    }
  }
  if (run) items.push({ kind: "no_change_run", ...run });
  return items;
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
  const items = mergeNoChangeRuns(props.ticks);
  const nonNoChange = props.ticks.filter((t) => t.skippedReason !== "no_change").length;
  return (
    <Panel title={`最近调和 (${nonNoChange} 有变化 / 共 ${props.ticks.length})`}>
      <div className="reconcile-feed">
        {items.map((item, idx) => {
          if (item.kind === "no_change_run") {
            const fromTs = new Date(item.earliestAt).toLocaleTimeString();
            const toTs = new Date(item.latestAt).toLocaleTimeString();
            const sameMoment = fromTs === toTs;
            return (
              <article key={`run-${idx}`} className="reconcile-row reconcile-no_change reconcile-run">
                <div className="reconcile-row-head reconcile-run-head">
                  <ShieldCheck size={14} aria-hidden="true" />
                  <span className="muted small">
                    {item.count} 次无变更（{sameMoment ? toTs : `${fromTs} – ${toTs}`}）
                  </span>
                </div>
              </article>
            );
          }
          const tick = item.tick;
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
  const from =
    change.fromProxyId === null
      ? "未绑定"
      : change.fromProxyName
        ? `${change.fromProxyName}`
        : `代理 #${change.fromProxyId}`;
  const to = change.toProxyName ? change.toProxyName : `代理 #${change.toProxyId}`;
  return `${kindLabel[change.kind]}：账号 ${change.accountName}  ${from} → ${to}`;
}
