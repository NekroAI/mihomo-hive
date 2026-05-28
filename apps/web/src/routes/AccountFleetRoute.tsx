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
  mutations: {
    saveSpec: PendingMutation & { mutate: (next: AccountFleetSpec) => void };
    triggerNow: PendingMutation & { mutate: () => void };
  };
}

/**
 * 账号编排页 —— 账号生命周期自动维护。
 *
 * 跟代理编排页（AutomationRoute）同结构：左 SpecPanel + 右 StatusPanel。
 * 详细设计见 notes/account-fleet-design.md §10。
 */
export function AccountFleetRoute(props: AccountFleetRouteProps) {
  return (
    <section className="workspace-grid account-fleet-grid">
      <AccountFleetSpecPanel
        spec={props.spec}
        saving={props.mutations.saveSpec.isPending}
        triggering={props.mutations.triggerNow.isPending}
        onSaveSpec={(next) => props.mutations.saveSpec.mutate(next)}
        onTriggerNow={() => props.mutations.triggerNow.mutate()}
      />
      <AccountFleetStatusPanel snapshot={props.status} loading={props.statusLoading} />
    </section>
  );
}
