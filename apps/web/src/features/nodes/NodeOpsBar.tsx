import React from "react";
import { Activity, PauseCircle, PlayCircle, RefreshCw, Rocket, Trash2 } from "lucide-react";
import type { ProxyNode } from "@mihomo-hive/schemas";
import { Badge, Button } from "../../components/ui.js";

export interface NodeOpsBarProps {
  totalNodes: number;
  schedulableCount: number;
  selectedCount: number;
  busy: boolean;
  publishing: boolean;
  testing: boolean;
  onEnableSelected: () => void;
  onDisableSelected: () => void;
  onPreviewDeleteSelected: () => void;
  onTest: () => void;
  onPublish: () => void;
}

export function NodeOpsBar(props: NodeOpsBarProps) {
  const hasSelection = props.selectedCount > 0;
  return (
    <section className="node-ops-bar">
      <div className="node-ops-status">
        <Badge tone={hasSelection ? "info" : "neutral"}>
          已选 {props.selectedCount}
        </Badge>
        <span className="muted small">
          表格中选中节点的动作 ↓ · 节点池整体 {props.schedulableCount}/{props.totalNodes} 可调度
        </span>
      </div>
      <div className="node-ops-actions">
        <div className="node-ops-group">
          <span className="node-ops-group-label">所选节点</span>
          <Button
            size="sm"
            icon={<PlayCircle size={14} />}
            disabled={props.busy || !hasSelection}
            onClick={props.onEnableSelected}
          >
            启用调度
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<PauseCircle size={14} />}
            disabled={props.busy || !hasSelection}
            onClick={props.onDisableSelected}
          >
            暂停调度
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={14} />}
            disabled={props.busy || !hasSelection}
            onClick={props.onPreviewDeleteSelected}
          >
            排空/删除
          </Button>
        </div>
        <div className="node-ops-group">
          <span className="node-ops-group-label">节点池整体</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={props.testing}
            disabled={props.busy || props.totalNodes === 0}
            onClick={props.onTest}
          >
            测试节点池
          </Button>
          <Button
            size="sm"
            icon={<Rocket size={14} />}
            loading={props.publishing}
            disabled={props.busy || props.schedulableCount === 0}
            onClick={props.onPublish}
          >
            发布出口池
          </Button>
        </div>
      </div>
    </section>
  );
}

export function summarizePool(nodes: ProxyNode[]): { total: number; schedulable: number } {
  return {
    total: nodes.length,
    schedulable: nodes.filter((node) => node.lifecycleStatus === "schedulable").length
  };
}
