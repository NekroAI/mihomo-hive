import type { AccountFleetSpec, AccountFleetStatusSnapshot } from "@mihomo-hive/schemas";
import { AccountFleetSpecPanel } from "../features/account-fleet/AccountFleetSpecPanel.js";
import { AccountFleetStatusPanel } from "../features/account-fleet/AccountFleetStatusPanel.js";

interface PendingMutation {
  isPending: boolean;
}

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

/**
 * 账号编排页 —— 跟代理编排页同结构：380px 左 Spec / 1fr 右 Status。
 * 设计：notes/account-fleet-design.md §10
 */
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
