import React from "react";
import type {
  OperationJob,
  Sub2ApiAccountFilters,
  Sub2ApiAssignmentPreview,
  Sub2ApiMaintenancePreview,
  Sub2ApiProtectedProxyRule,
  Sub2ApiProxyRecord,
  Sub2ApiSafeConnectionConfig
} from "@mihomo-hive/schemas";
import {
  AccountScopeSection,
  AssignmentPreviewSection,
  ConnectionSection,
  ManagedOpsSection,
  ProtectionSection
} from "../features/automation/sections.js";
import { TaskHistoryCard, UpstreamErrorCard, type UpstreamErrorSummary } from "../features/automation/cards.js";
import type { ConfirmAction } from "../hooks/useConfirmAction.js";

interface PendingMutation {
  isPending: boolean;
}

export interface AutomationRouteProps {
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
  maintenanceFetching: boolean;
  jobs: OperationJob[];
  jobsLoading: boolean;
  errorSummary: UpstreamErrorSummary | undefined;
  errorSummaryLoading: boolean;
  errorTimeRange: string;
  setBaseUrl: (v: string) => void;
  setApiKey: (v: string) => void;
  setTimezone: (v: string) => void;
  setManagedPrefix: (v: string) => void;
  setFilters: (v: Sub2ApiAccountFilters) => void;
  setOverwriteExisting: (v: boolean) => void;
  onProtectedRuleChange: (rule: Sub2ApiProtectedProxyRule) => void;
  setErrorTimeRange: (v: string) => void;
  refetchProxies: () => void;
  refetchPreview: () => void;
  refetchMaintenance: () => void;
  refetchJobs: () => void;
  refetchErrorSummary: () => void;
  requestConfirmation: (action: ConfirmAction) => void;
  mutations: {
    saveConfig: PendingMutation & {
      mutate: (input: { baseUrl: string; adminApiKey?: string | undefined; timezone: string; managedProxyPrefix: string }) => void;
    };
    testConnection: PendingMutation & { mutate: () => void };
    sync: PendingMutation & { mutate: () => void };
    apply: PendingMutation & {
      mutate: (input: { filters: Sub2ApiAccountFilters; protectedRule: Sub2ApiProtectedProxyRule; overwriteExisting: boolean }) => void;
    };
    drainManaged: PendingMutation & { mutate: () => void };
    cleanupEmpty: PendingMutation & { mutate: () => void };
    pushManaged: PendingMutation & { mutate: (input: object) => void };
    qualityCheck: PendingMutation & { mutate: () => void };
  };
}

export function AutomationRoute(props: AutomationRouteProps) {
  const m = props.mutations;
  const configured = Boolean(props.config?.configured);
  const previewErrors = props.preview?.errors ?? [];
  const canApply = configured && Boolean(props.preview) && (props.preview?.summary.changedAccounts ?? 0) > 0 && previewErrors.length === 0;

  return (
    <section className="workspace-grid automation-grid">
      <aside className="automation-config">
        <ConnectionSection
          config={props.config}
          baseUrl={props.baseUrl}
          apiKey={props.apiKey}
          timezone={props.timezone}
          managedPrefix={props.managedPrefix}
          saving={m.saveConfig.isPending}
          testing={m.testConnection.isPending}
          setBaseUrl={props.setBaseUrl}
          setApiKey={props.setApiKey}
          setTimezone={props.setTimezone}
          setManagedPrefix={props.setManagedPrefix}
          onSave={() =>
            m.saveConfig.mutate({
              baseUrl: props.baseUrl,
              adminApiKey: props.apiKey || undefined,
              timezone: props.timezone || "Asia/Shanghai",
              managedProxyPrefix: props.managedPrefix || "MH-"
            })
          }
          onTest={() => m.testConnection.mutate()}
        />
        <AccountScopeSection
          filters={props.filters}
          overwriteExisting={props.overwriteExisting}
          applying={m.apply.isPending}
          canApply={canApply}
          setFilters={props.setFilters}
          setOverwriteExisting={props.setOverwriteExisting}
          onApply={() =>
            props.requestConfirmation({
              title: "确认应用 Sub2API 账号绑定",
              description: `将更新 ${props.preview?.summary.changedAccounts ?? 0} 个账号，保护 ${props.preview?.summary.protectedAccounts ?? 0} 个账号。`,
              detail: `按目标 proxy_id 分成 ${props.preview?.summary.batches ?? 0} 个批次调用 Sub2API bulk-update。`,
              confirmLabel: "应用绑定",
              run: async () =>
                m.apply.mutate({
                  filters: props.filters,
                  protectedRule: props.protectedRule,
                  overwriteExisting: props.overwriteExisting
                })
            })
          }
        />
        <ProtectionSection
          proxies={props.proxies}
          protectedRule={props.protectedRule}
          setProtectedRule={props.onProtectedRuleChange}
        />
      </aside>
      <div className="automation-ops">
        <ManagedOpsSection
          configured={configured}
          maintenance={props.maintenance}
          syncing={m.sync.isPending}
          pushing={m.pushManaged.isPending}
          checkingQuality={m.qualityCheck.isPending}
          draining={m.drainManaged.isPending}
          cleaning={m.cleanupEmpty.isPending}
          refreshing={props.proxiesFetching || props.previewFetching || props.maintenanceFetching}
          onRefresh={() => {
            props.refetchProxies();
            props.refetchPreview();
            props.refetchMaintenance();
          }}
          onSync={() => m.sync.mutate()}
          onPush={() =>
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
              detail: "返回的分数会回填到本地节点 qualityScore；Sub2API 会真正发出测试请求。",
              confirmLabel: "开始检查",
              run: async () => m.qualityCheck.mutate()
            })
          }
          onDrain={() =>
            props.requestConfirmation({
              title: "确认排空 Hive 托管代理",
              description: `将迁移 ${props.maintenance?.summary.drainChanges ?? 0} 个账号到非保护非托管 active 代理。`,
              detail: "用于清理 Sub2API 中已经被账号使用、暂时无法删除的 Hive 代理。",
              confirmLabel: "排空代理",
              dangerous: true,
              run: async () => m.drainManaged.mutate()
            })
          }
          onCleanup={() =>
            props.requestConfirmation({
              title: "确认清理 Hive 空代理",
              description: `将删除 ${props.maintenance?.summary.emptyManagedProxies ?? 0} 个没有账号使用的 Hive 托管代理。`,
              detail: `系统按名称前缀 ${props.managedPrefix || "MH-"} 识别托管代理。`,
              confirmLabel: "清理空代理",
              dangerous: true,
              run: async () => m.cleanupEmpty.mutate()
            })
          }
        />
        <AssignmentPreviewSection preview={props.preview} />
        <UpstreamErrorCard
          summary={props.errorSummary}
          loading={props.errorSummaryLoading}
          enabled={configured}
          timeRange={props.errorTimeRange}
          onTimeRangeChange={props.setErrorTimeRange}
          onRefresh={props.refetchErrorSummary}
        />
        <TaskHistoryCard jobs={props.jobs} loading={props.jobsLoading} onRefresh={props.refetchJobs} />
      </div>
    </section>
  );
}
