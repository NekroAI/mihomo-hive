import React from "react";
import type {
  NodeDeletionPlan,
  ProxyNode,
  Sub2ApiProxyRecord,
  SubscriptionImportPreview,
  SubscriptionSource
} from "@mihomo-hive/schemas";
import { NodePoolPanel } from "../features/node-pool/NodePoolPanel.js";
import { NodeToolbar, summarizePool } from "../features/nodes/NodeToolbar.js";
import { NodeTable } from "../features/nodes/NodeTable.js";
import { canExportNode, type NodeFilters } from "../features/nodes/node-utils.js";
import type { ConfirmAction } from "../hooks/useConfirmAction.js";

interface PendingMutation {
  isPending: boolean;
}

interface SubscriptionSummary extends Omit<SubscriptionSource, "lastContent"> {
  fetched: boolean;
  lastContentBytes?: number;
}

export interface NodesRouteProps {
  subscriptions: SubscriptionSummary[];
  allNodes: ProxyNode[];
  filteredNodes: ProxyNode[];
  selectedHashes: Set<string>;
  selectedHashesList: string[];
  setSelectedHashesList: (next: string[]) => void;
  filters: NodeFilters;
  setFilters: (next: NodeFilters) => void;
  sourceNames: Map<string, string>;
  importPreview: SubscriptionImportPreview | undefined;
  setImportPreview: (next: SubscriptionImportPreview | undefined) => void;
  deletePlan: NodeDeletionPlan | undefined;
  setDeletePlan: (next: NodeDeletionPlan | undefined) => void;
  subscriptionName: string;
  setSubscriptionName: (v: string) => void;
  subscriptionUrl: string;
  setSubscriptionUrl: (v: string) => void;
  subscriptionKeywords: string;
  setSubscriptionKeywords: (v: string) => void;
  parseKeywords: () => string[];
  /** Sub2API 端的代理列表（按 proxy_id 索引），供节点表显示状态 + 承载账号数 */
  sub2apiProxies: Map<number, Sub2ApiProxyRecord>;
  sub2apiConnected: boolean;
  busy: boolean;
  mutateSelection: (updater: (current: Set<string>) => Set<string>) => void;
  previewSelectedDeletePlan: () => Promise<void>;
  requestConfirmation: (action: ConfirmAction) => void;
  mutations: {
    addSubscription: PendingMutation & { mutate: (input: { name: string; url: string }) => void };
    previewImport: PendingMutation & {
      mutate: (input: { id?: string; name?: string; url?: string; excludeKeywords: string[] }) => void;
    };
    applyImport: PendingMutation & {
      mutate: (input: { id?: string; name: string; url: string; excludeKeywords: string[] }) => void;
    };
    setLifecycle: PendingMutation & {
      mutate: (input: {
        hashes: string[];
        lifecycleStatus: "schedulable" | "disabled" | "cooling_down" | "retired";
      }) => void;
    };
    enableScheduling: PendingMutation & { mutate: (input: { hashes: string[] }) => void };
    deleteNodes: PendingMutation & { mutate: (input: { hashes: string[]; forceLocal: boolean }) => void };
    testNodes: PendingMutation & {
      mutate: (input: { targets: string[]; timeoutMs: number; concurrency: number; hashes?: string[] }) => void;
    };
    attachToMihomo: PendingMutation & { mutate: (input: { hashes: string[] }) => void };
    rebuildMihomo: PendingMutation & { mutate: () => void };
    deleteSubscription: PendingMutation & { mutate: (input: { id: string }) => void };
  };
}

export function NodesRoute(props: NodesRouteProps) {
  const m = props.mutations;
  const pool = summarizePool(props.allNodes);
  const selectedNodes = React.useMemo(
    () => props.allNodes.filter((node) => props.selectedHashes.has(node.hash)),
    [props.allNodes, props.selectedHashes]
  );
  const selectedWithPortCount = selectedNodes.filter((node) => node.assignedPort).length;
  const selectedUntestedCount = selectedNodes.filter((node) => !node.lastTestStatus).length;
  const exportableFiltered = props.filteredNodes.filter(canExportNode).length;
  const filteredCount = props.filteredNodes.length;
  return (
    <section className="workspace-grid node-pool-grid">
      <NodePoolPanel
        subscriptions={props.subscriptions}
        nodes={props.allNodes}
        busy={props.busy}
        importName={props.subscriptionName}
        importUrl={props.subscriptionUrl}
        importKeywords={props.subscriptionKeywords}
        preview={props.importPreview}
        deletePlan={props.deletePlan}
        previewing={m.previewImport.isPending}
        importing={m.applyImport.isPending}
        saving={m.addSubscription.isPending}
        onImportNameChange={props.setSubscriptionName}
        onImportUrlChange={props.setSubscriptionUrl}
        onImportKeywordsChange={props.setSubscriptionKeywords}
        onSaveSubscription={() =>
          m.addSubscription.mutate({ name: props.subscriptionName, url: props.subscriptionUrl })
        }
        onPreviewImport={(source) => {
          if (source) {
            props.setSubscriptionName(source.name);
            props.setSubscriptionKeywords(source.excludeKeywords.join(","));
            m.previewImport.mutate({ id: source.id, excludeKeywords: source.excludeKeywords });
          } else {
            m.previewImport.mutate({
              name: props.subscriptionName,
              url: props.subscriptionUrl,
              excludeKeywords: props.parseKeywords()
            });
          }
        }}
        onRepreviewWithKeywords={(keywords) => {
          props.setSubscriptionKeywords(keywords.join(","));
          const id = props.importPreview?.source.id;
          const name = props.importPreview?.source.name ?? props.subscriptionName;
          const url = props.importPreview?.source.value ?? props.subscriptionUrl;
          if (id) {
            m.previewImport.mutate({ id, excludeKeywords: keywords });
          } else if (name && url) {
            m.previewImport.mutate({ name, url, excludeKeywords: keywords });
          }
        }}
        onApplyImport={(keywords) => {
          props.setSubscriptionKeywords(keywords.join(","));
          const previewSourceId = props.importPreview?.source.id;
          m.applyImport.mutate({
            ...(previewSourceId ? { id: previewSourceId } : {}),
            name: props.importPreview?.source.name ?? props.subscriptionName,
            url: props.importPreview?.source.value ?? props.subscriptionUrl,
            excludeKeywords: keywords
          });
        }}
        onClearPreview={() => props.setImportPreview(undefined)}
        onApplyDeleteSelected={(forceLocal) => {
          if (forceLocal) {
            m.deleteNodes.mutate({ hashes: props.selectedHashesList, forceLocal: false });
          } else {
            props.setDeletePlan(undefined);
          }
        }}
        onDeleteSubscription={(id) =>
          props.requestConfirmation({
            title: "确认删除订阅",
            description: "会删除订阅源以及由它导入的本地节点。",
            detail: "如果这些节点已经在 Sub2API 中被账号使用，请先通过节点删除计划排空账号绑定。",
            confirmLabel: "删除订阅",
            dangerous: true,
            run: async () => m.deleteSubscription.mutate({ id })
          })
        }
      />
      <div className="nodes-stack">
        <NodeToolbar
          totalNodes={pool.total}
          filteredCount={filteredCount}
          schedulableCount={pool.schedulable}
          exportableCount={exportableFiltered}
          selectedCount={props.selectedHashes.size}
          selectedWithPortCount={selectedWithPortCount}
          selectedUntestedCount={selectedUntestedCount}
          withPortCount={pool.withPort}
          busy={props.busy}
          attaching={m.attachToMihomo.isPending}
          testing={m.testNodes.isPending}
          rebuilding={m.rebuildMihomo.isPending}
          onAttach={() => m.attachToMihomo.mutate({ hashes: props.selectedHashesList })}
          onTestSelected={() =>
            m.testNodes.mutate({
              targets: ["openai", "claude"],
              timeoutMs: 15_000,
              concurrency: 8,
              hashes: props.selectedHashesList
            })
          }
          onTestAll={() =>
            m.testNodes.mutate({ targets: ["openai", "claude"], timeoutMs: 15_000, concurrency: 8 })
          }
          onEnableSelected={() => {
            const total = selectedNodes.length;
            const untested = selectedUntestedCount;
            const withoutPort = total - selectedWithPortCount;
            const description =
              untested > 0
                ? `${untested}/${total} 个所选节点还没测试过。启用调度后系统会立即推送到 Sub2API 并纳入自动化分配，可能会绑账号上去。建议先"分配端口"+"测试所选"，确认可用后再启用。`
                : withoutPort > 0
                  ? `${withoutPort}/${total} 个所选节点没有分配端口。这些节点会被标记 schedulable 但不会被推送（Sub2API 只接收 active+已分端口的代理）。`
                  : `${total} 个所选节点都测试过且有端口，会一并推送到 Sub2API。`;
            props.requestConfirmation({
              title: "确认启用调度",
              description,
              detail:
                "启用调度 = 改本地 lifecycle 为 schedulable + 调用 Sub2API importProxyData 把节点上行同步并回填 proxy_id。完成后节点会出现在账号编排页的节点矩阵，参与账号自动绑定 / 漂移 / 故障自愈。可在下拉菜单里随时'暂停'回退。",
              confirmLabel: "启用调度",
              run: async () => m.enableScheduling.mutate({ hashes: props.selectedHashesList })
            });
          }}
          onRebuildMihomo={() =>
            props.requestConfirmation({
              title: "确认重建 Mihomo",
              description:
                "用当前节点状态强制重新渲染 mihomo.yaml 并 reload 进程。不动端口分配、不改 lifecycle、不会推送到 Sub2API。",
              detail:
                "用途：yaml 文件被外部改坏 / Mihomo 进程异常退出需要拉起 / 手动校验配置。reload 期间已建立的代理连接可能短暂中断。",
              confirmLabel: "重建",
              run: async () => m.rebuildMihomo.mutate()
            })
          }
          onDisableSelected={() =>
            m.setLifecycle.mutate({ hashes: props.selectedHashesList, lifecycleStatus: "disabled" })
          }
          onCoolingDownSelected={() =>
            m.setLifecycle.mutate({ hashes: props.selectedHashesList, lifecycleStatus: "cooling_down" })
          }
          onRetireSelected={() =>
            m.setLifecycle.mutate({ hashes: props.selectedHashesList, lifecycleStatus: "retired" })
          }
          onPreviewDeleteSelected={props.previewSelectedDeletePlan}
          onSelectFiltered={() =>
            props.mutateSelection((current) => {
              for (const node of props.filteredNodes) current.add(node.hash);
              return current;
            })
          }
          onSelectSuccessful={() =>
            props.mutateSelection((current) => {
              for (const node of props.filteredNodes) {
                if (node.status === "active") current.add(node.hash);
              }
              return current;
            })
          }
          onInvertFiltered={() =>
            props.mutateSelection((current) => {
              for (const node of props.filteredNodes) {
                if (current.has(node.hash)) current.delete(node.hash);
                else current.add(node.hash);
              }
              return current;
            })
          }
          onClearSelection={() => props.setSelectedHashesList([])}
        />
        <NodeTable
          nodes={props.allNodes}
          filteredNodes={props.filteredNodes}
          filters={props.filters}
          sourceNames={props.sourceNames}
          selectedHashes={props.selectedHashes}
          sub2apiProxies={props.sub2apiProxies}
          sub2apiConnected={props.sub2apiConnected}
          onFiltersChange={props.setFilters}
          onToggleNode={(hash, selected) =>
            props.mutateSelection((current) => {
              if (selected) current.add(hash);
              else current.delete(hash);
              return current;
            })
          }
        />
      </div>
    </section>
  );
}
