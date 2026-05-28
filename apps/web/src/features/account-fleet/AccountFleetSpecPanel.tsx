import React from "react";
import { Pause, Play, Save, Zap } from "lucide-react";
import type { AccountFleetSpec } from "@mihomo-hive/schemas";
import {
  Badge,
  Button,
  Checkbox,
  CollapsiblePanel,
  Panel,
  SelectInput,
  TextInput
} from "../../components/ui.js";

interface PendingMutation {
  isPending: boolean;
}

export interface AccountFleetSpecPanelProps {
  spec: AccountFleetSpec;
  saving: boolean;
  triggering: boolean;
  onSaveSpec: (next: AccountFleetSpec) => void;
  onTriggerNow: () => void;
}

/**
 * AccountFleetSpecPanel —— 账号编排 Spec 编辑面板。
 *
 * 跟现有 OrchestrationSpecPanel 风格对称：折叠卡分组，顶层有"立即触发 / 暂停 / 恢复"。
 * 卡片顺序：目标 / 健康 / 修复 / 出生 / 退役 / codex-tool 连接。
 */
export function AccountFleetSpecPanel(props: AccountFleetSpecPanelProps) {
  const [draft, setDraft] = React.useState<AccountFleetSpec>(props.spec);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    setDraft(props.spec);
    setDirty(false);
  }, [props.spec]);

  function patch<K extends keyof AccountFleetSpec>(key: K, value: AccountFleetSpec[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }

  function patchTarget(value: Partial<AccountFleetSpec["target"]>) {
    setDraft((d) => ({ ...d, target: { ...d.target, ...value } }));
    setDirty(true);
  }
  function patchHealth(value: Partial<AccountFleetSpec["health"]>) {
    setDraft((d) => ({ ...d, health: { ...d.health, ...value } }));
    setDirty(true);
  }
  function patchRecovery(value: Partial<AccountFleetSpec["recovery"]>) {
    setDraft((d) => ({ ...d, recovery: { ...d.recovery, ...value } }));
    setDirty(true);
  }
  function patchRegistration(value: Partial<AccountFleetSpec["registration"]>) {
    setDraft((d) => ({ ...d, registration: { ...d.registration, ...value } }));
    setDirty(true);
  }
  function patchRetirement(value: Partial<AccountFleetSpec["retirement"]>) {
    setDraft((d) => ({ ...d, retirement: { ...d.retirement, ...value } }));
    setDirty(true);
  }
  function patchCodexTool(value: Partial<AccountFleetSpec["codexTool"]>) {
    setDraft((d) => ({ ...d, codexTool: { ...d.codexTool, ...value } }));
    setDirty(true);
  }

  return (
    <section className="account-fleet-spec-panel">
      <Panel
        title="自动维护"
        hint="账号生命周期的全自动循环：观察 → 判定 → 计划 → 限速 → 入队修复 / 注册 jobs。P4 当前为 dry-run，仅产出计划不真正修改远端。"
        actions={
          <div className="button-row">
            <Button
              variant="secondary"
              icon={draft.enabled ? <Pause size={16} /> : <Play size={16} />}
              onClick={() => {
                const next = { ...draft, enabled: !draft.enabled };
                setDraft(next);
                setDirty(false);
                props.onSaveSpec(next);
              }}
              loading={props.saving}
            >
              {draft.enabled ? "暂停" : "恢复"}
            </Button>
            <Button
              variant="secondary"
              icon={<Zap size={16} />}
              loading={props.triggering}
              onClick={props.onTriggerNow}
            >
              立即调和
            </Button>
            <Button
              variant="primary"
              icon={<Save size={16} />}
              loading={props.saving}
              disabled={!dirty}
              onClick={() => {
                props.onSaveSpec(draft);
                setDirty(false);
              }}
            >
              保存策略
            </Button>
          </div>
        }
      >
        <div className="row">
          <Badge tone={draft.enabled ? "success" : "warning"}>{draft.enabled ? "已启用" : "已暂停"}</Badge>
          <span className="muted">
            周期 {Math.round(draft.reconcileIntervalMs / 60_000)} 分钟 · 灰度 {draft.graceBatchPercent}% / 最少{" "}
            {draft.graceBatchAbs}
          </span>
        </div>
        <div className="grid-2-col">
          <NumberField
            label="调和周期（分钟）"
            value={Math.round(draft.reconcileIntervalMs / 60_000)}
            min={1}
            onChange={(v) => patch("reconcileIntervalMs", v * 60_000)}
          />
          <NumberField
            label="灰度阀（最少变更数）"
            value={draft.graceBatchAbs}
            min={0}
            onChange={(v) => patch("graceBatchAbs", v)}
          />
        </div>
      </Panel>

      <CollapsiblePanel
        title="① 目标产能"
        defaultOpen={true}
        storageKey="account-fleet-target"
        hint="健康账号数量目标、默认 group / proxy、命名模板。"
      >
        <div className="grid-2-col">
          <NumberField
            label="目标健康账号数"
            value={draft.target.healthyAccountsTarget}
            min={0}
            onChange={(v) => patchTarget({ healthyAccountsTarget: v })}
          />
          <NumberField
            label="目标 group_id"
            value={draft.target.targetGroupId}
            min={1}
            onChange={(v) => patchTarget({ targetGroupId: v })}
          />
          <NumberField
            label="默认代理 proxy_id"
            value={draft.target.defaultProxyId}
            min={1}
            onChange={(v) => patchTarget({ defaultProxyId: v })}
          />
          <NumberField
            label="最低健康比 (0–1)"
            value={draft.target.minHealthyRatio}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => patchTarget({ minHealthyRatio: v })}
            hint="跌破时进入紧急补给模式。"
          />
        </div>
        <TextInput
          label="账号命名模板（{date}、{seq}）"
          value={draft.target.naming.template}
          onChange={(v) => patchTarget({ naming: { ...draft.target.naming, template: v } })}
        />
      </CollapsiblePanel>

      <CollapsiblePanel
        title="② 健康判定"
        defaultOpen={false}
        storageKey="account-fleet-health"
        hint="多源信号融合：credentials_status + quota + upstream-errors。"
      >
        <Checkbox
          checked={draft.health.refreshTokenMissingAsUnhealthy}
          onChange={(v) => patchHealth({ refreshTokenMissingAsUnhealthy: v })}
          label="refresh_token 缺失视为不健康"
        />
        <Checkbox
          checked={draft.health.rateLimitedAsUnhealthy}
          onChange={(v) => patchHealth({ rateLimitedAsUnhealthy: v })}
          label="rate_limit 视为不健康（默认关）"
        />
        <div className="grid-2-col">
          <NumberField
            label="配额阈值 (%)"
            value={draft.health.quotaExhaustedThresholdPercent}
            min={0}
            max={100}
            onChange={(v) => patchHealth({ quotaExhaustedThresholdPercent: v })}
          />
          <NumberField
            label="配额轮询间隔（分钟）"
            value={Math.round(draft.health.usagePollIntervalMs / 60_000)}
            min={1}
            onChange={(v) => patchHealth({ usagePollIntervalMs: v * 60_000 })}
          />
          <NumberField
            label="错误预算（条/窗口）"
            value={draft.health.errorBudgetPerWindow}
            min={1}
            onChange={(v) => patchHealth({ errorBudgetPerWindow: v })}
          />
          <NumberField
            label="窗口（分钟）"
            value={Math.round(draft.health.windowMs / 60_000)}
            min={1}
            onChange={(v) => patchHealth({ windowMs: v * 60_000 })}
          />
          <NumberField
            label="adopted 降级阈值（tick）"
            value={draft.health.adoptedDemotionConsecutiveTicks}
            min={1}
            onChange={(v) => patchHealth({ adoptedDemotionConsecutiveTicks: v })}
            hint="adopted_active 连续 N 个 tick broken 后降级为 observing。"
          />
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="③ 修复策略"
        defaultOpen={false}
        storageKey="account-fleet-recovery"
        hint="掉登录账号自动修复：PATH_A (codex_login，免费) → PATH_B (codex_register，要钱)。"
      >
        <Checkbox
          checked={draft.recovery.enabled}
          onChange={(v) => patchRecovery({ enabled: v })}
          label="启用自动修复"
        />
        <div className="grid-2-col">
          <NumberField
            label="最大并发修复数"
            value={draft.recovery.maxConcurrent}
            min={1}
            max={10}
            onChange={(v) => patchRecovery({ maxConcurrent: v })}
            hint="受 Sentinel/Playwright 资源限制，建议 ≤ 3。"
          />
          <NumberField
            label="单 tick 修复上限"
            value={draft.recovery.perTickRecoveryCap}
            min={0}
            onChange={(v) => patchRecovery({ perTickRecoveryCap: v })}
          />
          <NumberField
            label="单账号最大尝试次数"
            value={draft.recovery.maxAttemptsPerAccount}
            min={1}
            onChange={(v) => patchRecovery({ maxAttemptsPerAccount: v })}
          />
        </div>
        <Checkbox
          checked={draft.recovery.deleteOldAccountOnRecovery}
          onChange={(v) => patchRecovery({ deleteOldAccountOnRecovery: v })}
          label="修复成功后删除旧 Sub2API 记录（保留 email）"
        />
      </CollapsiblePanel>

      <CollapsiblePanel
        title="④ 出生策略（唯一收费路径）"
        defaultOpen={false}
        storageKey="account-fleet-registration"
        hint="codex-tool all 走接码注册新账号。受 perTick / daily / monthly 三级预算约束。"
      >
        <Checkbox
          checked={draft.registration.enabled}
          onChange={(v) => patchRegistration({ enabled: v })}
          label="启用自动注册"
        />
        <div className="grid-2-col">
          <NumberField
            label="单 tick 注册上限"
            value={draft.registration.perTickCap}
            min={0}
            onChange={(v) => patchRegistration({ perTickCap: v })}
          />
          <NumberField
            label="日预算"
            value={draft.registration.dailyBudget}
            min={0}
            onChange={(v) => patchRegistration({ dailyBudget: v })}
          />
          <NumberField
            label="月预算"
            value={draft.registration.monthlyBudget}
            min={0}
            onChange={(v) => patchRegistration({ monthlyBudget: v })}
          />
          <TextInput
            label="主接码地区 ID"
            value={draft.registration.smsCountry}
            onChange={(v) => patchRegistration({ smsCountry: v })}
          />
        </div>
        <h4>紧急补给（healthy/target &lt; minHealthyRatio）</h4>
        <Checkbox
          checked={draft.registration.emergencyMode.enabled}
          onChange={(v) =>
            patchRegistration({
              emergencyMode: { ...draft.registration.emergencyMode, enabled: v }
            })
          }
          label="启用紧急补给（自动提升 perTickCap）"
        />
        <div className="grid-2-col">
          <NumberField
            label="紧急模式 perTickCap"
            value={draft.registration.emergencyMode.perTickCap}
            min={0}
            onChange={(v) =>
              patchRegistration({
                emergencyMode: { ...draft.registration.emergencyMode, perTickCap: v }
              })
            }
          />
          <Checkbox
            checked={draft.registration.emergencyMode.ignoreDailyBudget}
            onChange={(v) =>
              patchRegistration({
                emergencyMode: { ...draft.registration.emergencyMode, ignoreDailyBudget: v }
              })
            }
            label="紧急模式忽略日预算"
          />
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="⑤ 退役策略"
        defaultOpen={false}
        storageKey="account-fleet-retirement"
        hint="累计失败次数 / 长期无流量 → 自动退役。默认仅 schedulable=false，不删除。"
      >
        <Checkbox
          checked={draft.retirement.afterMaxFailedRecoveries}
          onChange={(v) => patchRetirement({ afterMaxFailedRecoveries: v })}
          label="累计失败次数达上限后退役"
        />
        <NumberField
          label="无流量退役阈值（天）"
          value={draft.retirement.afterDeadDays}
          min={1}
          onChange={(v) => patchRetirement({ afterDeadDays: v })}
        />
        <Checkbox
          checked={draft.retirement.deleteOnRetire}
          onChange={(v) => patchRetirement({ deleteOnRetire: v })}
          label="退役时同时删除 Sub2API 记录（默认关）"
        />
        <NumberField
          label="退役前隔离时长（分钟）"
          value={Math.round(draft.retirement.drainBeforeDeleteMs / 60_000)}
          min={0}
          onChange={(v) => patchRetirement({ drainBeforeDeleteMs: v * 60_000 })}
          hint="先 schedulable=false 等待 N 分钟，确认无在途流量再删。"
        />
      </CollapsiblePanel>

      <CollapsiblePanel
        title="⑥ codex-tool 连接"
        defaultOpen={false}
        storageKey="account-fleet-codex-tool"
        hint="codex-tool 二进制路径、skymail、chatgpt OAuth、接码 provider、出口代理。"
      >
        <TextInput
          label="codex-tool 路径"
          value={draft.codexTool.binPath}
          onChange={(v) => patchCodexTool({ binPath: v })}
          placeholder="codex-tool 或绝对路径（生产建议从 CODEX_TOOL_BIN 注入）"
        />
        <h4>SkyMail（邮箱 OTP）</h4>
        <TextInput
          label="base URL"
          value={draft.codexTool.skymail.baseUrl}
          onChange={(v) => patchCodexTool({ skymail: { ...draft.codexTool.skymail, baseUrl: v } })}
        />
        <TextInput
          label="管理邮箱"
          value={draft.codexTool.skymail.adminEmail}
          onChange={(v) => patchCodexTool({ skymail: { ...draft.codexTool.skymail, adminEmail: v } })}
        />
        <h4>ChatGPT OAuth</h4>
        <TextInput
          label="mail domain"
          value={draft.codexTool.chatgpt.mailDomain}
          onChange={(v) => patchCodexTool({ chatgpt: { ...draft.codexTool.chatgpt, mailDomain: v } })}
        />
        <TextInput
          label="chat web client_id"
          value={draft.codexTool.chatgpt.chatWebClientId}
          onChange={(v) =>
            patchCodexTool({ chatgpt: { ...draft.codexTool.chatgpt, chatWebClientId: v } })
          }
        />
        <TextInput
          label="codex client_id"
          value={draft.codexTool.chatgpt.codexClientId}
          onChange={(v) =>
            patchCodexTool({ chatgpt: { ...draft.codexTool.chatgpt, codexClientId: v } })
          }
        />
        <h4>接码平台</h4>
        <SelectInput
          label="provider"
          value={draft.codexTool.phoneSms.provider}
          onChange={(v) =>
            patchCodexTool({
              phoneSms: {
                ...draft.codexTool.phoneSms,
                provider: v as AccountFleetSpec["codexTool"]["phoneSms"]["provider"]
              }
            })
          }
          options={[
            { label: "HeroSMS", value: "herosms" },
            { label: "5sim", value: "fivesim" },
            { label: "NexSMS", value: "nexsms" }
          ]}
        />
        <TextInput
          label="服务代码（默认 dr）"
          value={draft.codexTool.phoneSms.service}
          onChange={(v) => patchCodexTool({ phoneSms: { ...draft.codexTool.phoneSms, service: v } })}
        />
        <h4>出口代理（codex-tool 通过它访问外部）</h4>
        <SelectInput
          label="模式"
          value={draft.codexTool.egress.mode}
          onChange={(v) =>
            patchCodexTool({
              egress: { ...draft.codexTool.egress, mode: v as AccountFleetSpec["codexTool"]["egress"]["mode"] }
            })
          }
          options={[
            { label: "managed-node（自动选健康节点）", value: "managed-node" },
            { label: "pinned-node（钉死一个）", value: "pinned-node" },
            { label: "none（不走代理，直连）", value: "none" }
          ]}
        />
      </CollapsiblePanel>
    </section>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="field">
      <span>
        {props.label}
        {props.hint ? <span className="field-hint"> · {props.hint}</span> : null}
      </span>
      <input
        type="number"
        className="text-input"
        value={Number.isFinite(props.value) ? props.value : 0}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        onChange={(event) => {
          const n = Number(event.target.value);
          if (Number.isFinite(n)) props.onChange(n);
        }}
      />
    </label>
  );
}

/** 用于兼容旧调用，但当前面板未使用。预留给后续 P6 加 mutations 配套。 */
export type _ReservedPendingMutation = PendingMutation;
