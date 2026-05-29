import React from "react";
import { Pause, Play, Settings2, Zap } from "lucide-react";
import type { AccountFleetSpec, AccountFleetStatusSnapshot } from "@mihomo-hive/schemas";
import { Badge, Button } from "../components/ui.js";
import { AccountFleetSpecPanel } from "../features/account-fleet/AccountFleetSpecPanel.js";
import { AccountFleetStatusPanel } from "../features/account-fleet/AccountFleetStatusPanel.js";

interface PendingMutation {
  isPending: boolean;
}

/**
 * 账号编排页（日常运维）。P6 重排：
 *   - 顶部满宽主操作条（开启维护 / 立即巡检 / 维护策略开关）—— 池子级操作集中一处。
 *   - 主体默认满宽给监控（状态面板）；点「维护策略」才把策略表单作为右侧列展开
 *     （桌面 2 列，非手机抽屉）—— 把横向空间优先留给日常观测。
 *   - 队列级操作（注册一批 / 重新编排）在状态面板「进行中」卡片里就近提供。
 */
export interface AccountFleetRouteProps {
  spec: AccountFleetSpec;
  status: AccountFleetStatusSnapshot | undefined;
  statusLoading: boolean;
  sub2apiConnected: boolean;
  mutations: {
    saveSpec: PendingMutation & { mutate: (next: AccountFleetSpec) => void };
    triggerNow: PendingMutation & { mutate: () => void };
  };
}

export function AccountFleetRoute(props: AccountFleetRouteProps) {
  const [specOpen, setSpecOpen] = React.useState(false);
  const enabled = props.spec.enabled;

  return (
    <section className="account-fleet-route">
      <div className="fleet-toolbar">
        <div className="fleet-toolbar-main">
          {enabled ? (
            <Button
              variant="secondary"
              icon={<Pause size={16} />}
              loading={props.mutations.saveSpec.isPending}
              onClick={() => props.mutations.saveSpec.mutate({ ...props.spec, enabled: false })}
              title="关闭后只观察账号池、不自动注册/修复/退役。"
            >
              暂停自动维护
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Play size={16} />}
              loading={props.mutations.saveSpec.isPending}
              onClick={() => props.mutations.saveSpec.mutate({ ...props.spec, enabled: true })}
              title="开启后按策略自动补给/修复/退役账号。下一轮巡检生效。"
            >
              开启自动维护
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Zap size={16} />}
            loading={props.mutations.triggerNow.isPending}
            disabled={!props.sub2apiConnected}
            onClick={() => props.mutations.triggerNow.mutate()}
            title={props.sub2apiConnected ? "立即跑一次巡检：检查账号池并按策略入队任务。" : undefined}
          >
            立即巡检
          </Button>
          {!props.sub2apiConnected ? (
            <span className="muted small">需先在「设置与工具」连接 Sub2API 才能巡检</span>
          ) : null}
        </div>
        <div className="fleet-toolbar-right">
          {enabled ? (
            <TickCountdown
              intervalMs={props.spec.reconcileIntervalMs}
              lastTickAt={props.status?.lastTick?.startedAt}
            />
          ) : null}
          <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "自动维护运行中" : "已暂停"}</Badge>
          <Button
            variant={specOpen ? "primary" : "ghost"}
            icon={<Settings2 size={16} />}
            onClick={() => setSpecOpen((v) => !v)}
            title="展开/收起维护策略（目标数、修复、注册、退役、均衡度等）"
          >
            维护策略
          </Button>
        </div>
      </div>

      <div className={`account-fleet-body${specOpen ? " spec-open" : ""}`}>
        <AccountFleetStatusPanel snapshot={props.status} loading={props.statusLoading} />
        {specOpen ? (
          <AccountFleetSpecPanel
            spec={props.spec}
            saving={props.mutations.saveSpec.isPending}
            triggering={props.mutations.triggerNow.isPending}
            canTrigger={props.sub2apiConnected}
            onSaveSpec={(next) => props.mutations.saveSpec.mutate(next)}
            onTriggerNow={() => props.mutations.triggerNow.mutate()}
            onClose={() => setSpecOpen(false)}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * P6-12「巡检」倒计时 —— "tick/巡检"是一次"检查账号池→按策略入队任务"的周期循环。
 * 显示间隔 + 距下一次的秒数，把抽象的 tick 概念变得可见。每秒刷新。
 */
function TickCountdown(props: { intervalMs: number; lastTickAt: string | undefined }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const intervalMin = Math.round(props.intervalMs / 60000);
  let remainLabel = "—";
  if (props.lastTickAt) {
    const next = new Date(props.lastTickAt).getTime() + props.intervalMs;
    const remainMs = next - now;
    if (remainMs <= 0) {
      remainLabel = "即将巡检";
    } else {
      const s = Math.floor(remainMs / 1000);
      remainLabel = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }
  }
  return (
    <span
      className="tick-countdown muted small"
      title={`巡检 = 每 ${intervalMin} 分钟检查一次账号池，按策略入队恢复/注册/退役任务。这里是距下一次巡检的倒计时。`}
    >
      下次巡检 <strong>{remainLabel}</strong>
      <span className="tick-countdown-interval">/ 每 {intervalMin} 分钟</span>
    </span>
  );
}
