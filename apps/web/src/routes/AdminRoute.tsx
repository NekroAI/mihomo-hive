import React from "react";
import type { Sub2ApiExportPreview } from "@mihomo-hive/schemas";
import { Button } from "../components/ui.js";
import { ExportPanel } from "../features/export/ExportPanel.js";
import type { ConfirmAction } from "../hooks/useConfirmAction.js";

interface PendingMutation {
  isPending: boolean;
}

export interface AdminRouteProps {
  exportHost: string;
  exportFilename: string;
  failedNodeStatus: "active" | "inactive";
  selectedCount: number;
  exportableSelectedCount: number;
  selectedHashesList: string[];
  activeCount: number;
  busy: boolean;
  mihomoRunning: boolean;
  exportPreview: Sub2ApiExportPreview | undefined;
  exportPreviewFetching: boolean;
  downloading: boolean;
  setExportHost: (v: string) => void;
  setExportFilename: (v: string) => void;
  setFailedNodeStatus: (v: "active" | "inactive") => void;
  onDownload: () => void;
  requestConfirmation: (action: ConfirmAction) => void;
  mutations: {
    writeExport: PendingMutation & {
      mutate: (input: { selectedHashes: string[]; host: string; filename: string; failedNodeStatus: "active" | "inactive" }) => void;
    };
    publishRuntime: PendingMutation & { mutate: () => void };
    startMihomo: PendingMutation & { mutate: () => void };
    reloadMihomo: PendingMutation & { mutate: () => void };
    stopMihomo: PendingMutation & { mutate: () => void };
  };
}

export function AdminRoute(props: AdminRouteProps) {
  const m = props.mutations;
  return (
    <section className="workspace-grid runtime-workspace">
      <ExportPanel
        host={props.exportHost}
        filename={props.exportFilename}
        selectedCount={props.selectedCount}
        preview={props.exportPreview}
        loading={props.exportPreviewFetching}
        writing={m.writeExport.isPending}
        downloading={props.downloading}
        failedNodeStatus={props.failedNodeStatus}
        onHostChange={props.setExportHost}
        onFilenameChange={props.setExportFilename}
        onFailedNodeStatusChange={props.setFailedNodeStatus}
        onDownload={props.onDownload}
        onWrite={() =>
          props.requestConfirmation({
            title: "确认写入服务器文件",
            description: `将把 ${props.exportableSelectedCount} 个可导出节点写入 generated/sub2api-proxies.json。`,
            detail: "导出严格按当前选择集执行；失败节点状态由导出篮子的选项决定。",
            confirmLabel: "写入文件",
            run: async () =>
              m.writeExport.mutate({
                selectedHashes: props.selectedHashesList,
                host: props.exportHost,
                filename: props.exportFilename,
                failedNodeStatus: props.failedNodeStatus
              })
          })
        }
      >
        <section className="runtime-ops">
          <h2>Mihomo 运行控制</h2>
          <p className="muted small">高级运维操作。日常发布通过节点池页"发布出口池"按钮即可。</p>
          <div className="button-row wrap">
            <Button onClick={() => m.publishRuntime.mutate()} disabled={props.busy || props.activeCount === 0}>
              发布出口池
            </Button>
            <Button variant="secondary" onClick={() => m.startMihomo.mutate()} disabled={props.busy}>
              启动
            </Button>
            <Button variant="secondary" onClick={() => m.reloadMihomo.mutate()} disabled={props.busy}>
              重载
            </Button>
            <Button variant="danger" onClick={() => m.stopMihomo.mutate()} disabled={props.busy || !props.mihomoRunning}>
              停止
            </Button>
          </div>
          <p className="muted small">完整任务历史在"任务与审计"页查看。</p>
        </section>
      </ExportPanel>
    </section>
  );
}
