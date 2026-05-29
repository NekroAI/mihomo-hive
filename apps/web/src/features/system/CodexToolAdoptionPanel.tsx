import React from "react";
import { Upload, FileText, CheckCircle2, AlertCircle } from "lucide-react";
import { Badge, Button, CollapsiblePanel } from "../../components/ui.js";
import { trpc } from "../../lib/trpc.js";
import type { ConfirmAction } from "../../hooks/useConfirmAction.js";

/**
 * codex-tool 账号接管面板（P5-AK/3d）。
 *
 * 流程：
 *   1. 用户选择 codex-tool 导出的 JSON 文件（accounts list --include-tokens 的 stdout）
 *   2. 上传 → preview 三分支去重 + summary
 *   3. confirm → import N 个 import_codex_tool_account job
 *
 * 文件大小约束：每个账号 envelope 大约 1-2KB，1000 账号 ≈ 2MB。当前阈值 5MB
 * 提示用户（不阻断）；真出现 GB 级文件再优化（分片上传）。
 */
type AdoptionAction =
  | "upgrade_recovered"
  | "register_new"
  | "observed_only"
  | "skip_already_hive"
  | "skip_creds_complete";

interface PlanItem {
  source: {
    id: number;
    phone: string;
    password: string;
    email: string | null;
    batchId: string | null;
    status: string;
    refreshToken: string | null;
  };
  action: AdoptionAction;
  reason: string;
  sub2apiAccountId?: number;
  hiveLocalId?: string;
}

interface PlanSummary {
  totalScanned: number;
  upgradeRecovered: number;
  registerNew: number;
  observedOnly: number;
  skipped: number;
  invalidSkipped: number;
}

const FILE_SIZE_WARN_BYTES = 5 * 1024 * 1024;

export function CodexToolAdoptionPanel(props: {
  sub2apiConnected: boolean;
  requestConfirmation: (a: ConfirmAction) => void;
}) {
  const [envelopeJson, setEnvelopeJson] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [fileSize, setFileSize] = React.useState<number>(0);
  const [plan, setPlan] = React.useState<{ items: PlanItem[]; summary: PlanSummary } | null>(null);
  const [sub2apiReachable, setSub2apiReachable] = React.useState<boolean | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const [parseError, setParseError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const previewMutation = trpc.accountFleet.adoption.codexTool.preview.useMutation({
    onSuccess: (res) => {
      setPlan(res.plan);
      setSub2apiReachable(res.sub2apiReachable);
      // 默认勾选所有非 skip 的条目
      const defaultSelected = new Set<number>();
      for (const item of res.plan.items) {
        if (item.action !== "skip_already_hive" && item.action !== "skip_creds_complete") {
          defaultSelected.add(item.source.id);
        }
      }
      setSelectedIds(defaultSelected);
      setParseError(null);
    },
    onError: (err) => {
      setParseError(err.message);
      setPlan(null);
    }
  });

  const importMutation = trpc.accountFleet.adoption.codexTool.import.useMutation({
    onSuccess: (res) => {
      window.alert(`已入队 ${res.enqueued} 个接管 job，worker 将异步处理。可在账号编排页观察进度。`);
      // 清空表单
      setEnvelopeJson(null);
      setFileName(null);
      setFileSize(0);
      setPlan(null);
      setSelectedIds(new Set());
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > FILE_SIZE_WARN_BYTES) {
      if (!window.confirm(
        `文件 ${(file.size / 1024 / 1024).toFixed(1)} MB，超出常规接管规模（>5MB ≈ 2500 账号）。继续？`
      )) {
        e.target.value = "";
        return;
      }
    }
    const text = await file.text();
    setEnvelopeJson(text);
    setFileName(file.name);
    setFileSize(file.size);
    setPlan(null);
    setParseError(null);
    setSelectedIds(new Set());
    previewMutation.mutate({ envelopeJson: text });
  }

  function handleToggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSelectAllImportable() {
    if (!plan) return;
    setSelectedIds(
      new Set(
        plan.items
          .filter((i) => i.action !== "skip_already_hive" && i.action !== "skip_creds_complete")
          .map((i) => i.source.id)
      )
    );
  }
  function handleClearSelection() {
    setSelectedIds(new Set());
  }

  function handleImport() {
    if (!envelopeJson || !plan) return;
    const importable = plan.items.filter(
      (i) =>
        (i.action === "upgrade_recovered" || i.action === "register_new" || i.action === "observed_only") &&
        selectedIds.has(i.source.id)
    );
    if (importable.length === 0) {
      window.alert("请至少选择一条可导入账号。");
      return;
    }
    props.requestConfirmation({
      title: "确认导入 codex-tool 账号",
      description: `将入队 ${importable.length} 个接管 job。worker 异步处理，可在账号编排页观察。`,
      detail: [
        `升级 adopted_recovered: ${importable.filter((i) => i.action === "upgrade_recovered").length}`,
        `注册新账号(refresh + create): ${importable.filter((i) => i.action === "register_new").length}`,
        `仅本地落 observed-only: ${importable.filter((i) => i.action === "observed_only").length}`
      ].join("\n"),
      confirmLabel: "入队导入",
      run: async () =>
        importMutation.mutate({
          envelopeJson,
          selectedExternalIds: Array.from(selectedIds)
        })
    });
  }

  const hasFile = Boolean(envelopeJson);
  const summaryConfigured =
    plan?.summary &&
    plan.summary.upgradeRecovered + plan.summary.registerNew + plan.summary.observedOnly > 0;

  return (
    <CollapsiblePanel
      title="codex-tool 账号接管"
      storageKey="system-codex-adopt"
      actions={
        hasFile && plan ? (
          <Badge tone={summaryConfigured ? "success" : "neutral"}>
            {plan.summary.totalScanned} 条扫描
          </Badge>
        ) : (
          <Badge tone="neutral">就绪</Badge>
        )
      }
      hint="把 codex-tool 主机上 SQLite 里的账号一次性导入 Hive + 关联 Sub2API + 回填 phone/password 凭据。"
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        在 codex-tool 数据所在主机执行：
      </p>
      <pre style={{ marginTop: 4, marginBottom: 12, padding: 8, fontSize: "0.85em" }}>
        <code>{`codex-tool accounts list --include-tokens \\
  --json --no-color --reveal-secrets \\
  --data-dir ~/.local/share/codex-tool \\
  > codex-export.json`}</code>
      </pre>

      <div className="button-row">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileChange}
          style={{ display: "none" }}
        />
        <Button icon={<Upload size={16} />} onClick={() => fileInputRef.current?.click()}>
          {hasFile ? "重新选择文件" : "选择 codex-export.json"}
        </Button>
        {hasFile ? (
          <span className="muted small">
            <FileText size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
            {fileName} · {(fileSize / 1024).toFixed(1)} KB
          </span>
        ) : null}
      </div>

      {parseError ? (
        <div className="muted small" style={{ marginTop: 12, color: "var(--danger)" }}>
          <AlertCircle size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
          {parseError}
        </div>
      ) : null}

      {plan ? (
        <>
          <div style={{ marginTop: 16 }}>
            <div className="muted small" style={{ marginBottom: 8 }}>
              扫描结果（共 {plan.summary.totalScanned} 条）：
            </div>
            <div className="form-grid" style={{ gap: 8 }}>
              <SummaryStat
                tone="info"
                label="升级 adopted_recovered"
                value={plan.summary.upgradeRecovered}
                hint="远端有 + codex 凭据回填 → 本地凭据齐"
              />
              <SummaryStat
                tone="success"
                label="新建 hive_registered"
                value={plan.summary.registerNew}
                hint="refresh_token 有效 → refresh + create Sub2API account"
              />
              <SummaryStat
                tone="warning"
                label="observed-only"
                value={plan.summary.observedOnly}
                hint="refresh 缺，需手动 codex_login"
              />
              <SummaryStat
                tone="neutral"
                label="跳过（已存在）"
                value={plan.summary.skipped}
                hint="本地凭据已齐 / 已 hive_registered"
              />
            </div>
            {sub2apiReachable === false ? (
              <div className="muted small" style={{ marginTop: 8, color: "var(--warning)" }}>
                <AlertCircle size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                Sub2API 未连接或不可达 —— 预览只在本地账号匹配，所有"upgrade_recovered"
                可能漏判。建议先到 Sub2API 连接区配置后重新预览。
              </div>
            ) : null}
          </div>

          <div className="button-row" style={{ marginTop: 12 }}>
            <Button size="sm" variant="secondary" onClick={handleSelectAllImportable}>
              全选可导入
            </Button>
            <Button size="sm" variant="ghost" onClick={handleClearSelection}>
              清空选择
            </Button>
            <span className="muted small">
              已选 <strong>{selectedIds.size}</strong> 条
            </span>
          </div>

          <div style={{ maxHeight: 320, overflowY: "auto", marginTop: 12, border: "1px solid var(--border)" }}>
            <table className="node-matrix-table" style={{ fontSize: "0.85em" }}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>选</th>
                  <th>邮箱 / 手机</th>
                  <th>action</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => (
                  <tr key={item.source.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.source.id)}
                        disabled={item.action === "skip_already_hive" || item.action === "skip_creds_complete"}
                        onChange={() => handleToggleSelect(item.source.id)}
                      />
                    </td>
                    <td>
                      <div className="mono-strong">{item.source.email ?? "(无 email)"}</div>
                      <div className="muted small">
                        {item.source.phone} · {item.source.status}
                      </div>
                    </td>
                    <td>
                      <ActionBadge action={item.action} />
                    </td>
                    <td className="muted small">{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="button-row" style={{ marginTop: 12 }}>
            <Button
              icon={<CheckCircle2 size={16} />}
              loading={importMutation.isPending}
              disabled={selectedIds.size === 0}
              onClick={handleImport}
            >
              导入 {selectedIds.size} 条
            </Button>
          </div>
        </>
      ) : previewMutation.isPending ? (
        <div className="muted small" style={{ marginTop: 12 }}>
          正在解析 envelope 并扫描去重...
        </div>
      ) : null}
    </CollapsiblePanel>
  );
}

function SummaryStat(props: {
  tone: "success" | "warning" | "info" | "neutral";
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div>
      <div className="muted small">{props.label}</div>
      <div className="mono-strong">
        <Badge tone={props.tone}>{props.value}</Badge>
      </div>
      <div className="muted small" style={{ marginTop: 2, fontSize: "0.8em" }}>
        {props.hint}
      </div>
    </div>
  );
}

function ActionBadge(props: { action: AdoptionAction }) {
  const map: Record<AdoptionAction, { tone: "success" | "info" | "warning" | "neutral"; label: string }> = {
    upgrade_recovered: { tone: "info", label: "升级 recovered" },
    register_new: { tone: "success", label: "新建" },
    observed_only: { tone: "warning", label: "observe-only" },
    skip_already_hive: { tone: "neutral", label: "跳过" },
    skip_creds_complete: { tone: "neutral", label: "跳过" }
  };
  const cfg = map[props.action];
  return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
}
