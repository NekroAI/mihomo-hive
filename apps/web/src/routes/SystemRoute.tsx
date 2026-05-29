import React from "react";
import { Activity, Trash2, Unlink, Upload } from "lucide-react";
import type {
  AccountFleetSpec,
  Sub2ApiExportPreview,
  Sub2ApiMaintenancePreview,
  Sub2ApiSafeConnectionConfig
} from "@mihomo-hive/schemas";
import {
  Sub2ApiConnectionPanel,
  type Sub2ApiConnectionDraft
} from "../features/system/Sub2ApiConnectionPanel.js";
import {
  CodexToolConnectionPanel,
  type CodexToolTestResult
} from "../features/system/CodexToolConnectionPanel.js";
import { ExportPanel } from "../features/export/ExportPanel.js";
import { Badge, Button, CollapsiblePanel, Panel } from "../components/ui.js";
import type { ConfirmAction } from "../hooks/useConfirmAction.js";

interface PendingMutation {
  isPending: boolean;
}

/**
 * 系统页（P5-AK）—— 把"一次性配置 + 低频运维 + 接管/导出工具"集中到一个 tab。
 * 代理编排和账号编排 tab 专注日常运维，不再混进这些。
 *
 * 区块顺序按"必备 → 选配 → 工具 → 数据接管"：
 *   1. Sub2API 连接（顶层，代理编排/账号编排/接管 都依赖）
 *   2. codex-tool 连接（账号编排和接管依赖）
 *   3. Sub2API 运维工具箱（推送本地节点 / 质量检查 / 排空 / 清理空代理）
 *   4. codex-tool 账号接管（P5-AK/3 实现，本期占位）
 *   5. 节点导出篮子（手动批量导出 sub2api-proxies.json）
 */
export interface SystemRouteProps {
  // Sub2API 连接
  sub2apiConnection: Sub2ApiSafeConnectionConfig | undefined;
  sub2apiConnectionDraft: Sub2ApiConnectionDraft;
  setSub2apiConnectionDraft: (next: Sub2ApiConnectionDraft) => void;
  // codex-tool 连接
  fleetSpec: AccountFleetSpec;
  codexToolDraft: AccountFleetSpec["codexTool"];
  setCodexToolDraft: (next: AccountFleetSpec["codexTool"]) => void;
  lastCodexTest: CodexToolTestResult | null | undefined;
  // Sub2API 运维工具
  maintenance: Sub2ApiMaintenancePreview | undefined;
  // 导出篮子
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
  // mutations
  mutations: {
    saveSub2apiConnection: PendingMutation & {
      mutate: (input: {
        baseUrl: string;
        adminApiKey?: string | undefined;
        timezone: string;
        managedProxyPrefix: string;
      }) => void;
    };
    testSub2apiConnection: PendingMutation & { mutate: () => void };
    saveCodexTool: PendingMutation & { mutate: (next: AccountFleetSpec["codexTool"]) => void };
    testCodexTool: PendingMutation & { mutate: () => void };
    pushLocalNodes: PendingMutation & { mutate: () => void };
    qualityCheck: PendingMutation & { mutate: () => void };
    drainManaged: PendingMutation & { mutate: () => void };
    cleanupEmpty: PendingMutation & { mutate: () => void };
    writeExport: PendingMutation & {
      mutate: (input: {
        selectedHashes: string[];
        host: string;
        filename: string;
        failedNodeStatus: "active" | "inactive";
      }) => void;
    };
  };
}

export function SystemRoute(props: SystemRouteProps) {
  const m = props.mutations;
  const sub2apiConnected = Boolean(props.sub2apiConnection?.configured);

  return (
    <section className="workspace-grid system-grid">
      <div className="system-stack">
        <Sub2ApiConnectionPanel
          connection={props.sub2apiConnection}
          draft={props.sub2apiConnectionDraft}
          saving={m.saveSub2apiConnection.isPending}
          testing={m.testSub2apiConnection.isPending}
          onDraftChange={props.setSub2apiConnectionDraft}
          onSave={() =>
            m.saveSub2apiConnection.mutate({
              baseUrl: props.sub2apiConnectionDraft.baseUrl,
              adminApiKey: props.sub2apiConnectionDraft.apiKey || undefined,
              timezone: props.sub2apiConnectionDraft.timezone || "Asia/Shanghai",
              managedProxyPrefix: props.sub2apiConnectionDraft.managedPrefix || "MH-"
            })
          }
          onTest={() => m.testSub2apiConnection.mutate()}
          collapsible={false}
        />

        <CodexToolConnectionPanel
          draft={props.codexToolDraft}
          saving={m.saveCodexTool.isPending}
          testing={m.testCodexTool.isPending}
          lastTest={props.lastCodexTest}
          onDraftChange={props.setCodexToolDraft}
          onSave={() => m.saveCodexTool.mutate(props.codexToolDraft)}
          onTest={() => m.testCodexTool.mutate()}
        />

        <Sub2ApiMaintenancePanel
          connected={sub2apiConnected}
          maintenance={props.maintenance}
          pushingLocal={m.pushLocalNodes.isPending}
          checkingQuality={m.qualityCheck.isPending}
          draining={m.drainManaged.isPending}
          cleaningEmpty={m.cleanupEmpty.isPending}
          onPushLocal={() => m.pushLocalNodes.mutate()}
          onQualityCheck={() => m.qualityCheck.mutate()}
          onDrain={() => m.drainManaged.mutate()}
          onCleanupEmpty={() => m.cleanupEmpty.mutate()}
        />

        <CodexToolAdoptionPanel />

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
      </div>
    </section>
  );
}

/**
 * Sub2API 运维工具箱 —— 推送本地节点 + 质量检查 + 排空托管 + 清理空代理。
 * 这些是低频救援动作，集中放系统页避免污染代理编排日常视图。
 */
function Sub2ApiMaintenancePanel(props: {
  connected: boolean;
  maintenance: Sub2ApiMaintenancePreview | undefined;
  pushingLocal: boolean;
  checkingQuality: boolean;
  draining: boolean;
  cleaningEmpty: boolean;
  onPushLocal: () => void;
  onQualityCheck: () => void;
  onDrain: () => void;
  onCleanupEmpty: () => void;
}) {
  return (
    <CollapsiblePanel
      title="Sub2API 运维工具"
      storageKey="system-sub2api-maintenance"
      hint="低频救援动作。日常调和器会自动完成大部分维护；仅处理孤儿代理 / 节点下线 / 验证代理质量等特殊场景时才用这里。"
    >
      <div className="maintenance-row">
        <div className="maintenance-summary">
          {props.maintenance ? (
            <>
              <span className="muted small">
                托管代理 <strong>{props.maintenance.summary.managedProxies}</strong>
              </span>
              <span className="muted small">
                待迁账号 <strong>{props.maintenance.summary.drainChanges}</strong>
              </span>
              <span className="muted small">
                空代理 <strong>{props.maintenance.summary.emptyManagedProxies}</strong>
              </span>
            </>
          ) : (
            <span className="muted small">
              {props.connected ? "正在加载维护数据..." : "请先配置 Sub2API 连接"}
            </span>
          )}
        </div>
        <div className="button-row wrap">
          <Button
            size="sm"
            variant="secondary"
            icon={<Upload size={14} />}
            loading={props.pushingLocal}
            disabled={!props.connected}
            onClick={props.onPushLocal}
            title="把本地可调度 + 可用的节点推到 Sub2API 远端，代理名自动加托管前缀。Sub2API 按代理标识去重，重复推送幂等。"
          >
            推送本地节点
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={props.checkingQuality}
            disabled={!props.connected || !props.maintenance || props.maintenance.summary.managedProxies === 0}
            onClick={props.onQualityCheck}
            title="对每个 Hive 托管代理调用 Sub2API quality-check：让 Sub2API 真实出站测一次，分数回写本地节点 qualityScore。开销大，按需用。"
          >
            质量检查
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Unlink size={14} />}
            loading={props.draining}
            disabled={!props.connected || !props.maintenance || props.maintenance.summary.drainChanges === 0}
            onClick={props.onDrain}
            title="把绑定到 Hive 托管代理的账号迁移到非保护非托管的 active 代理上。常用于下线 Hive 代理前的腾挪。"
          >
            排空托管
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={14} />}
            loading={props.cleaningEmpty}
            disabled={!props.connected || !props.maintenance || props.maintenance.summary.emptyManagedProxies === 0}
            onClick={props.onCleanupEmpty}
            title="删除所有名称带托管前缀、且当前没有任何账号使用的 Sub2API 代理。只删空壳；保护代理永不被识别为托管代理。"
          >
            清理空代理
          </Button>
        </div>
      </div>
    </CollapsiblePanel>
  );
}

/**
 * codex-tool 账号接管面板（P5-AK/3 实现，本期占位）。
 *
 * 待 codex-tool 完成 `accounts list --include-tokens` 改造后实装。
 * 详见 notes/codex-tool-needs.md §4。
 */
function CodexToolAdoptionPanel() {
  return (
    <CollapsiblePanel
      title="codex-tool 账号接管"
      storageKey="system-codex-adopt"
      actions={<Badge tone="neutral">待 codex-tool 改造</Badge>}
      hint="把 codex-tool 主机上 SQLite 里的账号一次性导入 Hive + 关联 Sub2API + 回填 phone/password 凭据。"
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        本功能依赖 codex-tool 新增 <code>accounts list --include-tokens</code>{" "}
        选项（envelope 含 refresh_token 等字段）。接管走<strong>文件上传</strong>路径，
        不在 Hive 容器内 spawn codex-tool 读你的 stateful 库——你的账号数据无需暴露给 Hive 主机。
      </p>
      <div className="muted small" style={{ marginBottom: 8 }}>
        <strong>使用流程（codex-tool 改造完成后）：</strong>
      </div>
      <ol className="muted small">
        <li>
          在 codex-tool 数据所在主机执行：
          <pre style={{ marginTop: 4, marginBottom: 4 }}>
            <code>{`codex-tool accounts list --include-tokens \\
  --json --no-color --reveal-secrets \\
  --data-dir ~/.local/share/codex-tool \\
  > codex-export.json`}</code>
          </pre>
        </li>
        <li>scp / 网盘 / 拷贝到能访问 Hive Web UI 的设备上</li>
        <li>本面板上传 JSON → 预览三分支去重 → 一键导入</li>
      </ol>
      <div className="muted small">三分支去重逻辑：</div>
      <ul className="muted small">
        <li>
          <strong>Sub2API 已有 × codex-tool 有凭据</strong> →
          升级 adopted_recovered，回填 phone+password，未来可自动 codex_login 自愈
        </li>
        <li>
          <strong>Sub2API 无 × codex-tool 有 refresh_token</strong> →
          走 refreshOpenaiToken + createAccount，新增 hive_registered
        </li>
        <li>
          <strong>Sub2API 无 × codex-tool 仅 phone+pwd 无 refresh_token</strong> →
          落 Hive observed-only，提示跳 codex_login 一次救活
        </li>
      </ul>
    </CollapsiblePanel>
  );
}
