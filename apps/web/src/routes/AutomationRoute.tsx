import type {
  OrchestrationSpec,
  OrchestrationStatusSnapshot,
  Sub2ApiProxyRecord,
  Sub2ApiSafeConnectionConfig
} from "@mihomo-hive/schemas";
import {
  OrchestrationSpecPanel,
  type ConnectionDraft,
  type StrategySwitchPreview
} from "../features/automation/OrchestrationSpecPanel.js";
import { OrchestrationStatusPanel } from "../features/automation/OrchestrationStatusPanel.js";

interface PendingMutation {
  isPending: boolean;
}

export interface AutomationRouteProps {
  spec: OrchestrationSpec;
  status: OrchestrationStatusSnapshot | undefined;
  statusLoading: boolean;
  connection: Sub2ApiSafeConnectionConfig | undefined;
  proxies: Sub2ApiProxyRecord[];
  connectionDraft: ConnectionDraft;
  setConnectionDraft: (draft: ConnectionDraft) => void;
  mutations: {
    saveSpec: PendingMutation & { mutate: (next: OrchestrationSpec) => void };
    applyOnce: PendingMutation & { mutate: () => void };
    pause: PendingMutation & { mutate: () => void };
    resume: PendingMutation & { mutate: () => void };
    saveConnection: PendingMutation & {
      mutate: (input: {
        baseUrl: string;
        adminApiKey?: string | undefined;
        timezone: string;
        managedProxyPrefix: string;
      }) => void;
    };
    testConnection: PendingMutation & { mutate: () => void };
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
        testing={m.testConnection.isPending}
        savingConnection={m.saveConnection.isPending}
        connectionDraft={props.connectionDraft}
        onConnectionDraftChange={props.setConnectionDraft}
        onSaveConnection={() =>
          m.saveConnection.mutate({
            baseUrl: props.connectionDraft.baseUrl,
            adminApiKey: props.connectionDraft.apiKey || undefined,
            timezone: props.connectionDraft.timezone || "Asia/Shanghai",
            managedProxyPrefix: props.connectionDraft.managedPrefix || "MH-"
          })
        }
        onTestConnection={() => m.testConnection.mutate()}
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
      <OrchestrationStatusPanel snapshot={props.status} configured={configured} loading={props.statusLoading} />
    </section>
  );
}
