import React from "react";
import { Activity, CheckCircle2, Save, XCircle } from "lucide-react";
import type { AccountFleetSpec } from "@mihomo-hive/schemas";
import {
  Badge,
  Button,
  CollapsiblePanel,
  Panel,
  SelectInput,
  TextInput
} from "../../components/ui.js";

/**
 * codex-tool 连接表单（P5-AK 从 AccountFleetSpecPanel 抽出复用）。
 *
 * 这个区块对应 AccountFleetSpec.codexTool 子树 —— 跟整体 spec 是包含关系，
 * 但**只编辑 codexTool 子树**：保存时调用 saveCodexTool 接口（router 端
 * 已实现，P5-AF）；其它 spec 字段不受影响。这样系统页的连接配置不会污染
 * 账号编排页的策略编辑状态。
 *
 * `lastTest` / `onTest` 配合 P5-AF 的连通测试 endpoint：调用 sms countries
 * 一次走全链路（binPath → SkyMail → 接码 provider），inline 显示结果。
 *
 * 折叠状态持久化复用 P5-AF 同一 storageKey（account-fleet-codex-tool）—— 用户
 * 在某处收起后另一处也是收起。账号编排页移除该面板后 storageKey 仍可继续用，
 * 仅作为系统页的折叠记忆。
 */
export type CodexToolTestResult =
  | { ok: true; provider: string; service: string; countriesSampled: number; totalCountries: number }
  | { ok: false; error: string };

export function CodexToolConnectionPanel(props: {
  draft: AccountFleetSpec["codexTool"];
  saving: boolean;
  testing: boolean;
  lastTest?: CodexToolTestResult | null | undefined;
  onDraftChange: (next: AccountFleetSpec["codexTool"]) => void;
  onSave: () => void;
  onTest: () => void;
  collapsible?: boolean;
}) {
  const draft = props.draft;
  const configured = Boolean(
    draft.binPath &&
      draft.skymail.baseUrl &&
      draft.skymail.adminEmail &&
      draft.chatgpt.codexClientId &&
      draft.phoneSms.apiKeyRef
  );
  const patch = (updater: (c: AccountFleetSpec["codexTool"]) => AccountFleetSpec["codexTool"]) => {
    props.onDraftChange(updater(draft));
  };
  const body = (
    <>
      <div className="form-grid">
        <TextInput
          label="二进制路径"
          value={draft.binPath}
          onChange={(v) => patch((c) => ({ ...c, binPath: v }))}
          placeholder="/home/USER/.local/bin/codex-tool"
          mono
        />
        <NumberInput
          label="login 超时（秒）"
          value={Math.round(draft.timeouts.loginMs / 1000)}
          min={5}
          onChange={(v) => patch((c) => ({ ...c, timeouts: { ...c.timeouts, loginMs: v * 1000 } }))}
        />
        <NumberInput
          label="register 超时（秒）"
          value={Math.round(draft.timeouts.registerMs / 1000)}
          min={5}
          onChange={(v) => patch((c) => ({ ...c, timeouts: { ...c.timeouts, registerMs: v * 1000 } }))}
        />
      </div>
      <div className="config-subgroup-label">SkyMail（邮箱 OTP）</div>
      <div className="form-grid">
        <TextInput
          label="base URL"
          value={draft.skymail.baseUrl}
          onChange={(v) => patch((c) => ({ ...c, skymail: { ...c.skymail, baseUrl: v } }))}
          placeholder="https://mail.example.com"
          mono
        />
        <TextInput
          label="管理员邮箱"
          value={draft.skymail.adminEmail}
          onChange={(v) => patch((c) => ({ ...c, skymail: { ...c.skymail, adminEmail: v } }))}
          placeholder="admin@example.com"
          mono
        />
        <TextInput
          label="管理员密码"
          value={draft.skymail.adminPasswordRef}
          onChange={(v) => patch((c) => ({ ...c, skymail: { ...c.skymail, adminPasswordRef: v } }))}
          type="password"
          mono
        />
      </div>
      <div className="config-subgroup-label">ChatGPT OAuth</div>
      <div className="form-grid">
        <TextInput
          label="mail domain"
          value={draft.chatgpt.mailDomain}
          onChange={(v) => patch((c) => ({ ...c, chatgpt: { ...c.chatgpt, mailDomain: v } }))}
          placeholder="example.com"
          mono
        />
        <TextInput
          label="chat web client_id"
          value={draft.chatgpt.chatWebClientId}
          onChange={(v) => patch((c) => ({ ...c, chatgpt: { ...c.chatgpt, chatWebClientId: v } }))}
          placeholder="app_xxx"
          mono
        />
        <TextInput
          label="codex client_id"
          value={draft.chatgpt.codexClientId}
          onChange={(v) => patch((c) => ({ ...c, chatgpt: { ...c.chatgpt, codexClientId: v } }))}
          placeholder="app_xxx"
          mono
        />
      </div>
      <div className="config-subgroup-label">接码平台</div>
      <div className="form-grid">
        <SelectInput
          label="provider"
          value={draft.phoneSms.provider}
          onChange={(v) =>
            patch((c) => ({
              ...c,
              phoneSms: {
                ...c.phoneSms,
                provider: v as AccountFleetSpec["codexTool"]["phoneSms"]["provider"]
              }
            }))
          }
          options={[
            { label: "HeroSMS", value: "herosms" },
            { label: "5sim", value: "fivesim" },
            { label: "NexSMS", value: "nexsms" }
          ]}
        />
        <TextInput
          label="API key"
          value={draft.phoneSms.apiKeyRef}
          onChange={(v) => patch((c) => ({ ...c, phoneSms: { ...c.phoneSms, apiKeyRef: v } }))}
          type="password"
          mono
        />
        <TextInput
          label="service code"
          value={draft.phoneSms.service}
          onChange={(v) => patch((c) => ({ ...c, phoneSms: { ...c.phoneSms, service: v } }))}
          placeholder="dr"
          mono
        />
      </div>
      <div className="config-subgroup-label">出口代理（codex-tool 走的本地节点）</div>
      <div className="form-grid">
        <SelectInput
          label="模式"
          value={draft.egress.mode}
          onChange={(v) =>
            patch((c) => ({
              ...c,
              egress: { ...c.egress, mode: v as AccountFleetSpec["codexTool"]["egress"]["mode"] }
            }))
          }
          options={[
            { label: "managed-node（按质量+负载加权随机）", value: "managed-node" },
            { label: "pinned-node（钉死一个节点）", value: "pinned-node" },
            { label: "none（不走本地代理直连）", value: "none" }
          ]}
        />
        {draft.egress.mode === "pinned-node" ? (
          <TextInput
            label="节点 hash"
            value={draft.egress.pinnedNodeHash ?? ""}
            onChange={(v) =>
              patch((c) => ({ ...c, egress: { ...c.egress, pinnedNodeHash: v.trim() || null } }))
            }
            placeholder="本地节点 hash 前缀（节点池里看）"
            mono
          />
        ) : null}
      </div>
      <div className="spec-save-bar" style={{ marginTop: 12 }}>
        <Button
          icon={<Save size={16} />}
          loading={props.saving}
          onClick={() => {
            props.onSave();
            try {
              window.localStorage.setItem("mihomo-hive.panel.account-fleet-codex-tool", "0");
            } catch {
              // ignore
            }
          }}
        >
          保存 codex-tool 配置
        </Button>
        <Button
          variant="secondary"
          icon={<Activity size={16} />}
          loading={props.testing}
          onClick={props.onTest}
          title="调用 codex-tool sms countries 一次，验证 binary 可执行 + SkyMail 链路 + 接码 apiKey 都对。不写库、不下发 job。"
        >
          测试连通
        </Button>
        {props.lastTest ? (
          props.lastTest.ok ? (
            <span
              className="muted small"
              title={`provider=${props.lastTest.provider} service=${props.lastTest.service}`}
            >
              <CheckCircle2 size={12} style={{ verticalAlign: "middle", marginRight: 4, color: "var(--success)" }} />
              连通正常（{props.lastTest.provider} · 抽样 {props.lastTest.countriesSampled}/{props.lastTest.totalCountries} 个地区）
            </span>
          ) : (
            <span className="muted small" title={props.lastTest.error}>
              <XCircle size={12} style={{ verticalAlign: "middle", marginRight: 4, color: "var(--danger)" }} />
              连通失败：{truncateError(props.lastTest.error)}
            </span>
          )
        ) : null}
      </div>
    </>
  );
  const badge = (
    <Badge tone={configured ? "success" : "warning"}>{configured ? "已配置" : "待配置"}</Badge>
  );
  if (props.collapsible === false) {
    return (
      <Panel
        title="codex-tool 连接"
        actions={badge}
        hint="codex-tool 二进制路径 + SkyMail + ChatGPT OAuth + 接码 provider + 出口代理模式。系统级配置：账号编排和账号接管都依赖这里。"
      >
        {body}
      </Panel>
    );
  }
  return (
    <CollapsiblePanel
      title="codex-tool 连接"
      storageKey="account-fleet-codex-tool"
      defaultOpen={!configured}
      hint="codex-tool 二进制路径 + SkyMail + ChatGPT OAuth + 接码 provider + 出口代理模式。系统级配置：账号编排和账号接管都依赖这里。"
      actions={badge}
    >
      {body}
    </CollapsiblePanel>
  );
}

function truncateError(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * 项目规范的 NumberInput —— 跟 OrchestrationSpecPanel / AccountFleetSpecPanel 里的本地
 * NumberInput 同款 className 和行为。这里复制一份是为了让 CodexToolConnectionPanel 可独立
 * 复用，不依赖 SpecPanel 内部实现。未来 ui.tsx 可以收口三处共用。
 */
function NumberInput(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        className="text-input font-mono"
        type="number"
        value={Number.isFinite(props.value) ? props.value : 0}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) props.onChange(next);
        }}
      />
    </label>
  );
}
