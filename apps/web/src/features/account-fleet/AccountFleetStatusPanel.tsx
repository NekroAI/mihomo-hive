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
import { Badge, EmptyState, InfoTip, Panel } from "../../components/ui.js";

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
          <RecentTicksCard ticks={snap.recentTicks} />
          <RecentJobsCard jobs={snap.recentJobs} />
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
              <th className="num">已重试</th>
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
                  <HealthBadge health={acc.health} />
                  {acc.lastRecoveryFailureCategory === "account_unusable" ? (
                    <span
                      className="muted small"
                      style={{ marginLeft: 4, cursor: "help" }}
                      title="codex-tool 判定为 account_unusable：OAuth 授权链终态缺失，无法自动恢复。"
                    >
                      ⚠
                    </span>
                  ) : null}
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
      return {
        typeLabel: "远端发现",
        typeTone: "info",
        subLabel: "已恢复",
        subTone: "success",
        tooltip: "来源是远端发现，但凭据掉了后由 Hive 触发 codex-tool 重新登录/注册成功，现已恢复可用。"
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
