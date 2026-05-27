import React from "react";
import type {
  NodeDeletionPlan,
  ProxyNode,
  SubscriptionImportPreview,
  SubscriptionSource
} from "@mihomo-hive/schemas";
import { NodePoolPanel } from "../features/node-pool/NodePoolPanel.js";
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
      mutate: (input: { hashes: string[]; lifecycleStatus: "schedulable" | "disabled" }) => void;
    };
    deleteNodes: PendingMutation & { mutate: (input: { hashes: string[]; forceLocal: boolean }) => void };
    testNodes: PendingMutation & {
      mutate: (input: { targets: string[]; timeoutMs: number; concurrency: number }) => void;
    };
    publishRuntime: PendingMutation & { mutate: () => void };
    deleteSubscription: PendingMutation & { mutate: (input: { id: string }) => void };
  };
}

export function NodesRoute(props: NodesRouteProps) {
  const m = props.mutations;
  return (
    <section className="workspace-grid node-pool-grid">
      <NodePoolPanel
        subscriptions={props.subscriptions}
        nodes={props.allNodes}
        selectedCount={props.selectedHashes.size}
        busy={props.busy}
        importName={props.subscriptionName}
        importUrl={props.subscriptionUrl}
        importKeywords={props.subscriptionKeywords}
        preview={props.importPreview}
        deletePlan={props.deletePlan}
        previewing={m.previewImport.isPending}
        importing={m.applyImport.isPending}
        publishing={m.publishRuntime.isPending}
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
        onEnableSelected={() =>
          m.setLifecycle.mutate({ hashes: props.selectedHashesList, lifecycleStatus: "schedulable" })
        }
        onDisableSelected={() =>
          m.setLifecycle.mutate({ hashes: props.selectedHashesList, lifecycleStatus: "disabled" })
        }
        onPreviewDeleteSelected={props.previewSelectedDeletePlan}
        onApplyDeleteSelected={(forceLocal) => {
          if (forceLocal) {
            m.deleteNodes.mutate({ hashes: props.selectedHashesList, forceLocal: false });
          } else {
            props.setDeletePlan(undefined);
          }
        }}
        onTest={() => m.testNodes.mutate({ targets: ["openai", "claude"], timeoutMs: 15_000, concurrency: 8 })}
        onPublish={() => m.publishRuntime.mutate()}
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
      <NodeTable
        nodes={props.allNodes}
        filteredNodes={props.filteredNodes}
        filters={props.filters}
        sourceNames={props.sourceNames}
        selectedHashes={props.selectedHashes}
        onFiltersChange={props.setFilters}
        onToggleNode={(hash, selected) =>
          props.mutateSelection((current) => {
            if (selected) {
              current.add(hash);
            } else {
              current.delete(hash);
            }
            return current;
          })
        }
        onSelectFiltered={(exportableOnly) =>
          props.mutateSelection((current) => {
            for (const node of props.filteredNodes) {
              if (!exportableOnly || canExportNode(node)) {
                current.add(node.hash);
              }
            }
            return current;
          })
        }
        onSelectSuccessful={() =>
          props.mutateSelection((current) => {
            for (const node of props.filteredNodes) {
              if (node.status === "active") {
                current.add(node.hash);
              }
            }
            return current;
          })
        }
        onInvertFiltered={() =>
          props.mutateSelection((current) => {
            for (const node of props.filteredNodes) {
              if (current.has(node.hash)) {
                current.delete(node.hash);
              } else {
                current.add(node.hash);
              }
            }
            return current;
          })
        }
        onClearSelection={() => props.setSelectedHashesList([])}
      />
    </section>
  );
}
