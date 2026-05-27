import React from "react";
import { Activity, Link2, RefreshCw, Save, ShieldCheck, Trash2, Unlink, UploadCloud, Wand2 } from "lucide-react";
import type {
  Sub2ApiAccountFilters,
  Sub2ApiAssignmentPreview,
  Sub2ApiMaintenancePreview,
  Sub2ApiProtectedProxyRule,
  Sub2ApiProxyRecord,
  Sub2ApiSafeConnectionConfig
} from "@mihomo-hive/schemas";
import { Badge, Button, Checkbox, EmptyState, Panel, SelectInput, TextInput } from "../../components/ui.js";

export function ConnectionSection(props: {
  config: Sub2ApiSafeConnectionConfig | undefined;
  baseUrl: string;
  apiKey: string;
  timezone: string;
  managedPrefix: string;
  saving: boolean;
  testing: boolean;
  setBaseUrl: (v: string) => void;
  setApiKey: (v: string) => void;
  setTimezone: (v: string) => void;
  setManagedPrefix: (v: string) => void;
  onSave: () => void;
  onTest: () => void;
}) {
  const configured = Boolean(props.config?.configured);
  return (
    <Panel
      title="连接配置"
      actions={<Badge tone={configured ? "success" : "warning"}>{configured ? "已连接" : "待配置"}</Badge>}
    >
      <div className="sub2api-fields">
        <TextInput
          label="Sub2API 地址"
          value={props.baseUrl}
          onChange={props.setBaseUrl}
          placeholder="https://sub2api.example.com"
          mono
        />
        <TextInput
          label={props.config?.apiKeyConfigured && !props.apiKey ? "管理员 API Key（已保存，留空不变）" : "管理员 API Key"}
          value={props.apiKey}
          onChange={props.setApiKey}
          placeholder="x-api-key"
          type="password"
          mono
        />
        <TextInput label="时区" value={props.timezone} onChange={props.setTimezone} placeholder="Asia/Shanghai" mono />
        <TextInput
          label="Hive 托管代理前缀"
          value={props.managedPrefix}
          onChange={props.setManagedPrefix}
          placeholder="MH-"
          mono
        />
      </div>
      <p className="muted small">
        托管前缀用于识别由 Hive 推送到 Sub2API 的代理。所有 drain / cleanup / quality-check 操作只会作用于带这个前缀的代理。
      </p>
      <div className="button-row wrap">
        <Button
          icon={<Save size={16} />}
          loading={props.saving}
          disabled={!props.baseUrl || (!props.apiKey && !props.config?.apiKeyConfigured)}
          onClick={props.onSave}
          title="把上方填写的连接信息（含 API Key）保存到服务端数据库。下次启动会读取这些配置，无需重新输入。"
        >
          保存配置
        </Button>
        <Button
          variant="secondary"
          icon={<Link2 size={16} />}
          loading={props.testing}
          disabled={!configured}
          onClick={props.onTest}
          title="向 Sub2API 发一次试探请求，验证 baseUrl + adminApiKey 可用，并回报代理与账号总数。"
        >
          测试连接
        </Button>
      </div>
    </Panel>
  );
}

export function AccountScopeSection(props: {
  filters: Sub2ApiAccountFilters;
  overwriteExisting: boolean;
  applying: boolean;
  canApply: boolean;
  setFilters: (next: Sub2ApiAccountFilters) => void;
  setOverwriteExisting: (next: boolean) => void;
  onApply: () => void;
}) {
  const setFilter = (key: keyof Sub2ApiAccountFilters, value: string) => {
    props.setFilters({ ...props.filters, [key]: value });
  };
  return (
    <Panel title="账号范围与绑定策略">
      <div className="sub2api-filter-grid">
        <SelectInput
          label="账号状态"
          value={props.filters.status}
          onChange={(value) => setFilter("status", value)}
          options={[
            { label: "active", value: "active" },
            { label: "全部", value: "" }
          ]}
        />
        <TextInput label="平台" value={props.filters.platform} onChange={(value) => setFilter("platform", value)} placeholder="openai" />
        <TextInput label="类型" value={props.filters.type} onChange={(value) => setFilter("type", value)} placeholder="oauth" />
        <TextInput label="分组" value={props.filters.group} onChange={(value) => setFilter("group", value)} placeholder="OpenAI" />
        <TextInput label="搜索" value={props.filters.search} onChange={(value) => setFilter("search", value)} placeholder="账号名/邮箱" />
      </div>
      <Checkbox checked={props.overwriteExisting} onChange={props.setOverwriteExisting} label="覆盖现有非保护代理绑定" />
      <p className="muted small">
        系统默认只调整未绑定 / 绑定到失效代理的账号。勾选"覆盖"后已绑定到可用代理的账号也会重新分配。
        受保护账号在任何情况下都不会被修改。变更前服务端会重新读取 live 数据。
      </p>
      <div className="button-row">
        <Button
          icon={<Wand2 size={16} />}
          loading={props.applying}
          disabled={!props.canApply}
          onClick={props.onApply}
          title="按 hash(account.id) 稳定选择目标代理，把账号批量绑定到可分配代理（保护代理不参与分配，受保护账号不被修改）。服务端会重读 live 数据后再执行，不依赖前端预览。"
        >
          应用自动绑定
        </Button>
      </div>
    </Panel>
  );
}

export function ProtectionSection(props: {
  proxies: Sub2ApiProxyRecord[];
  protectedRule: Sub2ApiProtectedProxyRule;
  setProtectedRule: (rule: Sub2ApiProtectedProxyRule) => void;
}) {
  const protectedIds = new Set(props.protectedRule.proxyIds);
  const [proxySearch, setProxySearch] = React.useState("");
  const filteredProxies = React.useMemo(() => {
    const query = proxySearch.trim().toLowerCase();
    if (!query) return props.proxies;
    return props.proxies.filter((proxy) => {
      const haystack = `${proxy.name} ${proxy.host} ${proxy.port} ${proxy.country ?? ""} ${proxy.region ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [props.proxies, proxySearch]);
  const visibleProxies = filteredProxies.slice(0, 120);
  const activeProxies = props.proxies.filter((proxy) => proxy.status === "active").length;
  const protectedProxies = props.proxies.filter((proxy) => isProtectedProxy(proxy, props.protectedRule));

  function setProtectedField(key: keyof Sub2ApiProtectedProxyRule, value: string) {
    props.setProtectedRule({
      ...props.protectedRule,
      [key]: key === "port" ? parseOptionalPort(value) : value
    });
  }
  function toggleProtectedProxy(proxyId: number, checked: boolean) {
    const next = new Set(props.protectedRule.proxyIds);
    if (checked) next.add(proxyId);
    else next.delete(proxyId);
    props.setProtectedRule({ ...props.protectedRule, proxyIds: Array.from(next).sort((a, b) => a - b) });
  }

  return (
    <Panel
      title="保护节点规则"
      actions={<ShieldCheck size={16} className="muted" />}
    >
      <p className="muted small">
        命中保护规则的代理在自动化里被双向锁定：
        <strong>① 不会被自动化分配新账号</strong>（自动化绑定时从可分配代理池里排除）；
        <strong>② 当前已绑定到保护代理的账号也不会被迁走</strong>（被识别为"受保护账号"，跳过排空、调度、应用绑定等操作）。
        所以保护规则用来圈定"由人工维护、不交给系统接管的代理及其账号范围"。
      </p>
      <div className="sub2api-filter-grid">
        <TextInput
          label="名称包含"
          value={props.protectedRule.nameIncludes}
          onChange={(value) => setProtectedField("nameIncludes", value)}
          placeholder="WRT / 手工"
        />
        <TextInput
          label="Host 包含"
          value={props.protectedRule.hostIncludes}
          onChange={(value) => setProtectedField("hostIncludes", value)}
          placeholder="192.168."
          mono
        />
        <TextInput
          label="端口"
          value={props.protectedRule.port ? String(props.protectedRule.port) : ""}
          onChange={(value) => setProtectedField("port", value)}
          placeholder="7893"
          mono
        />
        <TextInput
          label="国家包含"
          value={props.protectedRule.countryIncludes}
          onChange={(value) => setProtectedField("countryIncludes", value)}
          placeholder="日本"
        />
        <TextInput
          label="地区包含"
          value={props.protectedRule.regionIncludes}
          onChange={(value) => setProtectedField("regionIncludes", value)}
          placeholder="东京"
        />
        <TextInput
          label="状态"
          value={props.protectedRule.status}
          onChange={(value) => setProtectedField("status", value)}
          placeholder="active"
        />
      </div>
      <div className="sub2api-summary">
        <SmallMetric label="Sub2API 代理" value={props.proxies.length} />
        <SmallMetric label="active" value={activeProxies} />
        <SmallMetric label="保护节点" value={protectedProxies.length} />
      </div>
      <div className="proxy-pick-controls">
        <TextInput value={proxySearch} onChange={setProxySearch} placeholder="搜索名称/host/国家/地区" />
        <span className="muted small">
          显示 {visibleProxies.length} / 匹配 {filteredProxies.length} / 总 {props.proxies.length}
        </span>
      </div>
      <div className="proxy-pick-list">
        {props.proxies.length === 0 ? (
          <EmptyState title="还没有拉取代理" description="保存并测试连接后系统会自动拉取 Sub2API 中已有的代理列表。" />
        ) : filteredProxies.length === 0 ? (
          <EmptyState title="没有匹配的代理" description="清空搜索框或调整关键词。" />
        ) : (
          visibleProxies.map((proxy) => (
            <label key={proxy.id} className={`proxy-pick-item ${isProtectedProxy(proxy, props.protectedRule) ? "is-protected" : ""}`}>
              <input
                type="checkbox"
                checked={protectedIds.has(proxy.id)}
                onChange={(event) => toggleProtectedProxy(proxy.id, event.target.checked)}
              />
              <span>
                <strong>{proxy.name}</strong>
                <small>
                  #{proxy.id} {proxy.host}:{proxy.port} {proxy.country ?? ""} {proxy.status}
                  {typeof proxy.account_count === "number" && proxy.account_count > 0
                    ? ` · ${proxy.account_count} 账号`
                    : ""}
                </small>
              </span>
            </label>
          ))
        )}
        {filteredProxies.length > visibleProxies.length ? (
          <div className="muted small">还有 {filteredProxies.length - visibleProxies.length} 个未展示，请缩小搜索关键词。</div>
        ) : null}
      </div>
    </Panel>
  );
}

export function ManagedOpsSection(props: {
  configured: boolean;
  maintenance: Sub2ApiMaintenancePreview | undefined;
  syncing: boolean;
  pushing: boolean;
  checkingQuality: boolean;
  draining: boolean;
  cleaning: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onSync: () => void;
  onPush: () => void;
  onQualityCheck: () => void;
  onDrain: () => void;
  onCleanup: () => void;
}) {
  return (
    <Panel
      title="自动接管状态"
      actions={<Badge tone={(props.maintenance?.summary.managedProxies ?? 0) > 0 ? "success" : "neutral"}>
        {props.maintenance?.summary.managedProxies ?? 0} 个托管代理
      </Badge>}
    >
      <div className="sub2api-summary">
        <SmallMetric label="Hive 代理" value={props.maintenance?.summary.managedProxies ?? 0} />
        <SmallMetric label="关联账号" value={props.maintenance?.summary.managedAccounts ?? 0} />
        <SmallMetric label="可排空" value={props.maintenance?.summary.drainChanges ?? 0} />
        <SmallMetric label="可清理" value={props.maintenance?.summary.emptyManagedProxies ?? 0} />
      </div>
      <p className="muted small">
        系统通过代理名前缀识别 Hive 管理的代理。"推送本地节点"把本地 schedulable 节点上行到 Sub2API；"回填映射"只从 Sub2API 拉数据更新本地记录；"质量检查"对每个托管代理触发 quality-check 并回填本地 qualityScore。
      </p>
      {props.maintenance?.risks.length ? <div className="form-error">{props.maintenance.risks.join("；")}</div> : null}
      <div className="ops-buttons">
        <div className="ops-group">
          <span className="ops-group-label">上行 / 同步</span>
          <Button
            size="sm"
            icon={<UploadCloud size={14} />}
            loading={props.pushing}
            disabled={!props.configured}
            onClick={props.onPush}
            title="上行同步：把本地 schedulable + active 节点通过 Sub2API importProxyData 接口推到远端，代理名自动加托管前缀。Sub2API 按 proxy_key 去重，重复推送幂等。"
          >
            推送本地节点
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            loading={props.syncing}
            disabled={!props.configured}
            onClick={props.onSync}
            title="下行同步：从 Sub2API 拉取最新代理/账号，并把匹配到的 Sub2API proxy_id 写回本地节点。不会改远端任何数据。"
          >
            回填映射
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            loading={props.refreshing}
            disabled={!props.configured}
            onClick={props.onRefresh}
            title="重新拉取代理/账号/维护计划展示数据；不写入本地、不修改远端。"
          >
            刷新计划
          </Button>
        </div>
        <div className="ops-group">
          <span className="ops-group-label">维护</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={props.checkingQuality}
            disabled={!props.configured || !props.maintenance || props.maintenance.summary.managedProxies === 0}
            onClick={props.onQualityCheck}
            title="对每个 Hive 托管代理调用 Sub2API quality-check 接口，让 Sub2API 真实出站测一次，返回的分数回写本地节点 qualityScore（仅托管代理参与）。"
          >
            质量检查
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Unlink size={14} />}
            loading={props.draining}
            disabled={!props.configured || !props.maintenance || props.maintenance.summary.drainChanges === 0}
            onClick={props.onDrain}
            title="排空：把绑定到 Hive 托管代理的账号迁移到非保护非托管的 active 代理上（least-loaded 优先）；保护代理及其账号不动。常用于下线 Hive 代理前的腾挪。"
          >
            排空托管代理
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={14} />}
            loading={props.cleaning}
            disabled={!props.configured || !props.maintenance || props.maintenance.summary.emptyManagedProxies === 0}
            onClick={props.onCleanup}
            title="删除所有名称带托管前缀、且当前没有任何账号使用的 Sub2API 代理。只删空壳，不动有账号绑定的代理；保护代理不会被识别为托管代理。"
          >
            清理空代理
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export function AssignmentPreviewSection(props: { preview: Sub2ApiAssignmentPreview | undefined }) {
  const previewErrors = props.preview?.errors ?? [];
  return (
    <Panel title="绑定预览">
      <div className="sub2api-summary">
        <SmallMetric label="账号" value={props.preview?.summary.accounts ?? 0} />
        <SmallMetric label="将修改" value={props.preview?.summary.changedAccounts ?? 0} />
        <SmallMetric label="受保护" value={props.preview?.summary.protectedAccounts ?? 0} />
        <SmallMetric label="批次" value={props.preview?.summary.batches ?? 0} />
      </div>
      {previewErrors.length > 0 ? <div className="form-error">{previewErrors.join("；")}</div> : null}
      {props.preview?.changes.length ? (
        <div className="change-list">
          {props.preview.changes.slice(0, 8).map((change) => (
            <div key={change.accountId} className="change-item">
              <strong>{change.accountName}</strong>
              <span>
                {change.oldProxyName ?? "未绑定"} {"->"} {change.newProxyName}
              </span>
            </div>
          ))}
          {props.preview.changes.length > 8 ? <div className="muted small">还有 {props.preview.changes.length - 8} 个变更...</div> : null}
        </div>
      ) : (
        <EmptyState title="暂无待应用变更" description="调整账号筛选、保护规则或覆盖策略后会重新生成预览。" />
      )}
    </Panel>
  );
}

function SmallMetric(props: { label: string; value: number }) {
  return (
    <div className="small-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function parseOptionalPort(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const port = Number(trimmed);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

export function isProtectedProxy(proxy: Sub2ApiProxyRecord, rule: Sub2ApiProtectedProxyRule): boolean {
  if (rule.proxyIds.includes(proxy.id)) return true;
  return (
    includesText(proxy.name, rule.nameIncludes) ||
    includesText(proxy.host, rule.hostIncludes) ||
    (Boolean(rule.port) && proxy.port === rule.port) ||
    includesText(proxy.country ?? "", rule.countryIncludes) ||
    includesText(proxy.region ?? "", rule.regionIncludes) ||
    (rule.status.length > 0 && proxy.status === rule.status)
  );
}

function includesText(value: string, expected: string): boolean {
  return expected.length > 0 && value.toLowerCase().includes(expected.toLowerCase());
}
