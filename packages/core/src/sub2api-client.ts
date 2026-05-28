import {
  sub2ApiAccountRecordSchema,
  sub2ApiAccountUsageResultSchema,
  sub2ApiCreateAccountPayloadSchema,
  sub2ApiCreateAccountResultSchema,
  sub2ApiGroupRecordSchema,
  sub2ApiImportProxyDataResultSchema,
  sub2ApiProxyQualityResultSchema,
  sub2ApiProxyRecordSchema,
  sub2ApiRefreshOpenaiTokenResultSchema,
  sub2ApiSchedulableToggleResultSchema,
  sub2ApiUpstreamErrorSchema,
  type Sub2ApiAccountFilters,
  type Sub2ApiAccountRecord,
  type Sub2ApiAccountUsageResult,
  type Sub2ApiConnectionConfig,
  type Sub2ApiCreateAccountPayload,
  type Sub2ApiCreateAccountResult,
  type Sub2ApiGroupRecord,
  type Sub2ApiImportProxyDataResult,
  type Sub2ApiProxyQualityResult,
  type Sub2ApiProxyRecord,
  type Sub2ApiRefreshOpenaiTokenResult,
  type Sub2ApiSchedulableToggleResult,
  type Sub2ApiUpstreamError,
  type Sub2ApiUpstreamErrorListOptions
} from "@mihomo-hive/schemas";

interface Sub2ApiListResponse<T> {
  code: number;
  message?: string;
  data?: {
    items?: T[];
    total?: number;
    page?: number;
    page_size?: number;
    pages?: number;
  };
}

interface Sub2ApiBulkUpdateResponse {
  code: number;
  message?: string;
  data?: {
    success?: number;
    failed?: number;
    success_ids?: number[];
    failed_ids?: number[];
    results?: Array<{ account_id: number; success: boolean; message?: string }>;
  };
}

export class Sub2ApiClient {
  constructor(private readonly config: Sub2ApiConnectionConfig) {}

  async testConnection(): Promise<{ proxies: number; accounts: number }> {
    const [proxies, accounts] = await Promise.all([
      this.listProxies({ pageSize: 1 }),
      this.listAccounts({ pageSize: 1 })
    ]);
    return {
      proxies: proxies.total,
      accounts: accounts.total
    };
  }

  async listAllProxies(): Promise<Sub2ApiProxyRecord[]> {
    return this.listAllPages((page) => this.listProxies({ page, pageSize: 100 }));
  }

  async listAllAccounts(filters: Sub2ApiAccountFilters): Promise<Sub2ApiAccountRecord[]> {
    return this.listAllPages((page) => this.listAccounts({ page, pageSize: 100, filters }));
  }

  async listProxyAccounts(proxyId: number): Promise<Sub2ApiAccountRecord[]> {
    const response = await this.request<Sub2ApiListResponse<unknown>>(`/api/v1/admin/proxies/${proxyId}/accounts?page=1&page_size=500`);
    assertSuccess(response, "获取代理关联账号失败");
    const data = response.data ?? {};
    return (data.items ?? []).map((item) => sub2ApiAccountRecordSchema.parse(item));
  }

  async deleteProxy(proxyId: number): Promise<void> {
    const response = await this.request<{ code: number; message?: string }>(`/api/v1/admin/proxies/${proxyId}`, {
      method: "DELETE"
    });
    assertSuccess(response, "删除 Sub2API 代理失败");
  }

  async importProxyData(payload: {
    proxies: unknown[];
    accounts?: unknown[];
  }): Promise<Sub2ApiImportProxyDataResult> {
    const response = await this.request<{ code: number; message?: string; data?: unknown }>(
      "/api/v1/admin/proxies/data",
      {
        method: "POST",
        body: JSON.stringify({ data: { proxies: payload.proxies, accounts: payload.accounts ?? [] } })
      }
    );
    assertSuccess(response, "导入 Sub2API 代理数据失败");
    return sub2ApiImportProxyDataResultSchema.parse(response.data ?? {});
  }

  async clearAccountProxy(accountIds: number[]): Promise<{
    success: number;
    failed: number;
    successIds: number[];
    failedIds: number[];
    results: Array<{ accountId: number; success: boolean; message?: string }>;
  }> {
    // proxy_id=0 解除绑定（Sub2API 管理员接口约定）
    return this.bulkUpdateProxy(accountIds, 0);
  }

  async qualityCheckProxy(proxyId: number): Promise<Sub2ApiProxyQualityResult> {
    const response = await this.request<{ code: number; message?: string; data?: unknown }>(
      `/api/v1/admin/proxies/${proxyId}/quality-check`,
      { method: "POST" }
    );
    assertSuccess(response, "代理质量检查失败");
    return sub2ApiProxyQualityResultSchema.parse(response.data ?? {});
  }

  async listUpstreamErrors(options: Partial<Sub2ApiUpstreamErrorListOptions> & {
    page?: number;
    pageSize?: number;
  } = {}): Promise<{ items: Sub2ApiUpstreamError[]; total: number; pages: number }> {
    const search = new URLSearchParams({
      page: String(options.page ?? 1),
      page_size: String(options.pageSize ?? 100),
      time_range: options.timeRange ?? "1h",
      view: options.view ?? "errors",
      phase: options.phase ?? "upstream",
      timezone: this.config.timezone
    });
    const response = await this.request<Sub2ApiListResponse<unknown>>(`/api/v1/admin/ops/upstream-errors?${search}`);
    assertSuccess(response, "获取 Sub2API 上游错误日志失败");
    const data = response.data ?? {};
    return {
      items: (data.items ?? []).map((item) => sub2ApiUpstreamErrorSchema.parse(item)),
      total: data.total ?? 0,
      pages: data.pages ?? 1
    };
  }

  async listAllUpstreamErrors(options: Partial<Sub2ApiUpstreamErrorListOptions> = {}): Promise<Sub2ApiUpstreamError[]> {
    return this.listAllPages((page) => this.listUpstreamErrors({ ...options, page, pageSize: 200 }));
  }

  // ─── Account write APIs (P2) ────────────────────────────────

  /**
   * 用一个 refresh_token 换出完整 token bundle。
   * 主要用于：codex-tool login/all 拿到 fresh refresh_token 后，灌进 Sub2API 拿
   * Sub2API 标准化后的 token 字段，再调 createAccount 落库。
   *
   * **不是恢复路径**：Sub2API broken 的账号意味着它的 refresh_token 已死，
   * 直接调这里也会失败。
   */
  async refreshOpenaiToken(input: {
    refreshToken: string;
    proxyId: number;
  }): Promise<Sub2ApiRefreshOpenaiTokenResult> {
    const response = await this.request<{ code: number; message?: string; data?: unknown }>(
      "/api/v1/admin/openai/refresh-token",
      {
        method: "POST",
        body: JSON.stringify({ refresh_token: input.refreshToken, proxy_id: input.proxyId })
      }
    );
    assertSuccess(response, "导入 refresh_token 失败");
    return sub2ApiRefreshOpenaiTokenResultSchema.parse(response.data ?? {});
  }

  /** POST /admin/accounts —— 创建账号。payload 由 schemas 严格定义。 */
  async createAccount(payload: Sub2ApiCreateAccountPayload): Promise<Sub2ApiCreateAccountResult> {
    const parsed = sub2ApiCreateAccountPayloadSchema.parse(payload);
    const response = await this.request<{ code: number; message?: string; data?: unknown }>(
      "/api/v1/admin/accounts",
      { method: "POST", body: JSON.stringify(parsed) }
    );
    assertSuccess(response, "创建 Sub2API 账号失败");
    return sub2ApiCreateAccountResultSchema.parse(response.data ?? {});
  }

  /** GET /admin/accounts/{id}/usage —— 5h + 7d 配额窗口。source/force 用默认值。 */
  async getAccountUsage(
    accountId: number,
    options: { source?: string; force?: boolean } = {}
  ): Promise<Sub2ApiAccountUsageResult> {
    const search = new URLSearchParams({
      source: options.source ?? "active",
      force: options.force === false ? "false" : "true",
      timezone: this.config.timezone
    });
    const response = await this.request<{ code: number; message?: string; data?: unknown }>(
      `/api/v1/admin/accounts/${accountId}/usage?${search}`
    );
    assertSuccess(response, "查询账号配额失败");
    return sub2ApiAccountUsageResultSchema.parse(response.data ?? {});
  }

  /** DELETE /admin/accounts/{id} */
  async deleteAccount(accountId: number): Promise<void> {
    const response = await this.request<{ code: number; message?: string }>(
      `/api/v1/admin/accounts/${accountId}`,
      { method: "DELETE" }
    );
    assertSuccess(response, "删除 Sub2API 账号失败");
  }

  /** PUT /admin/accounts/{id}/schedulable —— body: { schedulable } */
  async setAccountSchedulable(
    accountId: number,
    schedulable: boolean
  ): Promise<Sub2ApiSchedulableToggleResult> {
    const response = await this.request<{ code: number; message?: string; data?: unknown }>(
      `/api/v1/admin/accounts/${accountId}/schedulable`,
      { method: "PUT", body: JSON.stringify({ schedulable }) }
    );
    assertSuccess(response, "切换账号调度状态失败");
    return sub2ApiSchedulableToggleResultSchema.parse(response.data ?? {});
  }

  /** GET /admin/groups —— 列所有 group（账号要绑定 group_ids）。 */
  async listGroups(): Promise<Sub2ApiGroupRecord[]> {
    const search = new URLSearchParams({
      page: "1",
      page_size: "100",
      sort_by: "sort_order",
      sort_order: "asc",
      timezone: this.config.timezone
    });
    const response = await this.request<Sub2ApiListResponse<unknown>>(
      `/api/v1/admin/groups?${search}`
    );
    assertSuccess(response, "获取 Sub2API 分组列表失败");
    const data = response.data ?? {};
    return (data.items ?? []).map((item) => sub2ApiGroupRecordSchema.parse(item));
  }

  async bulkUpdateProxy(accountIds: number[], proxyId: number): Promise<{
    success: number;
    failed: number;
    successIds: number[];
    failedIds: number[];
    results: Array<{ accountId: number; success: boolean; message?: string }>;
  }> {
    if (accountIds.length === 0) {
      return { success: 0, failed: 0, successIds: [], failedIds: [], results: [] };
    }
    const response = await this.request<Sub2ApiBulkUpdateResponse>("/api/v1/admin/accounts/bulk-update", {
      method: "POST",
      body: JSON.stringify({
        account_ids: accountIds,
        proxy_id: proxyId
      })
    });
    assertSuccess(response, "更新账号代理失败");
    const data = response.data ?? {};
    return {
      success: data.success ?? 0,
      failed: data.failed ?? 0,
      successIds: data.success_ids ?? [],
      failedIds: data.failed_ids ?? [],
      results: (data.results ?? []).map((item) => ({
        accountId: item.account_id,
        success: item.success,
        ...(item.message ? { message: item.message } : {})
      }))
    };
  }

  private async listProxies(options: { page?: number; pageSize?: number }): Promise<{
    items: Sub2ApiProxyRecord[];
    total: number;
    pages: number;
  }> {
    const search = new URLSearchParams({
      page: String(options.page ?? 1),
      page_size: String(options.pageSize ?? 100),
      sort_by: "id",
      sort_order: "desc",
      timezone: this.config.timezone
    });
    const response = await this.request<Sub2ApiListResponse<unknown>>(`/api/v1/admin/proxies?${search}`);
    assertSuccess(response, "获取 Sub2API 代理列表失败");
    const data = response.data ?? {};
    return {
      items: (data.items ?? []).map((item) => sub2ApiProxyRecordSchema.parse(item)),
      total: data.total ?? 0,
      pages: data.pages ?? 1
    };
  }

  private async listAccounts(options: {
    page?: number;
    pageSize?: number;
    filters?: Partial<Sub2ApiAccountFilters>;
  }): Promise<{ items: Sub2ApiAccountRecord[]; total: number; pages: number }> {
    const filters = options.filters ?? {};
    const search = new URLSearchParams({
      page: String(options.page ?? 1),
      page_size: String(options.pageSize ?? 100),
      platform: filters.platform ?? "",
      type: filters.type ?? "",
      status: filters.status ?? "",
      privacy_mode: filters.privacyMode ?? "",
      group: filters.group ?? "",
      search: filters.search ?? "",
      sort_by: "status",
      sort_order: "asc",
      timezone: this.config.timezone
    });
    const response = await this.request<Sub2ApiListResponse<unknown>>(`/api/v1/admin/accounts?${search}`);
    assertSuccess(response, "获取 Sub2API 账号列表失败");
    const data = response.data ?? {};
    return {
      items: (data.items ?? []).map((item) => sub2ApiAccountRecordSchema.parse(item)),
      total: data.total ?? 0,
      pages: data.pages ?? 1
    };
  }

  private async listAllPages<T>(load: (page: number) => Promise<{ items: T[]; pages: number }>): Promise<T[]> {
    const first = await load(1);
    const items = [...first.items];
    for (let page = 2; page <= first.pages; page += 1) {
      items.push(...(await load(page)).items);
    }
    return items;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, normalizeBaseUrl(this.config.baseUrl));
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": this.config.adminApiKey,
        ...(init.headers ?? {})
      }
    });
    const body = (await response.json().catch(() => undefined)) as T | undefined;
    if (!response.ok) {
      throw new Error(`Sub2API HTTP ${response.status}: ${JSON.stringify(body ?? {})}`);
    }
    if (!body) {
      throw new Error("Sub2API 返回了空响应");
    }
    return body;
  }
}

export function createSub2ApiClient(config: Sub2ApiConnectionConfig): Sub2ApiClient {
  return new Sub2ApiClient(config);
}

function assertSuccess(response: { code: number; message?: string }, fallback: string): void {
  if (response.code !== 0) {
    throw new Error(`${fallback}: ${response.message ?? `code ${response.code}`}`);
  }
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
