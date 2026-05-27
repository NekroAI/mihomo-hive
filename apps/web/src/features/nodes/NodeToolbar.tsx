import React from "react";
import {
  Activity,
  Archive,
  Check,
  CheckSquare,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Plug,
  Replace,
  Rocket,
  Snowflake,
  Trash2,
  XSquare
} from "lucide-react";
import type { ProxyNode } from "@mihomo-hive/schemas";
import { Badge, Button, Dropdown, DropdownGroup, DropdownItem } from "../../components/ui.js";

export interface NodeToolbarProps {
  totalNodes: number;
  filteredCount: number;
  schedulableCount: number;
  exportableCount: number;
  selectedCount: number;
  selectedWithPortCount: number;
  selectedUntestedCount: number;
  withPortCount: number;
  busy: boolean;
  attaching: boolean;
  testing: boolean;
  publishing: boolean;
  onAttach: () => void;
  onTestSelected: () => void;
  onTestAll: () => void;
  onEnableSelected: () => void;
  onPublish: () => void;
  onDisableSelected: () => void;
  onCoolingDownSelected: () => void;
  onRetireSelected: () => void;
  onPreviewDeleteSelected: () => void;
  onSelectFiltered: () => void;
  onSelectSuccessful: () => void;
  onInvertFiltered: () => void;
  onClearSelection: () => void;
}

/**
 * 节点池单行工具条 —— 替代旧的 NodeOpsBar + NodeTable 内部 selection-bar。
 *
 * 布局：左统计 / 中按钮组 / 右 ⋯ dropdown。
 * 工作流从左到右：分配端口 → 测试 → 启用调度 → 发布出口池。
 */
export function NodeToolbar(props: NodeToolbarProps) {
  const hasSelection = props.selectedCount > 0;
  const canTestSelected = props.selectedWithPortCount > 0;
  const canTestAll = props.withPortCount > 0;

  return (
    <section className="node-toolbar">
      <div className="node-toolbar-stats">
        <Badge tone={hasSelection ? "info" : "neutral"}>
          已选 {props.selectedCount}/{props.totalNodes}
        </Badge>
        <span className="node-toolbar-stat muted small" title="当前筛选条件命中的节点数">
          筛选 {props.filteredCount}
        </span>
        <span className="node-toolbar-stat muted small" title="lifecycleStatus === schedulable 的节点数">
          可调度 {props.schedulableCount}
        </span>
        <span className="node-toolbar-stat muted small" title="已分配端口、非 retired 的节点数（导出基数）">
          可导出 {props.exportableCount}
        </span>
        <div className="node-toolbar-selectors">
          <Button
            size="sm"
            variant="ghost"
            icon={<CheckSquare size={14} />}
            onClick={props.onSelectFiltered}
            title={`选中当前筛选的 ${props.filteredCount} 个节点`}
          >
            全选
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Replace size={14} />}
            onClick={props.onInvertFiltered}
            title="反转当前筛选结果的勾选状态"
          >
            反选
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<XSquare size={14} />}
            disabled={!hasSelection}
            onClick={props.onClearSelection}
            title="取消所有勾选"
          >
            清空
          </Button>
        </div>
      </div>

      <div className="node-toolbar-actions">
        <Button
          size="sm"
          icon={<Plug size={14} />}
          disabled={props.busy || !hasSelection}
          loading={props.attaching}
          onClick={props.onAttach}
          title="给所选节点分配端口并接入 Mihomo listener，可以拿来测试。不改 lifecycle，也不会被推送到 Sub2API、不会被自动绑账号。"
        >
          分配端口
        </Button>

        <div className="button-group">
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={props.testing}
            disabled={props.busy || !hasSelection || !canTestSelected}
            onClick={props.onTestSelected}
            title={
              !hasSelection
                ? "请先在表格里勾选节点"
                : !canTestSelected
                  ? "选中节点中没有已分配端口的，先点'分配端口'"
                  : `对所选 ${props.selectedWithPortCount} 个已分配端口节点跑 OpenAI / Claude 连通性测试`
            }
          >
            测试所选
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={props.testing}
            disabled={props.busy || !canTestAll}
            onClick={props.onTestAll}
            title={
              !canTestAll
                ? "没有已分配端口的节点，先点'分配端口'"
                : `对所有 ${props.withPortCount} 个已分配端口、非 retired 节点跑测试`
            }
          >
            测试全部
          </Button>
        </div>

        <Button
          size="sm"
          variant="secondary"
          icon={<PlayCircle size={14} />}
          disabled={props.busy || !hasSelection}
          onClick={props.onEnableSelected}
          title="把所选节点的 lifecycle 设为 schedulable。会进 Sub2API 推送队列、可能立即被自动化分配账号。建议先测过再启用。"
        >
          启用调度
        </Button>

        <Button
          size="sm"
          icon={<Rocket size={14} />}
          loading={props.publishing}
          disabled={props.busy || props.schedulableCount === 0}
          onClick={props.onPublish}
          title="一键发布：给 schedulable 节点确保端口、生成 Mihomo 配置、启动/重载 Mihomo。仅 active + 已分配端口节点会成为 listener。"
        >
          发布出口池
        </Button>

        <Dropdown
          align="right"
          trigger={
            <span className="node-toolbar-more" aria-label="更多操作">
              <MoreHorizontal size={16} />
            </span>
          }
        >
          <DropdownGroup label="筛选">
            <DropdownItem icon={<Check size={14} />} onClick={props.onSelectSuccessful}>
              选择成功结果（status=active）
            </DropdownItem>
          </DropdownGroup>
          <DropdownGroup label="生命周期（所选）">
            <DropdownItem
              icon={<PauseCircle size={14} />}
              disabled={props.busy || !hasSelection}
              hint="lifecycle → disabled：从 Sub2API 自动化中移除，保留本地记录与端口，可随时启用回来。"
              onClick={props.onDisableSelected}
            >
              暂停
            </DropdownItem>
            <DropdownItem
              icon={<Snowflake size={14} />}
              disabled={props.busy || !hasSelection}
              hint="lifecycle → cooling_down：测试失败/错误率破阈也会自动转此。账号留在原地等恢复或被驱逐。"
              onClick={props.onCoolingDownSelected}
            >
              冷却
            </DropdownItem>
            <DropdownItem
              icon={<Archive size={14} />}
              disabled={props.busy || !hasSelection}
              hint="lifecycle → retired：永久退役，保留本地记录用于历史查询。"
              onClick={props.onRetireSelected}
            >
              退役
            </DropdownItem>
            <DropdownItem
              icon={<Trash2 size={14} />}
              danger
              disabled={props.busy || !hasSelection}
              hint="完全删除：Sub2API 解绑账号、删远端代理、删本地记录。需要 confirm。"
              onClick={props.onPreviewDeleteSelected}
            >
              删除
            </DropdownItem>
          </DropdownGroup>
        </Dropdown>
      </div>
    </section>
  );
}

export function summarizePool(nodes: ProxyNode[]): {
  total: number;
  schedulable: number;
  withPort: number;
  exportable: number;
} {
  return {
    total: nodes.length,
    schedulable: nodes.filter((node) => node.lifecycleStatus === "schedulable").length,
    withPort: nodes.filter(
      (node) =>
        Boolean(node.assignedPort) &&
        node.lifecycleStatus !== "retired" &&
        node.lifecycleStatus !== "deleted"
    ).length,
    exportable: nodes.filter(
      (node) =>
        Boolean(node.assignedPort) &&
        node.lifecycleStatus !== "retired" &&
        node.lifecycleStatus !== "deleted"
    ).length
  };
}
