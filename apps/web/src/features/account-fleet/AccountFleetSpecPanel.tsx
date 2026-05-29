import React from "react";
import { Activity, Save, Wand2, X } from "lucide-react";
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

/** codex-tool 连通测试结果（P5-AF）。null = 未测过 */
export type CodexToolTestResult =
  | { ok: true; provider: string; service: string; countriesSampled: number; totalCountries: number }
  | { ok: false; error: string };

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
  onSaveSpec: (next: AccountFleetSpec) => void;
  onTriggerNow: () => void;
  /** P6-03：作为可收起的策略列时，提供收起回调。 */
  onClose?: () => void;
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
  // P5-AK: codexTool 子树编辑已下沉到系统页 features/system/CodexToolConnectionPanel.tsx

  const enabled = draft.enabled;
  // codex-tool 配置是否完整（用于"自动维护可以开吗"的提示）
  const codexConfigured = Boolean(
    draft.codexTool.binPath &&
      draft.codexTool.skymail.baseUrl &&
      draft.codexTool.skymail.adminEmail &&
      draft.codexTool.chatgpt.codexClientId &&
      draft.codexTool.phoneSms.apiKeyRef
  );

  return (
    <aside className="orchestration-spec-panel fleet-spec-drawer">
      <div className="fleet-spec-header">
        <h2>维护策略</h2>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "运行中" : "已暂停"}</Badge>
          {props.onClose ? (
            <Button variant="ghost" size="sm" icon={<X size={15} />} onClick={props.onClose} title="收起策略">
              收起
            </Button>
          ) : null}
        </div>
      </div>
      <p className="muted small" style={{ margin: "0 0 4px" }}>
        开启/暂停自动维护与「立即巡检」在页面顶部操作条；这里调具体策略。注册、修复可各自单独开关。
      </p>

      {/* P5-AK: codex-tool 连接已搬到「系统」tab。账号编排页只保留策略 + 账号矩阵。 */}
      {!codexConfigured ? (
        <Panel
          title="codex-tool 连接"
          actions={<Badge tone="warning">待配置</Badge>}
          hint="账号编排依赖 codex-tool —— 请到「系统」tab 配置 binPath + SkyMail + ChatGPT OAuth + 接码 provider 并测试连通。"
        >
          <p className="muted small" style={{ margin: 0 }}>
            未配置 codex-tool 连接，自动维护无法触发 codex_login / codex_register。
          </p>
        </Panel>
      ) : null}

      <Panel
        title="目标产能"
        hint="目标账号数 = 用户期望维持的健康账号数。新账号的 Sub2API proxy_id 由系统自动推导：codex-tool 走哪个本地节点 → 该节点对应的 Sub2API 代理 → 用作账号 binding；节点池里的代理就是出生地，不需要在这里硬编码。"
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
            label="最低健康比 (0–1)"
            value={Number(draft.target.minHealthyRatio.toFixed(2))}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => patchTarget((c) => ({ ...c, minHealthyRatio: v }))}
          />
        </div>
        <div className="form-field" style={{ marginTop: 8 }}>
          <label className="form-label">
            补充策略均衡度：{draft.target.registerBias <= 15
              ? "重登旧账号优先"
              : draft.target.registerBias >= 85
                ? "注册新账号优先"
                : `重登 ${100 - draft.target.registerBias}% / 注册 ${draft.target.registerBias}%`}
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="muted small">重登旧账号</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={draft.target.registerBias}
              onChange={(e) => patchTarget((c) => ({ ...c, registerBias: Number(e.target.value) }))}
              style={{ flex: 1 }}
            />
            <span className="muted small">注册新账号</span>
            <span className="mono-strong" style={{ width: 40, textAlign: "right" }}>{draft.target.registerBias}</span>
          </div>
          <div className="muted small" style={{ marginTop: 4 }}>
            健康账号不足时，缺口里有多大比例用"注册新号"补满，其余留给"重登掉线旧号"恢复。
            掉线账号始终会照常尝试重登；此项只调注册新号的积极程度（紧急模式下忽略，全力补给）。
            注册需先开启「注册」开关。
          </div>
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
          <NumberInput
            label="单账号成本上限 (USD)"
            value={Number(draft.registration.maxCostPerAccountUsd.toFixed(3))}
            min={0}
            step={0.01}
            onChange={(v) => patchRegistration((c) => ({ ...c, maxCostPerAccountUsd: v }))}
          />
        </div>
        <div className="muted small" style={{ marginTop: 4 }}>
          注册地区由 codex-tool 按"成本上限"自行选择 —— 它会按价格升序筛地区，跳过超过上限的，
          跳过库存为 0 的。默认 0.05 USD/账号，超过此价格的地区不会消耗你的余额。
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

function truncateError(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
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
