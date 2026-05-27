import React from "react";
import type { Sub2ApiExportPreview } from "@mihomo-hive/schemas";
import { ExportPanel } from "../features/export/ExportPanel.js";
import type { ConfirmAction } from "../hooks/useConfirmAction.js";

interface PendingMutation {
  isPending: boolean;
}

/**
 * 导出页 —— 纯粹的"把当前选择集打包给外部使用"的工具页。
 *
 * 历史上这里挂过 Mihomo 启停按钮，但：
 *   • 节点池"发布出口池"按钮已经覆盖了日常发布
 *   • 服务启动时已自动 boot Mihomo
 * 所以把运行控制从这里移除，避免与节点池页职责重叠。
 */
export interface AdminRouteProps {
  exportHost: string;
  exportFilename: string;
  failedNodeStatus: "active" | "inactive";
  selectedCount: number;
  exportableSelectedCount: number;
  selectedHashesList: string[];
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
      />
    </section>
  );
}
