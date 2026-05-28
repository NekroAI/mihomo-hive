import React from "react";
import { Activity, Pause, Play, Save, Wand2, Zap } from "lucide-react";
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

/**
 * 账号编排 Spec 编辑左栏。
 *
 * 跟 OrchestrationSpecPanel 同形：
 *   - 顶部 Panel "自动维护"：暂停/恢复 + 立即调和
 *   - codex-tool 连接 / 出生策略 / 修复策略 / 健康判定 / 退役策略 / 出口代理：CollapsiblePanel
 *   - 底部 spec-save-bar：保存 / 放弃 改动
 *
 * 所有编辑暂存 local draft；点保存才写回服务端。
 */
export function AccountFleetSpecPanel(props: {
  spec: AccountFleetSpec;
  saving: boolean;
  triggering: boolean;
  /** 决定"立即调和"是否可点（无 codex-tool / Sub2API 连接时禁用并提示）。 */
  canTrigger?: boolean;
  /** dry_run / apply —— 从后端 status snapshot 读，UI 用来显示模式 badge */
  mode?: "dry_run" | "apply";
  onSaveSpec: (next: AccountFleetSpec) => void;
  onTriggerNow: () => void;
}) {
  const [draft, setDraft] = React.useState<AccountFleetSpec>(props.spec);
  const [dirty, setDirty] = React.useState(false);

  // 上游 spec 变了（保存后 trpc 重读）→ 同步 draft，除非用户正在编辑
  React.useEffect(() => {
    if (!dirty) setDraft(props.spec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(props.spec)]);

  function patch<K extends keyof AccountFleetSpec>(key: K, value: AccountFleetSpec[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  function patchTarget(updater: (c: AccountFleetSpec["target"]) => AccountFleetSpec["target"]) {
    setDraft((c) => ({ ...c, target: updater(c.target) }));
    setDirty(true);
  }
  function patchHealth(updater: (c: AccountFleetSpec["health"]) => AccountFleetSpec["health"]) {
    setDraft((c) => ({ ...c, health: updater(c.health) }));
    setDirty(true);
  }
  function patchRecovery(updater: (c: AccountFleetSpec["recovery"]) => AccountFleetSpec["recovery"]) {
    setDraft((c) => ({ ...c, recovery: updater(c.recovery) }));
    setDirty(true);
  }
  function patchRegistration(updater: (c: AccountFleetSpec["registration"]) => AccountFleetSpec["registration"]) {
    setDraft((c) => ({ ...c, registration: updater(c.registration) }));
    setDirty(true);
  }
  function patchRetirement(updater: (c: AccountFleetSpec["retirement"]) => AccountFleetSpec["retirement"]) {
    setDraft((c) => ({ ...c, retirement: updater(c.retirement) }));
    setDirty(true);
  }
  function patchCodexTool(updater: (c: AccountFleetSpec["codexTool"]) => AccountFleetSpec["codexTool"]) {
    setDraft((c) => ({ ...c, codexTool: updater(c.codexTool) }));
    setDirty(true);
  }

  const enabled = draft.enabled;
  // codex-tool 配置是否完整（用于是否允许触发 apply）
  const codexConfigured = Boolean(
    draft.codexTool.binPath &&
      draft.codexTool.skymail.baseUrl &&
      draft.codexTool.skymail.adminEmail &&
      draft.codexTool.chatgpt.codexClientId &&
      draft.codexTool.phoneSms.apiKeyRef
  );
  const modeIsApply = props.mode === "apply";
  const dryRunBadgeTone = modeIsApply ? "success" : "warning";
  const dryRunBadgeLabel = modeIsApply ? "apply 模式" : "dry-run 模式";

  return (
    <aside className="orchestration-spec-panel">
      <Panel
        title="自动维护"
        actions={
          <div className="button-row">
            <Badge tone={enabled ? "success" : "warning"}>{enabled ? "运行中" : "已暂停"}</Badge>
            <Badge tone={dryRunBadgeTone}>{dryRunBadgeLabel}</Badge>
          </div>
        }
        hint="按 Spec 周期性观察账号池：自动注册补给、自动修复掉登录账号、自动退役死号。dry-run 模式只观测/计划不入队 jobs；apply 模式需要环境变量 HIVE_ACCOUNT_FLEET_MODE=apply。"
      >
        <div className="button-row wrap">
          {enabled ? (
            <Button
              variant="secondary"
              icon={<Pause size={16} />}
              onClick={() => {
                const next = { ...draft, enabled: false };
                setDraft(next);
                setDirty(false);
                props.onSaveSpec(next);
              }}
              title="暂停后 scheduler 仍跑前 4 步并写 dry-run tick，便于排查；不入队 jobs。"
            >
              暂停自动维护
            </Button>
          ) : (
            <Button
              icon={<Play size={16} />}
              onClick={() => {
                const next = { ...draft, enabled: true };
                setDraft(next);
                setDirty(false);
                props.onSaveSpec(next);
              }}
              title="恢复自动维护。下一次调和周期立即生效。"
            >
              恢复自动维护
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Zap size={16} />}
            loading={props.triggering}
            disabled={props.canTrigger === false}
            onClick={props.onTriggerNow}
            title="立即触发一次完整调和：sense → diagnose → plan → gate（apply 模式还会入队 jobs）。"
          >
            立即调和一次
          </Button>
        </div>
      </Panel>

      <CollapsiblePanel
        title="codex-tool 连接"
        storageKey="account-fleet-codex-tool"
        defaultOpen={!codexConfigured}
        hint="codex-tool 二进制路径 + SkyMail + ChatGPT OAuth + 接码 provider。Spec 仅在 server 端保存，UI 不脱敏（私有部署）；生产建议改用 enc_secrets 字段加密。"
        actions={<Badge tone={codexConfigured ? "success" : "warning"}>{codexConfigured ? "已配置" : "待配置"}</Badge>}
      >
        <div className="form-grid">
          <TextInput
            label="二进制路径"
            value={draft.codexTool.binPath}
            onChange={(v) => patchCodexTool((c) => ({ ...c, binPath: v }))}
            placeholder="codex-tool"
            mono
          />
          <NumberInput
            label="login 超时（秒）"
            value={Math.round(draft.codexTool.timeouts.loginMs / 1000)}
            min={5}
            onChange={(v) => patchCodexTool((c) => ({ ...c, timeouts: { ...c.timeouts, loginMs: v * 1000 } }))}
          />
          <NumberInput
            label="register 超时（秒）"
            value={Math.round(draft.codexTool.timeouts.registerMs / 1000)}
            min={5}
            onChange={(v) =>
              patchCodexTool((c) => ({ ...c, timeouts: { ...c.timeouts, registerMs: v * 1000 } }))
            }
          />
        </div>
        <div className="config-subgroup-label">SkyMail（邮箱 OTP）</div>
        <div className="form-grid">
          <TextInput
            label="base URL"
            value={draft.codexTool.skymail.baseUrl}
            onChange={(v) => patchCodexTool((c) => ({ ...c, skymail: { ...c.skymail, baseUrl: v } }))}
            placeholder="https://mail.example.com"
            mono
          />
          <TextInput
            label="管理员邮箱"
            value={draft.codexTool.skymail.adminEmail}
            onChange={(v) => patchCodexTool((c) => ({ ...c, skymail: { ...c.skymail, adminEmail: v } }))}
            placeholder="admin@example.com"
            mono
          />
          <TextInput
            label="管理员密码"
            value={draft.codexTool.skymail.adminPasswordRef}
            onChange={(v) =>
              patchCodexTool((c) => ({ ...c, skymail: { ...c.skymail, adminPasswordRef: v } }))
            }
            type="password"
            mono
          />
        </div>
        <div className="config-subgroup-label">ChatGPT OAuth</div>
        <div className="form-grid">
          <TextInput
            label="mail domain"
            value={draft.codexTool.chatgpt.mailDomain}
            onChange={(v) => patchCodexTool((c) => ({ ...c, chatgpt: { ...c.chatgpt, mailDomain: v } }))}
            placeholder="example.com"
            mono
          />
          <TextInput
            label="chat web client_id"
            value={draft.codexTool.chatgpt.chatWebClientId}
            onChange={(v) =>
              patchCodexTool((c) => ({ ...c, chatgpt: { ...c.chatgpt, chatWebClientId: v } }))
            }
            placeholder="app_xxx"
            mono
          />
          <TextInput
            label="codex client_id"
            value={draft.codexTool.chatgpt.codexClientId}
            onChange={(v) =>
              patchCodexTool((c) => ({ ...c, chatgpt: { ...c.chatgpt, codexClientId: v } }))
            }
            placeholder="app_xxx"
            mono
          />
        </div>
        <div className="config-subgroup-label">接码平台</div>
        <div className="form-grid">
          <SelectInput
            label="provider"
            value={draft.codexTool.phoneSms.provider}
            onChange={(v) =>
              patchCodexTool((c) => ({
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
            value={draft.codexTool.phoneSms.apiKeyRef}
            onChange={(v) =>
              patchCodexTool((c) => ({ ...c, phoneSms: { ...c.phoneSms, apiKeyRef: v } }))
            }
            type="password"
            mono
          />
          <TextInput
            label="service code"
            value={draft.codexTool.phoneSms.service}
            onChange={(v) =>
              patchCodexTool((c) => ({ ...c, phoneSms: { ...c.phoneSms, service: v } }))
            }
            placeholder="dr"
            mono
          />
        </div>
        <div className="config-subgroup-label">出口代理（codex-tool 走的本地节点）</div>
        <div className="form-grid">
          <SelectInput
            label="模式"
            value={draft.codexTool.egress.mode}
            onChange={(v) =>
              patchCodexTool((c) => ({
                ...c,
                egress: {
                  ...c.egress,
                  mode: v as AccountFleetSpec["codexTool"]["egress"]["mode"]
                }
              }))
            }
            options={[
              { label: "managed-node（按质量+负载加权随机）", value: "managed-node" },
              { label: "pinned-node（钉死一个节点）", value: "pinned-node" },
              { label: "none（不走本地代理直连）", value: "none" }
            ]}
          />
          {draft.codexTool.egress.mode === "pinned-node" ? (
            <TextInput
              label="节点 hash"
              value={draft.codexTool.egress.pinnedNodeHash ?? ""}
              onChange={(v) =>
                patchCodexTool((c) => ({
                  ...c,
                  egress: { ...c.egress, pinnedNodeHash: v.trim() || null }
                }))
              }
              placeholder="本地节点 hash 前缀（节点池里看）"
              mono
            />
          ) : null}
        </div>
      </CollapsiblePanel>

      <Panel
        title="目标产能"
        hint="目标账号数 = 用户期望维持的健康账号数；target_group_id 是 Sub2API 端创建账号时绑的组（OpenAI=2 / Gemini=3 / default=1）。"
      >
        <div className="form-grid">
          <NumberInput
            label="目标健康账号数"
            value={draft.target.healthyAccountsTarget}
            min={0}
            onChange={(v) => patchTarget((c) => ({ ...c, healthyAccountsTarget: v }))}
          />
          <NumberInput
            label="target group_id"
            value={draft.target.targetGroupId}
            min={1}
            onChange={(v) => patchTarget((c) => ({ ...c, targetGroupId: v }))}
          />
          <NumberInput
            label="默认代理 proxy_id"
            value={draft.target.defaultProxyId}
            min={1}
            onChange={(v) => patchTarget((c) => ({ ...c, defaultProxyId: v }))}
          />
          <NumberInput
            label="最低健康比 (0–1)"
            value={Number(draft.target.minHealthyRatio.toFixed(2))}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => patchTarget((c) => ({ ...c, minHealthyRatio: v }))}
          />
        </div>
        <div className="form-grid">
          <TextInput
            label="账号命名模板"
            value={draft.target.naming.template}
            onChange={(v) => patchTarget((c) => ({ ...c, naming: { ...c.naming, template: v } }))}
            placeholder="Hive-{date}-{seq}"
            mono
          />
        </div>
      </Panel>

      <CollapsiblePanel
        title="健康判定"
        storageKey="account-fleet-health"
        hint="多源信号融合：credentials_status + 配额 + 上游错误。adopted_active 连续 N tick broken 才降级为 observing，避免单点抖动误判。"
      >
        <div className="checkbox-stack">
          <Checkbox
            checked={draft.health.refreshTokenMissingAsUnhealthy}
            onChange={(v) => patchHealth((c) => ({ ...c, refreshTokenMissingAsUnhealthy: v }))}
            label="refresh_token 缺失 = 不健康"
          />
          <Checkbox
            checked={draft.health.rateLimitedAsUnhealthy}
            onChange={(v) => patchHealth((c) => ({ ...c, rateLimitedAsUnhealthy: v }))}
            label="rate_limit 视为不健康（默认关）"
          />
        </div>
        <div className="form-grid">
          <NumberInput
            label="配额阈值 (%)"
            value={draft.health.quotaExhaustedThresholdPercent}
            min={0}
            max={100}
            onChange={(v) => patchHealth((c) => ({ ...c, quotaExhaustedThresholdPercent: v }))}
          />
          <NumberInput
            label="配额轮询间隔（分钟）"
            value={Math.round(draft.health.usagePollIntervalMs / 60_000)}
            min={1}
            onChange={(v) => patchHealth((c) => ({ ...c, usagePollIntervalMs: v * 60_000 }))}
          />
          <NumberInput
            label="错误预算（条/窗口）"
            value={draft.health.errorBudgetPerWindow}
            min={1}
            onChange={(v) => patchHealth((c) => ({ ...c, errorBudgetPerWindow: v }))}
          />
          <NumberInput
            label="窗口长度（分钟）"
            value={Math.round(draft.health.windowMs / 60_000)}
            min={1}
            onChange={(v) => patchHealth((c) => ({ ...c, windowMs: v * 60_000 }))}
          />
          <NumberInput
            label="adopted 降级阈值（tick）"
            value={draft.health.adoptedDemotionConsecutiveTicks}
            min={1}
            onChange={(v) => patchHealth((c) => ({ ...c, adoptedDemotionConsecutiveTicks: v }))}
          />
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="修复策略"
        storageKey="account-fleet-recovery"
        defaultOpen
        hint="PATH_A (codex_login，邮箱 OTP 免费 ~30s) 优先；账号无 phone+password 时降级 PATH_B (codex_register 接码收费)。Sentinel 浏览器资源限制建议 maxConcurrent ≤ 3。"
      >
        <div className="checkbox-stack">
          <Checkbox
            checked={draft.recovery.enabled}
            onChange={(v) => patchRecovery((c) => ({ ...c, enabled: v }))}
            label="启用自动修复"
          />
          <Checkbox
            checked={draft.recovery.deleteOldAccountOnRecovery}
            onChange={(v) => patchRecovery((c) => ({ ...c, deleteOldAccountOnRecovery: v }))}
            label="修复成功后删除旧 Sub2API 记录"
          />
        </div>
        <div className="form-grid">
          <NumberInput
            label="最大并发修复数"
            value={draft.recovery.maxConcurrent}
            min={1}
            max={10}
            onChange={(v) => patchRecovery((c) => ({ ...c, maxConcurrent: v }))}
          />
          <NumberInput
            label="单 tick 修复上限"
            value={draft.recovery.perTickRecoveryCap}
            min={0}
            onChange={(v) => patchRecovery((c) => ({ ...c, perTickRecoveryCap: v }))}
          />
          <NumberInput
            label="单账号最大尝试次数"
            value={draft.recovery.maxAttemptsPerAccount}
            min={1}
            onChange={(v) => patchRecovery((c) => ({ ...c, maxAttemptsPerAccount: v }))}
          />
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="出生策略（接码收费）"
        storageKey="account-fleet-registration"
        defaultOpen
        hint="唯一收费路径。三级预算 perTick / daily / monthly 任一耗尽即停。紧急补给 = healthy/target < minHealthyRatio 时自动提升 perTickCap。"
      >
        <div className="checkbox-stack">
          <Checkbox
            checked={draft.registration.enabled}
            onChange={(v) => patchRegistration((c) => ({ ...c, enabled: v }))}
            label="启用自动注册"
          />
        </div>
        <div className="form-grid">
          <NumberInput
            label="单 tick 注册上限"
            value={draft.registration.perTickCap}
            min={0}
            onChange={(v) => patchRegistration((c) => ({ ...c, perTickCap: v }))}
          />
          <NumberInput
            label="日预算"
            value={draft.registration.dailyBudget}
            min={0}
            onChange={(v) => patchRegistration((c) => ({ ...c, dailyBudget: v }))}
          />
          <NumberInput
            label="月预算"
            value={draft.registration.monthlyBudget}
            min={0}
            onChange={(v) => patchRegistration((c) => ({ ...c, monthlyBudget: v }))}
          />
          <TextInput
            label="主接码地区 ID"
            value={draft.registration.smsCountry}
            onChange={(v) => patchRegistration((c) => ({ ...c, smsCountry: v }))}
            placeholder="6"
            mono
          />
        </div>
        <div className="config-subgroup-label">紧急补给（健康数跌破比例时启用）</div>
        <div className="checkbox-stack">
          <Checkbox
            checked={draft.registration.emergencyMode.enabled}
            onChange={(v) =>
              patchRegistration((c) => ({
                ...c,
                emergencyMode: { ...c.emergencyMode, enabled: v }
              }))
            }
            label="启用紧急补给（自动提升 perTickCap）"
          />
          <Checkbox
            checked={draft.registration.emergencyMode.ignoreDailyBudget}
            onChange={(v) =>
              patchRegistration((c) => ({
                ...c,
                emergencyMode: { ...c.emergencyMode, ignoreDailyBudget: v }
              }))
            }
            label="紧急模式忽略日预算（仍受月预算）"
          />
        </div>
        <div className="form-grid">
          <NumberInput
            label="紧急 perTickCap"
            value={draft.registration.emergencyMode.perTickCap}
            min={0}
            onChange={(v) =>
              patchRegistration((c) => ({
                ...c,
                emergencyMode: { ...c.emergencyMode, perTickCap: v }
              }))
            }
          />
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="退役策略"
        storageKey="account-fleet-retirement"
        hint="累计修复失败 N 次 / 长期无流量 N 天 → 自动退役。默认仅 schedulable=false，不删除 Sub2API 记录。"
      >
        <div className="checkbox-stack">
          <Checkbox
            checked={draft.retirement.afterMaxFailedRecoveries}
            onChange={(v) => patchRetirement((c) => ({ ...c, afterMaxFailedRecoveries: v }))}
            label="累计失败次数达上限后退役"
          />
          <Checkbox
            checked={draft.retirement.deleteOnRetire}
            onChange={(v) => patchRetirement((c) => ({ ...c, deleteOnRetire: v }))}
            label="退役时同时删除 Sub2API 记录（不可逆）"
          />
        </div>
        <div className="form-grid">
          <NumberInput
            label="无流量退役阈值（天）"
            value={draft.retirement.afterDeadDays}
            min={1}
            onChange={(v) => patchRetirement((c) => ({ ...c, afterDeadDays: v }))}
          />
          <NumberInput
            label="退役前隔离（分钟）"
            value={Math.round(draft.retirement.drainBeforeDeleteMs / 60_000)}
            min={0}
            onChange={(v) => patchRetirement((c) => ({ ...c, drainBeforeDeleteMs: v * 60_000 }))}
          />
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="灰度阀"
        storageKey="account-fleet-grace"
        hint="单次调和最多影响 min(账号总数×百分比, 绝对值) 个变更。策略 bug 时防止一次性炸全集群。"
      >
        <div className="form-grid">
          <NumberInput
            label="灰度百分比 (%)"
            value={draft.graceBatchPercent}
            min={0}
            max={100}
            onChange={(v) => patch("graceBatchPercent", v)}
          />
          <NumberInput
            label="灰度绝对上限"
            value={draft.graceBatchAbs}
            min={0}
            onChange={(v) => patch("graceBatchAbs", v)}
          />
          <NumberInput
            label="调和周期（分钟）"
            value={Math.round(draft.reconcileIntervalMs / 60_000)}
            min={1}
            onChange={(v) => patch("reconcileIntervalMs", v * 60_000)}
          />
        </div>
      </CollapsiblePanel>

      <div className="spec-save-bar">
        <Button
          icon={dirty ? <Wand2 size={16} /> : <Save size={16} />}
          loading={props.saving}
          disabled={!dirty}
          onClick={() => {
            props.onSaveSpec(draft);
            setDirty(false);
          }}
        >
          {dirty ? "保存策略并立即调和" : "策略已是最新"}
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(props.spec);
              setDirty(false);
            }}
          >
            放弃改动
          </Button>
        ) : null}
        {!dirty ? (
          <span className="muted small">
            <Activity size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
            {props.spec.recovery.enabled ? "PATH_A → PATH_B" : "修复关闭"} ·{" "}
            {props.spec.registration.enabled
              ? `预算 ${props.spec.registration.dailyBudget}/日`
              : "出生关闭"}
          </span>
        ) : null}
      </div>
    </aside>
  );
}

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
