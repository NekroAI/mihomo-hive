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
  pushToast: (tone: "success" | "danger" | "warning" | "info", title: string, detail?: string) => void;
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
      props.pushToast(
        "success",
        `已提交 ${res.enqueued} 个账号接管`,
        "后台正在逐个处理，可到「账号编排」页查看每个账号的接管进度。"
      );
      // 清空表单
      setEnvelopeJson(null);
      setFileName(null);
      setFileSize(0);
      setPlan(null);
      setSelectedIds(new Set());
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err) => {
      props.pushToast("danger", "接管提交失败", err.message);
    }
  });

  // 读文件 + 触发预览（被 handleFileChange 直接调用，或大文件确认后调用）
  async function proceedWithFile(file: File) {
    const text = await file.text();
    setEnvelopeJson(text);
    setFileName(file.name);
    setFileSize(file.size);
    setPlan(null);
    setParseError(null);
    setSelectedIds(new Set());
    previewMutation.mutate({ envelopeJson: text });
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // input 一旦读完就清值，方便用户重选同名文件再次触发 onChange
    e.target.value = "";
    if (file.size > FILE_SIZE_WARN_BYTES) {
      props.requestConfirmation({
        title: "文件较大，确认继续？",
        description: `文件 ${(file.size / 1024 / 1024).toFixed(1)} MB，超出常规接管规模（>5MB ≈ 2500 个账号）。`,
        detail: "大文件解析可能稍慢，但不影响正确性。",
        confirmLabel: "继续解析",
        run: async () => {
          await proceedWithFile(file);
        }
      });
      return;
    }
    await proceedWithFile(file);
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
      props.pushToast("warning", "请至少勾选一个账号", "下方列表里勾选要接管的账号后再提交。");
      return;
    }
    props.requestConfirmation({
      title: `确认接管 ${importable.length} 个账号？`,
      description: "后台会逐个处理：写入加密凭据、并按需在 Sub2API 建账号。处理是异步的，提交后到「账号编排」页查看进度。",
      detail: [
        `· 补全已有账号凭据：${importable.filter((i) => i.action === "upgrade_recovered").length} 个`,
        `· 新建并接入 Sub2API：${importable.filter((i) => i.action === "register_new").length} 个`,
        `· 仅本地记录（待登录）：${importable.filter((i) => i.action === "observed_only").length} 个`
      ].join("\n"),
      confirmLabel: "确认接管",
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
  const importableCount = plan
    ? plan.items.filter(
        (i) => i.action !== "skip_already_hive" && i.action !== "skip_creds_complete"
      ).length
    : 0;

  return (
    <CollapsiblePanel
      title="codex-tool 账号接管"
      storageKey="system-codex-adopt"
      actions={
        hasFile && plan ? (
          <Badge tone={summaryConfigured ? "success" : "neutral"}>
            扫描到 {plan.summary.totalScanned} 个账号
          </Badge>
        ) : null
      }
      hint="把 codex-tool 主机上 SQLite 里的账号一次性导入 Hive + 关联 Sub2API + 回填 phone/password 凭据。"
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        在 codex-tool 数据所在主机执行：
      </p>
      <pre style={{ marginTop: 4, marginBottom: 12, padding: 8, fontSize: "0.85em" }}>
        <code>{`codex-tool accounts list --include-tokens \\
  --json --no-color --reveal-secrets \\
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
              扫描结果（共 {plan.summary.totalScanned} 个账号）：
            </div>
            <div className="adoption-stat-grid">
              <SummaryStat
                tone="info"
                label="补全凭据"
                value={plan.summary.upgradeRecovered}
                hint="Sub2API 已有，回填手机号 + 密码后可自动登录续命"
              />
              <SummaryStat
                tone="success"
                label="新建并接入"
                value={plan.summary.registerNew}
                hint="凭据有效，将在 Sub2API 建号并纳入账号池"
              />
              <SummaryStat
                tone="warning"
                label="仅记录（待登录）"
                value={plan.summary.observedOnly}
                hint="凭据已过期，先存档，之后手动触发一次登录救活"
              />
              <SummaryStat
                tone="neutral"
                label="跳过"
                value={plan.summary.skipped}
                hint="账号已存在且凭据完整，无需重复接管"
              />
            </div>
            {sub2apiReachable === false ? (
              <div className="muted small" style={{ marginTop: 8, color: "var(--warning)" }}>
                <AlertCircle size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                Sub2API 未连接，只能在本地账号里比对 —— "补全凭据"类可能漏判。
                建议先在上方配置并连接 Sub2API，再重新上传预览。
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
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label="全选可接管账号"
                      checked={importableCount > 0 && selectedIds.size >= importableCount}
                      onChange={(e) => (e.target.checked ? handleSelectAllImportable() : handleClearSelection())}
                    />
                  </th>
                  <th>邮箱 / 手机</th>
                  <th>处理方式</th>
                  <th>说明</th>
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
          正在分析文件、比对已有账号...
        </div>
      ) : null}
    </CollapsiblePanel>
  );
}

/** 接管统计卡 —— 大号数字为主，标签在上、说明在下。 */
function SummaryStat(props: {
  tone: "success" | "warning" | "info" | "neutral";
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className={`adoption-stat adoption-stat-${props.tone}`}>
      <div className="adoption-stat-label">{props.label}</div>
      <div className="adoption-stat-value">{props.value}</div>
      <div className="adoption-stat-hint">{props.hint}</div>
    </div>
  );
}

const ACTION_LABEL: Record<AdoptionAction, { tone: "success" | "info" | "warning" | "neutral"; label: string }> = {
  upgrade_recovered: { tone: "info", label: "补全凭据" },
  register_new: { tone: "success", label: "新建接入" },
  observed_only: { tone: "warning", label: "仅记录" },
  skip_already_hive: { tone: "neutral", label: "跳过" },
  skip_creds_complete: { tone: "neutral", label: "跳过" }
};

function ActionBadge(props: { action: AdoptionAction }) {
  const cfg = ACTION_LABEL[props.action];
  return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
}
