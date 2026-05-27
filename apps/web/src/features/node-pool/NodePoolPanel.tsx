import React from "react";
import { AlertTriangle, CheckCircle2, DownloadCloud, PauseCircle, PlayCircle, RefreshCw, Rocket, Search, Trash2 } from "lucide-react";
import type { NodeDeletionPlan, ProxyNode, SubscriptionImportPreview, SubscriptionSource } from "@mihomo-hive/schemas";
import { Badge, Button, EmptyState, Panel, TextInput } from "../../components/ui.js";
import { formatRegion } from "../nodes/node-utils.js";

export function NodePoolPanel(props: {
  subscriptions: Array<Omit<SubscriptionSource, "lastContent"> & { fetched: boolean; lastContentBytes?: number }>;
  nodes: ProxyNode[];
  selectedCount: number;
  busy: boolean;
  importName: string;
  importUrl: string;
  importKeywords: string;
  preview: SubscriptionImportPreview | undefined;
  deletePlan: NodeDeletionPlan | undefined;
  previewing: boolean;
  importing: boolean;
  publishing: boolean;
  onImportNameChange: (value: string) => void;
  onImportUrlChange: (value: string) => void;
  onImportKeywordsChange: (value: string) => void;
  onPreviewImport: (source?: { id: string; name: string; url: string; excludeKeywords: string[] }) => void;
  onApplyImport: () => void;
  onClearPreview: () => void;
  onEnableSelected: () => void;
  onDisableSelected: () => void;
  onPreviewDeleteSelected: () => void;
  onApplyDeleteSelected: (forceLocal: boolean) => void;
  onTest: () => void;
  onPublish: () => void;
  onDeleteSubscription: (id: string) => void;
}) {
  const schedulable = props.nodes.filter((node) => node.lifecycleStatus === "schedulable").length;
  const cooling = props.nodes.filter((node) => node.lifecycleStatus === "cooling_down").length;
  const candidate = props.nodes.filter((node) => node.lifecycleStatus === "candidate").length;
  const disabled = props.nodes.filter((node) => node.lifecycleStatus === "disabled").length;
  const keywordList = parseKeywords(props.importKeywords);

  return (
    <aside className="node-pool-panel">
      <Panel
        title="节点池"
        actions={<Badge tone={schedulable > 0 ? "success" : "warning"}>{schedulable > 0 ? "可调度" : "待处理"}</Badge>}
      >
        <div className="metric-grid compact">
          <Metric label="可调度" value={schedulable} tone="success" />
          <Metric label="候选" value={candidate} tone="info" />
          <Metric label="冷却" value={cooling} tone="warning" />
          <Metric label="停用" value={disabled} tone="neutral" />
        </div>
      </Panel>

      <Panel title="导入订阅">
        <div className="stack">
          <TextInput label="名称" value={props.importName} onChange={props.onImportNameChange} placeholder="primary" />
          <TextInput label="订阅 URL" value={props.importUrl} onChange={props.onImportUrlChange} placeholder="https://example.com/sub" mono />
          <TextInput
            label="排除关键词"
            value={props.importKeywords}
            onChange={props.onImportKeywordsChange}
            placeholder="官网,到期,剩余流量"
          />
          <div className="button-row">
            <Button
              icon={<Search size={16} />}
              loading={props.previewing}
              disabled={props.busy || !props.importName || !props.importUrl}
              onClick={() => props.onPreviewImport()}
            >
              拉取并预览
            </Button>
            <Button
              variant="secondary"
              icon={<DownloadCloud size={16} />}
              loading={props.importing}
              disabled={!props.preview || props.preview.summary.importable === 0}
              onClick={props.onApplyImport}
            >
              导入预览结果
            </Button>
          </div>
          {keywordList.length > 0 ? <p className="muted small">将排除：{keywordList.join("、")}</p> : null}
        </div>
      </Panel>

      <Panel title="已保存订阅">
        <div className="subscription-list">
          {props.subscriptions.length === 0 ? (
            <EmptyState title="还没有订阅源" description="输入订阅链接后先预览，再确认导入节点。" />
          ) : (
            props.subscriptions.map((source) => (
              <div key={source.id} className="subscription-row-card">
                <button
                  type="button"
                  onClick={() =>
                    props.onPreviewImport({
                      id: source.id,
                      name: source.name,
                      url: source.value,
                      excludeKeywords: source.excludeKeywords
                    })
                  }
                >
                  <strong>{source.name}</strong>
                  <span>{source.fetched ? `${source.lastContentBytes ?? 0} bytes` : "点击更新预览"}</span>
                </button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => props.onDeleteSubscription(source.id)}>
                  删除
                </Button>
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel title="调度动作">
        <div className="stack">
          <p className="muted small">已选择 {props.selectedCount} 个节点。启用后系统会把节点纳入 Mihomo 发布与 Sub2API 分配范围。</p>
          <div className="button-row wrap">
            <Button icon={<PlayCircle size={16} />} disabled={props.busy || props.selectedCount === 0} onClick={props.onEnableSelected}>
              启用调度
            </Button>
            <Button variant="secondary" icon={<PauseCircle size={16} />} disabled={props.busy || props.selectedCount === 0} onClick={props.onDisableSelected}>
              暂停调度
            </Button>
          </div>
          <div className="button-row wrap">
            <Button variant="secondary" icon={<RefreshCw size={16} />} disabled={props.busy || props.nodes.length === 0} onClick={props.onTest}>
              测试节点池
            </Button>
            <Button icon={<Rocket size={16} />} loading={props.publishing} disabled={props.busy || schedulable === 0} onClick={props.onPublish}>
              发布出口池
            </Button>
          </div>
          <Button variant="danger" icon={<Trash2 size={16} />} disabled={props.busy || props.selectedCount === 0} onClick={props.onPreviewDeleteSelected}>
            排空/删除所选
          </Button>
        </div>
      </Panel>

      {props.preview ? <ImportPreviewDialog preview={props.preview} onClose={props.onClearPreview} onApply={props.onApplyImport} /> : null}
      {props.deletePlan ? (
        <DeletePlanDialog plan={props.deletePlan} onClose={() => props.onApplyDeleteSelected(false)} onForceLocal={() => props.onApplyDeleteSelected(true)} />
      ) : null}
    </aside>
  );
}

function ImportPreviewDialog(props: { preview: SubscriptionImportPreview; onClose: () => void; onApply: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog wide" role="dialog" aria-modal="true">
        <h2>订阅导入预览</h2>
        <p>
          共解析 {props.preview.summary.total} 个节点，可导入/更新 {props.preview.summary.importable} 个，过滤{" "}
          {props.preview.summary.filtered} 个，重复 {props.preview.summary.duplicates} 个。
        </p>
        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr>
                <th>动作</th>
                <th>节点</th>
                <th>地区</th>
                <th>协议</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {props.preview.items.slice(0, 160).map((item) => (
                <tr key={`${item.hash}-${item.action}`}>
                  <td><PreviewAction action={item.action} /></td>
                  <td>{item.name}</td>
                  <td>{formatRegion(item.region)}</td>
                  <td>{item.type}</td>
                  <td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer>
          <Button variant="secondary" onClick={props.onClose}>取消</Button>
          <Button disabled={props.preview.summary.importable === 0} onClick={props.onApply}>导入这些节点</Button>
        </footer>
      </section>
    </div>
  );
}

function DeletePlanDialog(props: { plan: NodeDeletionPlan; onClose: () => void; onForceLocal: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog wide" role="dialog" aria-modal="true">
        <h2>节点删除计划</h2>
        <p>{props.plan.message}</p>
        {props.plan.blockingAccounts.length > 0 ? (
          <div className="warning-box">
            <AlertTriangle size={18} />
            <span>仍有 {props.plan.blockingAccounts.length} 个账号绑定到这些代理。请先在 Sub2API 自动化中应用重绑定计划。</span>
          </div>
        ) : (
          <div className="success-box">
            <CheckCircle2 size={18} />
            <span>没有账号阻塞，可以删除本地节点，并尝试删除对应 Sub2API 代理。</span>
          </div>
        )}
        <footer>
          <Button variant="secondary" onClick={props.onClose}>关闭</Button>
          <Button variant="danger" disabled={!props.plan.canDeleteNow} onClick={props.onForceLocal}>确认删除</Button>
        </footer>
      </section>
    </div>
  );
}

function PreviewAction(props: { action: SubscriptionImportPreview["items"][number]["action"] }) {
  const label = {
    import: "导入",
    update: "更新",
    skip_duplicate: "重复",
    skip_existing: "已存在",
    skip_filtered: "过滤"
  }[props.action];
  const tone = props.action === "import" || props.action === "update" ? "success" : props.action === "skip_filtered" ? "warning" : "neutral";
  return <Badge tone={tone}>{label}</Badge>;
}

function Metric(props: { label: string; value: number; tone: "success" | "info" | "warning" | "neutral" }) {
  return (
    <div className={`metric-card metric-${props.tone}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function parseKeywords(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
