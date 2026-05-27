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

export function Sub2ApiPanel(props: {
  config: Sub2ApiSafeConnectionConfig | undefined;
  baseUrl: string;
  apiKey: string;
  timezone: string;
  managedProxyPrefix: string;
  filters: Sub2ApiAccountFilters;
  protectedRule: Sub2ApiProtectedProxyRule;
  proxies: Sub2ApiProxyRecord[];
  preview: Sub2ApiAssignmentPreview | undefined;
  maintenance: Sub2ApiMaintenancePreview | undefined;
  loading: boolean;
  saving: boolean;
  testing: boolean;
  applying: boolean;
  syncing: boolean;
  pushing: boolean;
  checkingQuality: boolean;
  draining: boolean;
  cleaning: boolean;
  overwriteExisting: boolean;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onTimezoneChange: (value: string) => void;
  onManagedProxyPrefixChange: (value: string) => void;
  onFiltersChange: (value: Sub2ApiAccountFilters) => void;
  onProtectedRuleChange: (value: Sub2ApiProtectedProxyRule) => void;
  onOverwriteExistingChange: (value: boolean) => void;
  onSaveConfig: () => void;
  onTest: () => void;
  onSync: () => void;
  onRefresh: () => void;
  onApply: () => void;
  onDrainManaged: () => void;
  onCleanupEmpty: () => void;
  onPushManaged: () => void;
  onQualityCheck: () => void;
}) {
  const configured = Boolean(props.config?.configured);
  const protectedIds = new Set(props.protectedRule.proxyIds);
  const activeProxies = props.proxies.filter((proxy) => proxy.status === "active").length;
  const protectedProxies = props.proxies.filter((proxy) => isProtectedProxy(proxy, props.protectedRule));
  const previewErrors = props.preview?.errors ?? [];
  const canApply = configured && props.preview && props.preview.summary.changedAccounts > 0 && previewErrors.length === 0;
  const [proxySearch, setProxySearch] = React.useState("");
  const filteredProxies = React.useMemo(() => {
    const query = proxySearch.trim().toLowerCase();
    if (!query) {
      return props.proxies;
    }
    return props.proxies.filter((proxy) => {
      const haystack = `${proxy.name} ${proxy.host} ${proxy.port} ${proxy.country ?? ""} ${proxy.region ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [props.proxies, proxySearch]);
  const visibleProxies = filteredProxies.slice(0, 120);

  function setFilter(key: keyof Sub2ApiAccountFilters, value: string) {
    props.onFiltersChange({ ...props.filters, [key]: value });
  }

  function toggleProtectedProxy(proxyId: number, checked: boolean) {
    const next = new Set(props.protectedRule.proxyIds);
    if (checked) {
      next.add(proxyId);
    } else {
      next.delete(proxyId);
    }
    props.onProtectedRuleChange({ ...props.protectedRule, proxyIds: Array.from(next).sort((a, b) => a - b) });
  }

  function setProtectedRule(key: keyof Sub2ApiProtectedProxyRule, value: string) {
    props.onProtectedRuleChange({
      ...props.protectedRule,
      [key]: key === "port" ? parseOptionalPort(value) : value
    });
  }

  return (
    <Panel
      title="Sub2API 自动化"
      actions={<Badge tone={configured ? "success" : "warning"}>{configured ? "已连接配置" : "待配置"}</Badge>}
    >
      <div className="sub2api-stack">
        <section className="sub2api-section">
          <div className="section-title">
            <Link2 size={16} />
            <strong>连接配置</strong>
          </div>
          <div className="sub2api-fields">
            <TextInput label="Sub2API 地址" value={props.baseUrl} onChange={props.onBaseUrlChange} placeholder="https://sub2api.example.com" mono />
            <TextInput
              label={props.config?.apiKeyConfigured && !props.apiKey ? "管理员 API Key（已保存，留空不变）" : "管理员 API Key"}
              value={props.apiKey}
              onChange={props.onApiKeyChange}
              placeholder="x-api-key"
              type="password"
              mono
            />
            <TextInput label="时区" value={props.timezone} onChange={props.onTimezoneChange} placeholder="Asia/Shanghai" mono />
            <TextInput
              label="Hive 托管代理前缀"
              value={props.managedProxyPrefix}
              onChange={props.onManagedProxyPrefixChange}
              placeholder="MH-"
              mono
            />
          </div>
          <div className="button-row">
            <Button icon={<Save size={16} />} loading={props.saving} disabled={!props.baseUrl || (!props.apiKey && !props.config?.apiKeyConfigured)} onClick={props.onSaveConfig}>
              保存配置
            </Button>
            <Button variant="secondary" icon={<RefreshCw size={16} />} loading={props.testing} disabled={!configured} onClick={props.onTest}>
              测试连接
            </Button>
            <Button variant="secondary" icon={<RefreshCw size={16} />} loading={props.syncing} disabled={!configured} onClick={props.onSync}>
              回填映射
            </Button>
          </div>
          <p className="muted small">
            "回填映射"是下行同步：从 Sub2API 拉取代理与账号，并把匹配上的 Sub2API proxy_id 写回本地节点。不会修改远端数据。
          </p>
        </section>

        <section className="sub2api-section">
          <div className="section-title">
            <ShieldCheck size={16} />
            <strong>自动接管状态</strong>
          </div>
          <div className="sub2api-summary">
            <SmallMetric label="Hive 代理" value={props.maintenance?.summary.managedProxies ?? 0} />
            <SmallMetric label="关联账号" value={props.maintenance?.summary.managedAccounts ?? 0} />
            <SmallMetric label="可排空" value={props.maintenance?.summary.drainChanges ?? 0} />
            <SmallMetric label="可清理" value={props.maintenance?.summary.emptyManagedProxies ?? 0} />
          </div>
          <p className="muted small">
            系统通过代理名称前缀识别由 Mihomo Hive 管理的代理。用户只需要维护保护节点，账号迁移和清理由系统按计划执行。
          </p>
          {props.maintenance?.risks.length ? <div className="form-error">{props.maintenance.risks.join("；")}</div> : null}
          <div className="button-row wrap">
            <Button variant="secondary" icon={<RefreshCw size={16} />} loading={props.loading} disabled={!configured} onClick={props.onRefresh}>
              刷新计划
            </Button>
            <Button
              icon={<UploadCloud size={16} />}
              loading={props.pushing}
              disabled={!configured}
              onClick={props.onPushManaged}
            >
              推送本地节点
            </Button>
            <Button
              variant="secondary"
              icon={<Activity size={16} />}
              loading={props.checkingQuality}
              disabled={!configured || !props.maintenance || props.maintenance.summary.managedProxies === 0}
              onClick={props.onQualityCheck}
            >
              质量检查
            </Button>
            <Button
              variant="secondary"
              icon={<Unlink size={16} />}
              loading={props.draining}
              disabled={!configured || !props.maintenance || props.maintenance.summary.drainChanges === 0}
              onClick={props.onDrainManaged}
            >
              一键排空 Hive 代理
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 size={16} />}
              loading={props.cleaning}
              disabled={!configured || !props.maintenance || props.maintenance.summary.emptyManagedProxies === 0}
              onClick={props.onCleanupEmpty}
            >
              清理空 Hive 代理
            </Button>
          </div>
        </section>

        <section className="sub2api-section">
          <div className="section-title">
            <ShieldCheck size={16} />
            <strong>账号范围与绑定策略</strong>
          </div>
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
          <Checkbox
            checked={props.overwriteExisting}
            onChange={props.onOverwriteExistingChange}
            label="覆盖现有非保护代理绑定"
          />
          <div className="button-row">
            <Button icon={<Wand2 size={16} />} loading={props.applying} disabled={!canApply} onClick={props.onApply}>
              应用自动绑定
            </Button>
          </div>
        </section>

        <section className="sub2api-section">
          <div className="section-title">
            <ShieldCheck size={16} />
            <strong>保护节点规则</strong>
          </div>
          <div className="sub2api-filter-grid">
            <TextInput
              label="名称包含"
              value={props.protectedRule.nameIncludes}
              onChange={(value) => setProtectedRule("nameIncludes", value)}
              placeholder="WRT / 手工"
            />
            <TextInput
              label="Host 包含"
              value={props.protectedRule.hostIncludes}
              onChange={(value) => setProtectedRule("hostIncludes", value)}
              placeholder="192.168."
              mono
            />
            <TextInput
              label="端口"
              value={props.protectedRule.port ? String(props.protectedRule.port) : ""}
              onChange={(value) => setProtectedRule("port", value)}
              placeholder="7893"
              mono
            />
            <TextInput
              label="国家包含"
              value={props.protectedRule.countryIncludes}
              onChange={(value) => setProtectedRule("countryIncludes", value)}
              placeholder="日本"
            />
            <TextInput
              label="地区包含"
              value={props.protectedRule.regionIncludes}
              onChange={(value) => setProtectedRule("regionIncludes", value)}
              placeholder="东京"
            />
            <TextInput
              label="状态"
              value={props.protectedRule.status}
              onChange={(value) => setProtectedRule("status", value)}
              placeholder="active"
            />
          </div>
          <div className="sub2api-summary">
            <SmallMetric label="Sub2API 代理" value={props.proxies.length} />
            <SmallMetric label="active" value={activeProxies} />
            <SmallMetric label="保护节点" value={protectedProxies.length} />
          </div>
          <div className="proxy-pick-controls">
            <TextInput
              value={proxySearch}
              onChange={setProxySearch}
              placeholder="搜索名称/host/国家/地区"
            />
            <span className="muted small">
              显示 {visibleProxies.length} / 匹配 {filteredProxies.length} / 总 {props.proxies.length}
            </span>
          </div>
          <div className="proxy-pick-list">
            {props.proxies.length === 0 ? (
              <EmptyState title="还没有拉取代理" description="保存并测试 Sub2API 连接后刷新预览，系统会读取 Sub2API 中已有代理。" />
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
        </section>

        <section className="sub2api-section">
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
            <EmptyState title="暂无待应用变更" description="调整账号筛选、保护节点或覆盖策略后刷新预览。" />
          )}
        </section>
      </div>
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
  if (!trimmed) {
    return undefined;
  }
  const port = Number(trimmed);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function isProtectedProxy(proxy: Sub2ApiProxyRecord, rule: Sub2ApiProtectedProxyRule): boolean {
  if (rule.proxyIds.includes(proxy.id)) {
    return true;
  }
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
