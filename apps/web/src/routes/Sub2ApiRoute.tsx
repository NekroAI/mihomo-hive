import React from "react";
import type {
  Sub2ApiAccountFilters,
  Sub2ApiAssignmentPreview,
  Sub2ApiMaintenancePreview,
  Sub2ApiProtectedProxyRule,
  Sub2ApiProxyRecord,
  Sub2ApiSafeConnectionConfig
} from "@mihomo-hive/schemas";
import { Sub2ApiPanel } from "../features/sub2api/Sub2ApiPanel.js";
import type { ConfirmAction } from "../hooks/useConfirmAction.js";

interface PendingMutation {
  isPending: boolean;
}

export interface Sub2ApiRouteProps {
  config: Sub2ApiSafeConnectionConfig | undefined;
  baseUrl: string;
  apiKey: string;
  timezone: string;
  managedPrefix: string;
  filters: Sub2ApiAccountFilters;
  protectedRule: Sub2ApiProtectedProxyRule;
  overwriteExisting: boolean;
  proxies: Sub2ApiProxyRecord[];
  proxiesFetching: boolean;
  preview: Sub2ApiAssignmentPreview | undefined;
  previewFetching: boolean;
  maintenance: Sub2ApiMaintenancePreview | undefined;
  setBaseUrl: (v: string) => void;
  setApiKey: (v: string) => void;
  setTimezone: (v: string) => void;
  setManagedPrefix: (v: string) => void;
  setFilters: (v: Sub2ApiAccountFilters) => void;
  setOverwriteExisting: (v: boolean) => void;
  onProtectedRuleChange: (rule: Sub2ApiProtectedProxyRule) => void;
  refetchProxies: () => void;
  refetchPreview: () => void;
  refetchMaintenance: () => void;
  requestConfirmation: (action: ConfirmAction) => void;
  mutations: {
    saveConfig: PendingMutation & { mutate: (input: { baseUrl: string; adminApiKey?: string | undefined; timezone: string; managedProxyPrefix: string }) => void };
    testConnection: PendingMutation & { mutate: () => void };
    sync: PendingMutation & { mutate: () => void };
    apply: PendingMutation & { mutate: (input: { filters: Sub2ApiAccountFilters; protectedRule: Sub2ApiProtectedProxyRule; overwriteExisting: boolean }) => void };
    drainManaged: PendingMutation & { mutate: () => void };
    cleanupEmpty: PendingMutation & { mutate: () => void };
    pushManaged: PendingMutation & { mutate: (input: object) => void };
    qualityCheck: PendingMutation & { mutate: () => void };
  };
}

export function Sub2ApiRoute(props: Sub2ApiRouteProps) {
  const m = props.mutations;
  return (
    <section className="workspace-grid sub2api-workspace">
      <Sub2ApiPanel
        config={props.config}
        baseUrl={props.baseUrl}
        apiKey={props.apiKey}
        timezone={props.timezone}
        managedProxyPrefix={props.managedPrefix}
        filters={props.filters}
        protectedRule={props.protectedRule}
        proxies={props.proxies}
        preview={props.preview}
        maintenance={props.maintenance}
        loading={props.proxiesFetching || props.previewFetching}
        saving={m.saveConfig.isPending}
        testing={m.testConnection.isPending}
        applying={m.apply.isPending}
        syncing={m.sync.isPending}
        pushing={m.pushManaged.isPending}
        checkingQuality={m.qualityCheck.isPending}
        draining={m.drainManaged.isPending}
        cleaning={m.cleanupEmpty.isPending}
        overwriteExisting={props.overwriteExisting}
        onBaseUrlChange={props.setBaseUrl}
        onApiKeyChange={props.setApiKey}
        onTimezoneChange={props.setTimezone}
        onManagedProxyPrefixChange={props.setManagedPrefix}
        onFiltersChange={props.setFilters}
        onProtectedRuleChange={props.onProtectedRuleChange}
        onOverwriteExistingChange={props.setOverwriteExisting}
        onSaveConfig={() =>
          m.saveConfig.mutate({
            baseUrl: props.baseUrl,
            adminApiKey: props.apiKey || undefined,
            timezone: props.timezone || "Asia/Shanghai",
            managedProxyPrefix: props.managedPrefix || "MH-"
          })
        }
        onTest={() => m.testConnection.mutate()}
        onSync={() => m.sync.mutate()}
        onRefresh={() => {
          props.refetchProxies();
          props.refetchPreview();
          props.refetchMaintenance();
        }}
        onApply={() =>
          props.requestConfirmation({
            title: "确认应用 Sub2API 账号绑定",
            description: `将更新 ${props.preview?.summary.changedAccounts ?? 0} 个账号，保护 ${props.preview?.summary.protectedAccounts ?? 0} 个账号。`,
            detail: `会按目标 proxy_id 分成 ${props.preview?.summary.batches ?? 0} 个批次调用 Sub2API bulk-update。`,
            confirmLabel: "应用绑定",
            run: async () =>
              m.apply.mutate({
                filters: props.filters,
                protectedRule: props.protectedRule,
                overwriteExisting: props.overwriteExisting
              })
          })
        }
        onDrainManaged={() =>
          props.requestConfirmation({
            title: "确认排空 Hive 托管代理",
            description: `将迁移 ${props.maintenance?.summary.drainChanges ?? 0} 个账号，保护账号不会被修改。`,
            detail: "用于清理 Sub2API 中已经被账号使用、暂时无法删除的 Hive 代理。",
            confirmLabel: "排空代理",
            dangerous: true,
            run: async () => m.drainManaged.mutate()
          })
        }
        onCleanupEmpty={() =>
          props.requestConfirmation({
            title: "确认清理 Hive 空代理",
            description: `将删除 ${props.maintenance?.summary.emptyManagedProxies ?? 0} 个没有账号使用的 Hive 托管代理。`,
            detail: `系统按名称前缀 ${props.managedPrefix || "MH-"} 识别托管代理。`,
            confirmLabel: "清理空代理",
            dangerous: true,
            run: async () => m.cleanupEmpty.mutate()
          })
        }
        onPushManaged={() =>
          props.requestConfirmation({
            title: "确认推送本地节点到 Sub2API",
            description: "把本地 schedulable + active 节点通过 importProxyData 推到 Sub2API。",
            detail: `代理名称会自动加上 ${props.managedPrefix || "MH-"} 前缀；Sub2API 通过 proxy_key 去重，重复推送是幂等的。`,
            confirmLabel: "推送节点",
            run: async () => m.pushManaged.mutate({})
          })
        }
        onQualityCheck={() =>
          props.requestConfirmation({
            title: "确认质量检查",
            description: `对所有 ${props.maintenance?.summary.managedProxies ?? 0} 个 Hive 托管代理执行 quality-check。`,
            detail: "返回的分数会回填到本地节点的 qualityScore；过程中 Sub2API 会真正发出测试请求，可能产生远端流量。",
            confirmLabel: "开始检查",
            run: async () => m.qualityCheck.mutate()
          })
        }
      />
    </section>
  );
}
