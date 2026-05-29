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
  AccountFleetTick,
  AccountFleetStatusSnapshot,
  AccountFleetTickSummary,
  AccountHealth,
  AccountIntent,
  AccountJob,
  AccountOrigin,
  AccountRecordView
} from "@mihomo-hive/schemas";
import { Badge, Button, EmptyState, InfoTip, Panel } from "../../components/ui.js";
import { trpc } from "../../lib/trpc.js";

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
      {/* 顶部 KPI 横条占满整宽（6 卡一行）；下方双列：左账号矩阵满高内滚 /
          右信息列（短信成本 / 调和 / jobs）独立内滚 —— 高度与矩阵解耦。 */}
      <KpiCards snapshot={snap} />
      <div className="account-fleet-main">
        <AccountMatrix accounts={snap.accounts} />
        <div className="account-fleet-side">
          <SmsRegionHintCard hint={snap.smsRegionHint} kpis={snap.kpis} />
          <RunningJobsCard running={snap.runningJobs} queuedCount={snap.queuedJobCount} accounts={snap.accounts} />
          <RecentFinishedJobsCard jobs={snap.recentFinishedJobs} accounts={snap.accounts} />
          <RecentTicksCard ticks={snap.recentTicks} />
        </div>
      </div>
    </div>
  );
}

/**
 * 短信地区记忆 + 成本回看（P5-AI / external-integration.md §"成本上限和选区策略"）。
 *
 * Hive 完全透明保存 hint blob，UI 这里做"尽力解析最常见字段"展示 —— 找不到的字段
 * 用 fallback "未提供"。设计原则：哪怕 codex-tool 字段改了，UI 也不应该崩，至少
 * 还能显示 lastUpdatedAt 让用户知道 hint 是新的还是陈旧的。
 *
 * 成本卡片同区放置：今日/本月累计短信成本（Hive 自己累的）— 让用户能看到
 * region_hint 命中是否真的在省钱。
 */
function SmsRegionHintCard(props: {
  hint: AccountFleetStatusSnapshot["smsRegionHint"];
  kpis: AccountFleetStatusSnapshot["kpis"];
}) {
  const { hint, kpis } = props;
  const todayUsd = (kpis.todaySmsCostCents / 100).toFixed(2);
  const monthlyUsd = (kpis.monthlySmsCostCents / 100).toFixed(2);
  const hintObj = hint?.hint && typeof hint.hint === "object" && !Array.isArray(hint.hint)
    ? (hint.hint as Record<string, unknown>)
    : null;
  const country = hintObj && typeof hintObj.country === "string" ? hintObj.country : null;
  const operator = hintObj && typeof hintObj.operator === "string" ? hintObj.operator : null;
  const lastSuccessAt = hintObj && typeof hintObj.last_success_at === "string" ? hintObj.last_success_at : null;
  const ttlSeconds =
    hintObj && typeof hintObj.ttl_seconds === "number"
      ? hintObj.ttl_seconds
      : null;
  return (
    <Panel
      title="短信成本与地区记忆"
      hint="codex-tool 自动选区策略：本地保存最近一次注册成功的地区作为下次的优先尝试。具体 TTL / 黑名单逻辑由 codex-tool 决定，Hive 只做透明回传。"
    >
      <div className="form-grid" style={{ gap: 8 }}>
        <div>
          <div className="muted small">今日 SMS 成本</div>
          <div className="mono-strong">${todayUsd}</div>
        </div>
        <div>
          <div className="muted small">本月 SMS 成本</div>
          <div className="mono-strong">${monthlyUsd}</div>
        </div>
        <div>
          <div className="muted small">上次成功地区</div>
          <div className="mono-strong">{country ?? "—"}{operator ? ` · ${operator}` : ""}</div>
        </div>
        <div>
          <div className="muted small">记忆更新时间</div>
          <div className="small">{hint?.lastUpdatedAt ? new Date(hint.lastUpdatedAt).toLocaleString() : "尚未注册过"}</div>
        </div>
      </div>
      {lastSuccessAt || ttlSeconds ? (
        <div className="muted small" style={{ marginTop: 6 }}>
          {lastSuccessAt ? `codex-tool last_success_at=${lastSuccessAt}` : ""}
          {lastSuccessAt && ttlSeconds ? " · " : ""}
          {ttlSeconds ? `ttl=${ttlSeconds}s` : ""}
        </div>
      ) : null}
    </Panel>
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
  const monthlyRatioPct =
    kpis.monthlyRegistrationsBudget > 0
      ? Math.round((kpis.monthlyRegistrationsUsed / kpis.monthlyRegistrationsBudget) * 100)
      : 0;

  return (
    <>
      <section className="kpi-grid kpi-grid-fleet">
        <KpiCard
          title="健康账号"
          primary={`${kpis.healthyCount} / ${kpis.target}`}
          secondary={kpis.target === 0 ? "未设目标" : describeTargetGap(kpis.healthyCount, kpis.target)}
          tone={healthTone}
        />
        <KpiCard
          title="掉线"
          primary={String(kpis.brokenCount)}
          secondary={kpis.brokenCount === 0 ? "无掉线" : "需重登 / 修复"}
          tone={brokenTone}
        />
        <KpiCard
          title="修复中"
          primary={String(kpis.recoveringCount)}
          secondary={kpis.recoveringCount === 0 ? "无任务" : "codex 登录/注册中"}
          tone={recoveringTone}
        />
        <KpiCard
          title="账号总数"
          primary={String(kpis.totalAccounts)}
          secondary={kpis.pendingCount > 0 ? `待落地 ${kpis.pendingCount}` : "全部已落地"}
          tone="neutral"
        />
        <KpiCard
          title="今日注册"
          primary={`${kpis.todayRegistrationsUsed} / ${kpis.todayRegistrationsBudget}`}
          secondary={describeBudgetTone(budgetTone, dailyRatio)}
          tone={budgetTone}
        />
        <KpiCard
          title="本月注册"
          primary={`${kpis.monthlyRegistrationsUsed} / ${kpis.monthlyRegistrationsBudget}`}
          secondary={kpis.monthlyRegistrationsBudget === 0 ? "未设月预算" : `占月预算 ${monthlyRatioPct}%`}
          tone="neutral"
        />
      </section>
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
      </div>
    </>
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
              <th className="num">存活/重登</th>
              <th>出口节点</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((acc) => {
              const split = splitOrigin(acc.origin);
              const egressTitle = formatEgressTooltip(acc);
              return (
              <tr key={acc.id} className={`node-matrix-tr role-${rowRoleByHealth(acc.health)}`}>
                <td className="cell-name" title={acc.email}>
                  {acc.email.startsWith("unknown-") ? (
                    // 接管时 Sub2API 未返回 email 的账号（多为已下线 / 无凭据的残留记录）。
                    // 不显示丑陋的 unknown-177，改成"无邮箱记录"+ 账号编号。
                    <span className="muted">无邮箱记录</span>
                  ) : (
                    <span className="mono-strong">{acc.email}</span>
                  )}
                  {acc.externalId ? <span className="muted small"> #{acc.externalId}</span> : null}
                </td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                    <Badge tone={split.typeTone}>{split.typeLabel}</Badge>
                    {split.subLabel ? (
                      <span className="muted small" style={{ marginLeft: 4 }}>· {split.subLabel}</span>
                    ) : null}
                    <InfoTip text={split.tooltip} />
                  </span>
                </td>
                <td>
                  <IntentBadge intent={acc.intent} />
                </td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
                    {(() => {
                      const remain = recoveryRemainingLabel(acc);
                      // 限流中 → 健康标签与恢复时间合并成一个标签，竖杠连接
                      return remain ? (
                        <>
                          <Badge tone={HEALTH_TONE[acc.health]}>
                            {HEALTH_LABEL[acc.health]} | {remain}
                          </Badge>
                          <InfoTip text={recoveryTooltip(acc)} />
                        </>
                      ) : (
                        <>
                          <HealthBadge health={acc.health} />
                          {acc.lastRecoveryFailureCategory ? (
                            <InfoTip text={formatFailureCategory(acc.lastRecoveryFailureCategory)} />
                          ) : null}
                        </>
                      );
                    })()}
                  </span>
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
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2, justifyContent: "flex-end" }}>
                    <span className="mono-strong">{formatDaysAlive(acc.firstSeenAt)}</span>
                    {acc.reloginCount > 0 ? (
                      <span className="muted small">· 重登 {acc.reloginCount}</span>
                    ) : null}
                    <InfoTip text={formatQualityTooltip(acc)} />
                  </span>
                </td>
                <td className="cell-sub2api" title={egressTitle}>
                  {acc.currentNodeName ? (
                    <span className="mono-strong" style={{ cursor: "help" }}>{acc.currentNodeName}</span>
                  ) : acc.currentProxyId ? (
                    // Sub2API 关联到了代理，但本地节点表里没有这个 proxy_id（可能是 Sub2API
                    // 远端另有代理 / 本地尚未推送 / 节点已删除）
                    <span className="muted small" style={{ cursor: "help" }}>外部代理 #{acc.currentProxyId}</span>
                  ) : acc.egressNodeHash ? (
                    // 仅 codex-tool 路径会写，软粘性记录"上次注册/登录走哪个节点出口"
                    <span className="muted small" style={{ cursor: "help" }}>上次出口 {acc.egressNodeHash.slice(0, 8)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

type FleetFeedItem =
  | { kind: "tick"; tick: AccountFleetTickSummary }
  | { kind: "paused_run"; count: number; latestAt: string; earliestAt: string }
  | { kind: "no_change_run"; count: number; latestAt: string; earliestAt: string };

/**
 * 把连续的 paused（自动维护未开启）/ no_change tick 合并成单行占位，
 * 给真有动作的 tick 让出空间。ticks 是按 startedAt 倒序。
 */
function mergeIdleRuns(ticks: AccountFleetTickSummary[]): FleetFeedItem[] {
  const items: FleetFeedItem[] = [];
  let pausedRun: { count: number; latestAt: string; earliestAt: string } | null = null;
  let ncRun: { count: number; latestAt: string; earliestAt: string } | null = null;
  function flushPaused() {
    if (pausedRun) {
      items.push({ kind: "paused_run", ...pausedRun });
      pausedRun = null;
    }
  }
  function flushNc() {
    if (ncRun) {
      items.push({ kind: "no_change_run", ...ncRun });
      ncRun = null;
    }
  }
  for (const tick of ticks) {
    if (tick.skippedReason === "paused") {
      flushNc();
      if (!pausedRun) pausedRun = { count: 1, latestAt: tick.startedAt, earliestAt: tick.startedAt };
      else {
        pausedRun.count += 1;
        pausedRun.earliestAt = tick.startedAt;
      }
    } else if (tick.skippedReason === "no_change") {
      flushPaused();
      if (!ncRun) ncRun = { count: 1, latestAt: tick.startedAt, earliestAt: tick.startedAt };
      else {
        ncRun.count += 1;
        ncRun.earliestAt = tick.startedAt;
      }
    } else {
      flushPaused();
      flushNc();
      items.push({ kind: "tick", tick });
    }
  }
  flushPaused();
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
    (t) => t.skippedReason !== "no_change" && t.skippedReason !== "paused"
  ).length;
  return (
    <Panel
      title={`最近调和 (${meaningful} 有变化 / 共 ${props.ticks.length})`}
      className="status-pane-feed"
    >
      <div className="reconcile-feed">
        {items.map((item, idx) => {
          if (item.kind === "paused_run" || item.kind === "no_change_run") {
            const fromTs = new Date(item.earliestAt).toLocaleTimeString();
            const toTs = new Date(item.latestAt).toLocaleTimeString();
            const sameMoment = fromTs === toTs;
            const label = item.kind === "paused_run" ? "自动维护未开启" : "无变更";
            return (
              <article
                key={`run-${idx}`}
                className={`reconcile-row reconcile-${item.kind === "paused_run" ? "paused" : "no_change"} reconcile-run`}
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
  const [open, setOpen] = React.useState(false);
  // 有计划/入队动作或报错才值得展开；否则保持纯展示行（不给可点的假象）。
  const expandable = tick.plannedTotal > 0 || tick.appliedTotal > 0 || Boolean(tick.errorMessage);
  // 展开时才按 id 拉完整 tick（含 plannedActions / appliedActions 明细）
  const detail = trpc.accountFleet.tick.get.useQuery(
    { id: tick.id },
    { enabled: open && expandable, staleTime: 60_000 }
  );

  const head = (
    <>
      {expandable ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span style={{ width: 14 }} />}
      <SkippedIcon skipped={tick.skippedReason} />
      <span className="font-mono muted small">{new Date(tick.startedAt).toLocaleTimeString()}</span>
      <span>{summarizeTick(tick)}</span>
      <SkippedBadge skipped={tick.skippedReason} />
    </>
  );

  return (
    <article className={`reconcile-row reconcile-${tick.skippedReason}`}>
      {expandable ? (
        <button type="button" className="reconcile-row-head" onClick={() => setOpen((o) => !o)}>
          {head}
        </button>
      ) : (
        <div className="reconcile-row-head">{head}</div>
      )}
      {open && expandable ? (
        <div className="reconcile-row-body">
          {tick.errorMessage ? <div className="form-error">{tick.errorMessage}</div> : null}
          {detail.isLoading ? <span className="muted small">加载明细…</span> : null}
          {detail.data ? <TickDetail tick={detail.data} /> : null}
          {detail.isError ? <span className="muted small">明细加载失败</span> : null}
        </div>
      ) : null}
    </article>
  );
}

/** tick 展开明细：本轮计划/已入队的账号动作（kind + email + 原因）。 */
function TickDetail(props: { tick: AccountFleetTick }) {
  const { tick } = props;
  // 已入队动作优先展示（真正执行的）；其余落在"已计划未入队"。用 accountId+kind 去重交集。
  const appliedKeys = new Set(tick.appliedActions.map((a) => `${a.kind}:${a.accountId ?? a.externalId ?? a.email}`));
  const plannedOnly = tick.plannedActions.filter(
    (a) => !appliedKeys.has(`${a.kind}:${a.accountId ?? a.externalId ?? a.email}`)
  );
  if (tick.appliedActions.length === 0 && plannedOnly.length === 0) {
    return <span className="muted small">本轮无账号动作（仅观察）。</span>;
  }
  return (
    <div className="tick-detail">
      {tick.appliedActions.length > 0 ? (
        <ActionGroup title={`已入队 (${tick.appliedActions.length})`} actions={tick.appliedActions} tone="success" />
      ) : null}
      {plannedOnly.length > 0 ? (
        <ActionGroup title={`已计划未入队 (${plannedOnly.length})`} actions={plannedOnly} tone="neutral" />
      ) : null}
    </div>
  );
}

function ActionGroup(props: {
  title: string;
  actions: AccountFleetTick["plannedActions"];
  tone: "success" | "neutral";
}) {
  return (
    <div className="tick-action-group">
      <div className="muted small">
        <Badge tone={props.tone}>{props.title}</Badge>
      </div>
      <ul className="reconcile-change-list">
        {props.actions.slice(0, 50).map((a, i) => (
          <li key={i} className="tick-action-item">
            <span className="font-mono">{tickActionLabel(a.kind)}</span>
            <span className="muted">{a.email ?? (a.externalId ? `#${a.externalId}` : a.accountId?.slice(0, 8) ?? "—")}</span>
            <span className="muted small">{a.reason}</span>
          </li>
        ))}
        {props.actions.length > 50 ? (
          <li className="muted small">…另有 {props.actions.length - 50} 条</li>
        ) : null}
      </ul>
    </div>
  );
}

function tickActionLabel(kind: AccountFleetTick["plannedActions"][number]["kind"]): string {
  const map: Record<string, string> = {
    demote_to_observing: "降级观察",
    recover_via_login: "登录修复",
    recover_via_register: "重注册修复",
    register_new: "新建注册",
    retire: "退役",
    delete_external: "删 Sub2API",
    toggle_schedulable: "切调度位",
    observe_usage: "查配额",
    defer: "延后重试"
  };
  return map[kind] ?? kind;
}

/**
 * P5-AW 手动注册控件 —— 立刻入队一批 codex_register 并插队到所有任务前面
 * (priority=5)，不受自动注册开关门控。用于"现在就补一批健康账号"。
 */
function RegisterControl() {
  const [count, setCount] = React.useState(5);
  const utils = trpc.useUtils();
  const refresh = () => void utils.accountFleet.status.invalidate();
  const reg = trpc.accountFleet.actions.enqueueRegisterNew.useMutation({ onSuccess: refresh });
  const regen = trpc.accountFleet.actions.regenerateQueue.useMutation({ onSuccess: refresh });
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input
        type="number"
        min={1}
        max={50}
        value={count}
        onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
        style={{ width: 52 }}
        title="一次注册几个"
      />
      <Button
        size="sm"
        variant="secondary"
        loading={reg.isPending}
        title="立刻入队 N 个注册任务并插队到所有队列任务前面（priority=5）。手动下发不受自动注册开关限制。"
        onClick={() => reg.mutate({ count, jumpQueue: true })}
      >
        注册插队
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={regen.isPending}
        title="取消所有排队中的恢复任务并按当前策略重新规划队列。用于调整均衡度/策略后，或旧队列被陈旧重复任务卡住时一键重置。"
        onClick={() => regen.mutate()}
      >
        重新编排
      </Button>
    </span>
  );
}

/**
 * P5-AR「进行中」卡片 —— 把真正在跑的 job 从一堆 queued 里单独拎出来。
 * 显示 kind / 账号 / 已运行时长 / 尝试次数 + 当前排队积压。
 * 已运行时长随每次 snapshot 轮询（5s）刷新；超过阈值标黄/红提示疑似卡死。
 */
function RunningJobsCard(props: {
  running: AccountJob[];
  queuedCount: number;
  accounts: AccountRecordView[];
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const emailById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of props.accounts) m.set(a.id, a.email);
    return m;
  }, [props.accounts]);

  const title = `进行中 (${props.running.length})${props.queuedCount > 0 ? ` · 排队 ${props.queuedCount}` : ""}`;

  if (props.running.length === 0) {
    return (
      <Panel title={title} actions={<RegisterControl />}>
        <EmptyState
          title="当前无运行中的 job"
          description={
            props.queuedCount > 0
              ? `有 ${props.queuedCount} 个任务排队中，worker 受并发上限串行消费，稍候会逐个进入运行。`
              : "队列为空。掉线账号会在下个调和 tick 入队恢复任务。"
          }
        />
      </Panel>
    );
  }

  return (
    <Panel title={title} actions={<RegisterControl />}>
      <div className="reconcile-feed">
        {props.running.map((job) => {
          const email = job.accountId ? emailById.get(job.accountId) : undefined;
          const who = email && !email.startsWith("unknown-") ? email : job.accountId?.slice(0, 12) ?? "—";
          const elapsed = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0;
          const tone = elapsed > 240_000 ? "danger" : elapsed > 120_000 ? "warning" : "info";
          const isOpen = expanded.has(job.id);
          return (
            <article key={job.id} className="reconcile-row reconcile-running">
              <button
                type="button"
                className="reconcile-row-head"
                onClick={() => toggle(job.id)}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Loader2 size={14} className="animate-spin" />
                <span>
                  <strong>{jobKindLabel(job.kind)}</strong>
                  <span className="muted small"> · {who}</span>
                </span>
                <span className="muted small">尝试 {job.attempt}/{job.maxAttempts}</span>
                <Badge tone={tone}>已运行 {formatElapsed(elapsed)}</Badge>
              </button>
              {isOpen ? (
                <div className="reconcile-row-body">
                  <JobLogView jobId={job.id} live />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

/**
 * P5-AT: job 实时日志视图。运行中 → 每 2s 轮询进程内缓冲；已结束 → 拉一次
 * 持久化 log_tail。展示 worker 里程碑 + codex-tool stderr 进度（已 redact）。
 */
function JobLogView(props: { jobId: string; live?: boolean }) {
  const q = trpc.accountFleet.jobLog.useQuery(
    { jobId: props.jobId },
    { refetchInterval: props.live ? 2000 : false }
  );
  const lines = q.data?.lines ?? [];
  if (q.isLoading) return <div className="muted small" style={{ padding: "6px 12px" }}>加载日志…</div>;
  if (lines.length === 0) {
    return <div className="muted small" style={{ padding: "6px 12px" }}>暂无日志输出。</div>;
  }
  return (
    <pre className="job-log-view">
      {lines.map((l, i) => (
        <div key={i}>
          {l.ts ? <span className="muted">{l.ts.slice(11, 19)} </span> : null}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/**
 * P5-AT「最近完成」卡片 —— 按 finished_at 倒序展示执行完的 job（区别于按入队时间
 * 排序、被一堆 queued 淹没的旧"最近 jobs"）。展开看持久化日志 + 错误信息。
 */
function RecentFinishedJobsCard(props: { jobs: AccountJob[]; accounts: AccountRecordView[] }) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const emailById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of props.accounts) m.set(a.id, a.email);
    return m;
  }, [props.accounts]);
  if (props.jobs.length === 0) {
    return (
      <Panel title="最近完成">
        <EmptyState
          title="尚无执行完的 job"
          description="job 执行结束（成功/失败）后会按完成时间出现在这里，可展开看日志与错误。"
        />
      </Panel>
    );
  }
  return (
    <Panel title={`最近完成 (${props.jobs.length})`}>
      <div className="reconcile-feed">
        {props.jobs.slice(0, 25).map((job) => {
          const isOpen = expanded.has(job.id);
          const email = job.accountId ? emailById.get(job.accountId) : undefined;
          const who = email && !email.startsWith("unknown-") ? email : job.accountId?.slice(0, 12);
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
                <span className="font-mono muted small">
                  {job.finishedAt ? new Date(job.finishedAt).toLocaleTimeString() : ""}
                </span>
                <span>
                  <strong>{jobKindLabel(job.kind)}</strong>
                  {who ? <span className="muted small"> · {who}</span> : null}
                </span>
                <Badge tone={jobBadgeTone(job.status)}>{jobStatusLabel(job.status)}</Badge>
              </button>
              {isOpen ? (
                <div className="reconcile-row-body">
                  <ul className="reconcile-change-list">
                    <li className="muted small">
                      触发 {job.triggeredBy} · 尝试 {job.attempt}/{job.maxAttempts}
                      {job.durationMs !== null ? ` · 耗时 ${(job.durationMs / 1000).toFixed(1)}s` : ""}
                    </li>
                    {job.errorMessage ? (
                      <li>
                        <span className="form-error">{job.errorMessage}</span>
                      </li>
                    ) : null}
                  </ul>
                  <JobLogView jobId={job.id} />
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

/**
 * 账号来源（P5-AG 第二轮）—— 旧设计把 origin 拆成「类型 + 接管子类」两列，
 * 用户反馈"看到所有账号都是'接管'完全不知道什么意思"。新设计：合并成一列，
 *   主标 = 这账号是怎么进系统的
 *   副标 = 凭据/恢复状态（仅 adopted_* 有意义时显示）
 *   tooltip = 完整含义说明，让"接管"不再是黑话
 */
function splitOrigin(origin: AccountOrigin): {
  typeLabel: string;
  typeTone: "success" | "warning" | "danger" | "neutral" | "info";
  subLabel: string | null;
  subTone: "success" | "warning" | "danger" | "neutral" | "info";
  tooltip: string;
} {
  switch (origin) {
    case "hive_registered":
      return {
        typeLabel: "Hive 注册",
        typeTone: "success",
        subLabel: null,
        subTone: "neutral",
        tooltip: "由 Hive 通过 codex-tool 自动注册（SkyMail 拿邮箱 + 接码 + ChatGPT OAuth），凭据齐全可自动维护。"
      };
    case "adopted_active":
      return {
        typeLabel: "远端发现",
        typeTone: "info",
        subLabel: "凭据齐",
        subTone: "success",
        tooltip:
          "在 Sub2API 远端列表里发现的存量账号，带 refresh_token 等凭据可自动刷新。Hive 不会去碰它的密码，仅做健康观察 + 配额采样。"
      };
    case "adopted_recovered":
      // 注意：此 origin 表示"远端发现 + 本地已持有手机号/密码凭据"，可能来自两种途径：
      //   ① codex_login 登录成功后回写；② 接管时从 codex-tool 导出补全凭据（尚未登录）。
      // 所以这里**不能**断言"已恢复可用" —— 账号当前是否可用以「健康」列为准
      // （revoked 的账号补了凭据后仍是掉线，等 codex_login 真正登录成功才转健康）。
      return {
        typeLabel: "远端发现",
        typeTone: "info",
        subLabel: "凭据齐",
        subTone: "info",
        tooltip:
          "Sub2API 发现的账号，本地已补全手机号 + 密码凭据，可由 Hive 自动登录维护。当前是否可用以「健康」列为准：掉线状态会在下次调和尝试 codex_login 修复。"
      };
    case "adopted_observing":
      return {
        typeLabel: "远端发现",
        typeTone: "info",
        subLabel: "凭据缺",
        subTone: "warning",
        tooltip:
          "在 Sub2API 远端发现，但没有 refresh_token 等可自动恢复的凭据，Hive 无法自动修复。需要远端补凭据或本地建新账号顶替。"
      };
    case "retired_legacy":
      return {
        typeLabel: "已弃用",
        typeTone: "neutral",
        subLabel: null,
        subTone: "neutral",
        tooltip: "本地账号在远端列表里已消失（手动删除/迁移），保留只做审计留痕，不参与调度。"
      };
  }
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

const HEALTH_LABEL: Record<AccountHealth, string> = {
  healthy: "健康",
  rate_limited: "限流",
  quota_exhausted: "配额耗尽",
  broken: "掉线",
  unknown: "未知"
};
const HEALTH_TONE: Record<AccountHealth, "success" | "warning" | "danger" | "neutral" | "info"> = {
  healthy: "success",
  rate_limited: "warning",
  quota_exhausted: "warning",
  broken: "danger",
  unknown: "neutral"
};

function HealthBadge(props: { health: AccountHealth }) {
  return <Badge tone={HEALTH_TONE[props.health]}>{HEALTH_LABEL[props.health]}</Badge>;
}

/**
 * 出口节点列 tooltip —— 把多源数据拼成一句话解释，让用户知道这个节点名是哪来的、
 * 旁边的灰字"上次出口 xxx"是怎么回事。
 */
function formatEgressTooltip(acc: AccountRecordView): string {
  const lines: string[] = [];
  if (acc.currentNodeName) {
    lines.push(`Sub2API 当前把此账号绑在「${acc.currentNodeName}」上`);
    if (acc.currentProxyId) lines.push(`(远端代理 ID #${acc.currentProxyId})`);
  } else if (acc.currentProxyId) {
    lines.push(`Sub2API 远端代理 #${acc.currentProxyId}：本地节点表里查不到对应节点`);
    lines.push("可能是手动建的外部代理 / 节点已删 / 尚未推送");
  } else {
    lines.push("Sub2API 远端未给此账号绑代理");
  }
  if (acc.egressNodeHash) {
    lines.push("");
    lines.push(`上次 codex-tool 出口走的节点 hash: ${acc.egressNodeHash}`);
  }
  // P5-AI: 短信注册数据
  if (acc.smsCountry || acc.smsCostCents != null) {
    lines.push("");
    const parts: string[] = [];
    if (acc.smsCountry) parts.push(`地区 ${acc.smsCountry}`);
    if (acc.smsCostCents != null) parts.push(`成本 $${(acc.smsCostCents / 100).toFixed(2)}`);
    lines.push(`注册短信：${parts.join(" · ")}`);
  }
  if (acc.lastRecoveryPath) {
    lines.push(`最近修复路径: ${acc.lastRecoveryPath}`);
  }
  // P5-AI: codex-tool 失败分类（external-integration.md §"OAuth 失败分类"）
  if (acc.lastRecoveryFailureCategory) {
    lines.push(`失败分类: ${formatFailureCategory(acc.lastRecoveryFailureCategory)}`);
  }
  if (acc.lastRecoveryError) {
    lines.push(`上次修复错误: ${acc.lastRecoveryError}`);
  }
  return lines.join("\n");
}

/**
 * P5-AU: Sub2API "限流中" 冷却恢复时间。配额耗尽时 Sub2API 给账号设冷却截止
 * (temp_unschedulable_until) / 配额重置预计时间 (rate_limit_reset_at)。
 * 返回剩余时长标签（>24h 显示 "Xd Yh"，否则 "Xh Ym" / "Ym"），过期/无则 null。
 */
function recoveryRemainingLabel(acc: AccountRecordView): string | null {
  const until = acc.tempUnschedulableUntil ?? acc.rateLimitResetAt ?? null;
  if (!until) return null;
  const ms = new Date(until).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days >= 1) return `${days}d${hours}h`; // 超过 24h → 几d几h
  if (hours >= 1) return `${hours}h${mins}m`;
  return `${mins}m`;
}

function recoveryTooltip(acc: AccountRecordView): string {
  const until = acc.tempUnschedulableUntil ?? acc.rateLimitResetAt ?? null;
  const lines = [`Sub2API 限流中，预计 ${until ? new Date(until).toLocaleString() : "未知"} 恢复`];
  if (acc.tempUnschedulableReason) lines.push(`原因: ${acc.tempUnschedulableReason}`);
  lines.push("（账号会自然恢复，不必在冷却期内手动触发恢复）");
  return lines.join("\n");
}

function formatFailureCategory(c: NonNullable<AccountRecordView["lastRecoveryFailureCategory"]>): string {
  switch (c) {
    case "account_unusable":
      return "账号无救（OAuth 授权链终态缺失）";
    case "network_or_proxy":
      return "网络/代理类（建议检查出口）";
    case "oauth_failed":
      return "普通 OAuth 失败";
  }
}

/**
 * P5-AQ 账号质量列。把"存活天数 + 历史重登次数"压成一个单元格，
 * 配 InfoTip 给出首见时间 / 重登次数 / 最近修复时间的完整解读。
 * 存活越久、重登越少 → 账号越稳，是判断质量的核心直观指标。
 */
function formatDaysAlive(firstSeenAt: string | null): string {
  if (!firstSeenAt) return "—";
  const ms = Date.now() - new Date(firstSeenAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}天`;
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${hours}时` : "今天";
}

function formatQualityTooltip(acc: AccountRecordView): string {
  const lines: string[] = [];
  lines.push(
    acc.firstSeenAt
      ? `首见时间: ${new Date(acc.firstSeenAt).toLocaleString()}`
      : "首见时间: 未知"
  );
  lines.push(`累计重新登录: ${acc.reloginCount} 次`);
  if (acc.lastRecoveredAt) {
    lines.push(`最近修复成功: ${new Date(acc.lastRecoveredAt).toLocaleString()}`);
  }
  if (acc.recoveryAttempts > 0) {
    lines.push(`当前连续修复尝试: ${acc.recoveryAttempts} 次（成功即清零）`);
  }
  return lines.join("\n");
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
      return "未开启";
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
    import_codex_tool_account: "接管 codex-tool 账号",
    delete_sub2api: "删 Sub2API 账号",
    toggle_schedulable: "切 schedulable",
    observe_usage: "查配额"
  }[kind];
}
