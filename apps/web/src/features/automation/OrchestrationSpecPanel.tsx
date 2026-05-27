import React from "react";
import { Activity, Pause, Play, Save, Shield, Wand2, Zap } from "lucide-react";
import type {
  OrchestrationSpec,
  Sub2ApiProtectedProxyRule,
  Sub2ApiProxyRecord,
  Sub2ApiSafeConnectionConfig
} from "@mihomo-hive/schemas";
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  SelectInput,
  TextInput
} from "../../components/ui.js";

/**
 * Spec 编辑左栏：用户唯一编辑的对象。
 *
 * 拆三段：
 *   1) 自动协调开关 + 连接配置（连接是 spec 之外的 settings，但展示上一起）
 *   2) 核心策略（intake / 灰度阀 / 周期 / 容量 / 稳定性 / 故障）
 *   3) 保护规则
 *
 * 所有改动暂存在 local state；点"保存策略"才写回服务端。
 */
export function OrchestrationSpecPanel(props: {
  spec: OrchestrationSpec;
  connection: Sub2ApiSafeConnectionConfig | undefined;
  proxies: Sub2ApiProxyRecord[];
  saving: boolean;
  applying: boolean;
  testing: boolean;
  savingConnection: boolean;
  connectionDraft: ConnectionDraft;
  onConnectionDraftChange: (draft: ConnectionDraft) => void;
  onSaveConnection: () => void;
  onTestConnection: () => void;
  onSaveSpec: (next: OrchestrationSpec) => void;
  onApplyOnce: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const [draft, setDraft] = React.useState<OrchestrationSpec>(props.spec);
  const [dirty, setDirty] = React.useState(false);

  // 上游 spec 变了（保存后 trpc 重读）→ 同步 draft，除非用户正在编辑
  React.useEffect(() => {
    if (!dirty) setDraft(props.spec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(props.spec)]);

  function patch<K extends keyof OrchestrationSpec>(key: K, value: OrchestrationSpec[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  function patchNested<K extends "supply" | "capacity" | "stickiness" | "health" | "intake">(
    key: K,
    updater: (current: OrchestrationSpec[K]) => OrchestrationSpec[K]
  ) {
    setDraft((current) => ({ ...current, [key]: updater(current[key]) }));
    setDirty(true);
  }

  const intakeProxyOptions = React.useMemo(() => {
    return [
      { label: "（未配置入站代理）", value: "" },
      ...props.proxies
        .filter((p) => !p.name.startsWith(props.spec.protectedRule.nameIncludes || "@@no-match@@"))
        .map((p) => ({
          label: `#${p.id} ${p.name} (${p.host}:${p.port})`,
          value: String(p.id)
        }))
    ];
  }, [props.proxies, props.spec.protectedRule.nameIncludes]);

  const enabled = draft.enabled;
  const connected = Boolean(props.connection?.configured);

  return (
    <aside className="orchestration-spec-panel">
      <Panel
        title="自动协调"
        actions={<Badge tone={enabled ? "success" : "warning"}>{enabled ? "运行中" : "已暂停"}</Badge>}
      >
        <p className="muted small">
          系统按你指定的"应该是什么样"自动调节配置：自动同步代理、自动迁移账号、自动隔离故障节点。火警按下后只观测不执行，便于排查。
        </p>
        <div className="button-row wrap">
          {enabled ? (
            <Button
              variant="secondary"
              icon={<Pause size={16} />}
              onClick={props.onPause}
              title="火警开关：按下后不再修改 Sub2API 数据，但 reconcile 仍跑前 4 步（dry-run）写入审计日志，便于排查。"
            >
              暂停自动协调
            </Button>
          ) : (
            <Button
              icon={<Play size={16} />}
              onClick={props.onResume}
              title="恢复自动协调。下次 reconcile 周期立刻生效。"
            >
              恢复自动协调
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Zap size={16} />}
            loading={props.applying}
            disabled={!connected}
            onClick={props.onApplyOnce}
            title="立即触发一次完整 reconcile：拉远端 → 计算计划 → 灰度执行。等同于不等下一个周期。"
          >
            立即调和一次
          </Button>
        </div>
      </Panel>

      <Panel
        title="Sub2API 连接"
        actions={<Badge tone={connected ? "success" : "warning"}>{connected ? "已连接" : "待配置"}</Badge>}
      >
        <div className="sub2api-fields">
          <TextInput
            label="Sub2API 地址"
            value={props.connectionDraft.baseUrl}
            onChange={(v) => props.onConnectionDraftChange({ ...props.connectionDraft, baseUrl: v })}
            placeholder="https://sub2api.example.com"
            mono
          />
          <TextInput
            label={
              props.connection?.apiKeyConfigured && !props.connectionDraft.apiKey
                ? "管理员 API Key（已保存，留空不变）"
                : "管理员 API Key"
            }
            value={props.connectionDraft.apiKey}
            onChange={(v) => props.onConnectionDraftChange({ ...props.connectionDraft, apiKey: v })}
            placeholder="x-api-key"
            type="password"
            mono
          />
          <TextInput
            label="时区"
            value={props.connectionDraft.timezone}
            onChange={(v) => props.onConnectionDraftChange({ ...props.connectionDraft, timezone: v })}
            placeholder="Asia/Shanghai"
            mono
          />
          <TextInput
            label="Hive 托管代理前缀"
            value={props.connectionDraft.managedPrefix}
            onChange={(v) => props.onConnectionDraftChange({ ...props.connectionDraft, managedPrefix: v })}
            placeholder="MH-"
            mono
          />
        </div>
        <div className="button-row wrap">
          <Button
            icon={<Save size={16} />}
            loading={props.savingConnection}
            disabled={!props.connectionDraft.baseUrl || (!props.connectionDraft.apiKey && !props.connection?.apiKeyConfigured)}
            onClick={props.onSaveConnection}
          >
            保存连接
          </Button>
          <Button
            variant="secondary"
            icon={<Activity size={16} />}
            loading={props.testing}
            disabled={!connected}
            onClick={props.onTestConnection}
          >
            测试连接
          </Button>
        </div>
      </Panel>

      <Panel title="入站代理">
        <p className="muted small">
          新账号在 Sub2API 端创建时默认挂到这个代理上；系统每个 reconcile 周期会把它上面的账号引流到合适的 Hive 节点。建议选一个手动配置的兜底代理（不能是托管代理或保护代理）。
        </p>
        {props.proxies.length === 0 ? (
          <EmptyState title="未拉取 Sub2API 代理" description="保存 + 测试连接后系统会自动拉取代理列表，再来此处选择入站代理。" />
        ) : (
          <SelectInput
            label="入站代理"
            value={draft.intake.proxyId ? String(draft.intake.proxyId) : ""}
            onChange={(v) =>
              patchNested("intake", (c) => ({ ...c, proxyId: v ? Number(v) : null }))
            }
            options={intakeProxyOptions}
          />
        )}
      </Panel>

      <Panel title="节点供给">
        <div className="form-grid">
          <NumberInput
            label="订阅自动刷新周期 (分钟)"
            value={Math.round(draft.supply.fetchIntervalMs / 60_000)}
            min={5}
            onChange={(v) => patchNested("supply", (c) => ({ ...c, fetchIntervalMs: v * 60_000 }))}
          />
          <NumberInput
            label="退役等待 (天)"
            value={draft.supply.evictAfterDays}
            min={1}
            onChange={(v) => patchNested("supply", (c) => ({ ...c, evictAfterDays: v }))}
          />
          <NumberInput
            label="最大延迟 (ms，0=不限)"
            value={draft.supply.inPoolGate.maxLatencyMs ?? 0}
            min={0}
            onChange={(v) =>
              patchNested("supply", (c) => ({
                ...c,
                inPoolGate: { ...c.inPoolGate, ...(v > 0 ? { maxLatencyMs: v } : { maxLatencyMs: undefined }) }
              }))
            }
          />
        </div>
      </Panel>

      <Panel title="容量与再平衡">
        <p className="muted small">
          系统按"目标 = 总账号数 / 健康节点数"自动算每节点的目标负载。超过 overload 倍触发外迁；低于 underload 倍视为闲置（等填）。
        </p>
        <div className="form-grid">
          <SelectInput
            label="每节点目标账号数"
            value={draft.capacity.targetPerNode === "auto" ? "auto" : "manual"}
            onChange={(v) =>
              patchNested("capacity", (c) => ({
                ...c,
                targetPerNode: v === "auto" ? "auto" : typeof c.targetPerNode === "number" ? c.targetPerNode : 20
              }))
            }
            options={[
              { label: "自动（按健康节点数等分）", value: "auto" },
              { label: "手动指定", value: "manual" }
            ]}
          />
          {draft.capacity.targetPerNode !== "auto" ? (
            <NumberInput
              label="目标值"
              value={draft.capacity.targetPerNode}
              min={1}
              onChange={(v) => patchNested("capacity", (c) => ({ ...c, targetPerNode: v }))}
            />
          ) : null}
          <NumberInput
            label="过载阈值倍数"
            value={Number(draft.capacity.overloadRatio.toFixed(2))}
            step={0.1}
            min={1}
            onChange={(v) => patchNested("capacity", (c) => ({ ...c, overloadRatio: v }))}
          />
          <NumberInput
            label="欠载阈值倍数"
            value={Number(draft.capacity.underloadRatio.toFixed(2))}
            step={0.1}
            min={0}
            onChange={(v) => patchNested("capacity", (c) => ({ ...c, underloadRatio: v }))}
          />
          <NumberInput
            label="单节点账号硬上限"
            value={draft.capacity.hardMaxPerNode}
            min={1}
            onChange={(v) => patchNested("capacity", (c) => ({ ...c, hardMaxPerNode: v }))}
          />
        </div>
      </Panel>

      <Panel title="灰度与稳定性">
        <p className="muted small">
          灰度阀给"系统判错"留缓冲：单次 reconcile 最多影响 min(账号总数×百分比, 绝对值) 个。
          稳定哈希策略决定节点集合变化时账号会漂移多少；Rendezvous Hashing 只让原节点已下线的账号漂移（≈ 1/N），稳定哈希则会触发大规模重排。切换策略会引起一次性大漂移，建议低峰期执行。
        </p>
        <div className="form-grid">
          <SelectInput
            label="哈希策略"
            value={draft.stickiness.strategy}
            onChange={(v) => patchNested("stickiness", (c) => ({ ...c, strategy: v as "stable-hash" | "rendezvous-hash" }))}
            options={[
              { label: "稳定哈希 (sha256 % N，默认)", value: "stable-hash" },
              { label: "Rendezvous Hashing (HRW)", value: "rendezvous-hash" }
            ]}
          />
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
            label="单 tick 迁移上限"
            value={draft.stickiness.perTickMigrationCap}
            min={0}
            onChange={(v) => patchNested("stickiness", (c) => ({ ...c, perTickMigrationCap: v }))}
          />
          <NumberInput
            label="Reconcile 周期 (秒)"
            value={Math.round(draft.reconcileIntervalMs / 1000)}
            min={5}
            onChange={(v) => patch("reconcileIntervalMs", v * 1000)}
          />
        </div>
      </Panel>

      <Panel title="故障自愈">
        <p className="muted small">
          仅依赖 Sub2API 的 upstream-errors 信号。窗口内错误条数超过预算 → 进入退避（账号留在原地）；连续 N 次失败 → 永久驱逐。
          上游接口只返回错误条目（没有"总请求数"），所以阈值是绝对错误数而不是百分比。
        </p>
        <div className="form-grid">
          <NumberInput
            label="错误预算 (条/窗口)"
            value={draft.health.errorBudgetPerWindow}
            min={1}
            onChange={(v) => patchNested("health", (c) => ({ ...c, errorBudgetPerWindow: v }))}
          />
          <NumberInput
            label="窗口长度 (分钟)"
            value={Math.round(draft.health.windowMs / 60_000)}
            min={1}
            onChange={(v) => patchNested("health", (c) => ({ ...c, windowMs: v * 60_000 }))}
          />
          <NumberInput
            label="连续失败几次后永久驱逐"
            value={draft.health.evictAfterBackoffs}
            min={1}
            onChange={(v) => patchNested("health", (c) => ({ ...c, evictAfterBackoffs: v }))}
          />
        </div>
      </Panel>

      <Panel title="保护代理规则" actions={<Shield size={16} className="muted" />}>
        <p className="muted small">
          命中保护规则的代理被双向锁定：① 不会被自动化分配新账号 ② 当前已绑定到保护代理的账号也不会被迁走。用于"由人工维护、不交给系统接管"的代理范围。
        </p>
        <div className="form-grid">
          <TextInput
            label="名称包含"
            value={draft.protectedRule.nameIncludes}
            onChange={(v) => patchProtected("nameIncludes", v)}
            placeholder="WRT / 手工"
          />
          <TextInput
            label="Host 包含"
            value={draft.protectedRule.hostIncludes}
            onChange={(v) => patchProtected("hostIncludes", v)}
            placeholder="192.168."
            mono
          />
          <TextInput
            label="国家包含"
            value={draft.protectedRule.countryIncludes}
            onChange={(v) => patchProtected("countryIncludes", v)}
            placeholder="日本"
          />
          <TextInput
            label="地区包含"
            value={draft.protectedRule.regionIncludes}
            onChange={(v) => patchProtected("regionIncludes", v)}
            placeholder="东京"
          />
        </div>
      </Panel>

      <div className="spec-save-bar">
        <Button
          icon={<Wand2 size={16} />}
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
      </div>
    </aside>
  );

  function patchProtected(key: keyof Sub2ApiProtectedProxyRule, value: string) {
    setDraft((current) => ({
      ...current,
      protectedRule: { ...current.protectedRule, [key]: value }
    }));
    setDirty(true);
  }
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

export interface ConnectionDraft {
  baseUrl: string;
  apiKey: string;
  timezone: string;
  managedPrefix: string;
}
