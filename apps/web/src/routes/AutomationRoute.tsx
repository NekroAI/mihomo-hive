import type {
  OrchestrationSpec,
  OrchestrationStatusSnapshot,
  Sub2ApiProxyRecord,
  Sub2ApiSafeConnectionConfig
} from "@mihomo-hive/schemas";
import {
  OrchestrationSpecPanel,
  type StrategySwitchPreview
} from "../features/automation/OrchestrationSpecPanel.js";
import { OrchestrationStatusPanel } from "../features/automation/OrchestrationStatusPanel.js";

interface PendingMutation {
  isPending: boolean;
}

/**
 * 代理编排路由（日常运维）—— P5-AK 重构后只关注：
 *   - 策略编辑（intake / 容量 / 稳定性 / 故障 / 健康判定）
 *   - 状态观察（KPI / tick / 计划应用）
 *
 * Sub2API 连接配置、运维工具箱（推送/质量检查/排空/清理）已搬到「系统」tab。
 * `connection` prop 只用来在未连接时显示引导提示，完整保存/测试在系统页做。
 */
export interface AutomationRouteProps {
  spec: OrchestrationSpec;
  status: OrchestrationStatusSnapshot | undefined;
  statusLoading: boolean;
  connection: Sub2ApiSafeConnectionConfig | undefined;
  connectionLoading: boolean;
  proxies: Sub2ApiProxyRecord[];
  mutations: {
    saveSpec: PendingMutation & { mutate: (next: OrchestrationSpec) => void };
    applyOnce: PendingMutation & { mutate: () => void };
    pause: PendingMutation & { mutate: () => void };
    resume: PendingMutation & { mutate: () => void };
    previewStrategySwitch: PendingMutation & {
      mutateAsync: (input: { target: "stable-hash" | "rendezvous-hash" }) => Promise<StrategySwitchPreview>;
    };
    applyStrategySwitch: PendingMutation & {
      mutateAsync: (input: { target: "stable-hash" | "rendezvous-hash" }) => Promise<unknown>;
    };
  };
}

export function AutomationRoute(props: AutomationRouteProps) {
  const m = props.mutations;
  const configured = Boolean(props.connection?.configured);

  return (
    <section className="workspace-grid automation-grid">
      <OrchestrationSpecPanel
        spec={props.spec}
        connection={props.connection}
        proxies={props.proxies}
        saving={m.saveSpec.isPending}
        applying={m.applyOnce.isPending}
        onSaveSpec={(next) => m.saveSpec.mutate(next)}
        onApplyOnce={() => m.applyOnce.mutate()}
        onPause={() => m.pause.mutate()}
        onResume={() => m.resume.mutate()}
        switchingStrategy={m.applyStrategySwitch.isPending}
        onPreviewStrategySwitch={async (target) => {
          try {
            return await m.previewStrategySwitch.mutateAsync({ target });
          } catch {
            return undefined;
          }
        }}
        onApplyStrategySwitch={async (target) => {
          await m.applyStrategySwitch.mutateAsync({ target });
        }}
      />
      <OrchestrationStatusPanel
        snapshot={props.status}
        configured={configured}
        connectionLoading={props.connectionLoading}
        loading={props.statusLoading}
      />
    </section>
  );
}
