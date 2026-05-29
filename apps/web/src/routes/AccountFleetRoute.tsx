import type { AccountFleetSpec, AccountFleetStatusSnapshot } from "@mihomo-hive/schemas";
import { AccountFleetSpecPanel } from "../features/account-fleet/AccountFleetSpecPanel.js";
import { AccountFleetStatusPanel } from "../features/account-fleet/AccountFleetStatusPanel.js";

interface PendingMutation {
  isPending: boolean;
}

/**
 * 账号编排页（日常运维）—— P5-AK 重构后只关注：
 *   - 策略编辑（target / health / recovery / registration / retirement）
 *   - 账号矩阵 + KPI + 调和历史
 *
 * codex-tool 连接、独立保存/测试已搬到「系统」tab。
 */
export interface AccountFleetRouteProps {
  spec: AccountFleetSpec;
  status: AccountFleetStatusSnapshot | undefined;
  statusLoading: boolean;
  /** Sub2API 是否已连接 —— 决定"立即调和"按钮是否可点。 */
  sub2apiConnected: boolean;
  mutations: {
    saveSpec: PendingMutation & { mutate: (next: AccountFleetSpec) => void };
    triggerNow: PendingMutation & { mutate: () => void };
  };
}

export function AccountFleetRoute(props: AccountFleetRouteProps) {
  return (
    <section className="workspace-grid automation-grid">
      <AccountFleetSpecPanel
        spec={props.spec}
        saving={props.mutations.saveSpec.isPending}
        triggering={props.mutations.triggerNow.isPending}
        canTrigger={props.sub2apiConnected}
        onSaveSpec={(next) => props.mutations.saveSpec.mutate(next)}
        onTriggerNow={() => props.mutations.triggerNow.mutate()}
      />
      <AccountFleetStatusPanel snapshot={props.status} loading={props.statusLoading} />
    </section>
  );
}
