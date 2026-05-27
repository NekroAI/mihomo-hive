import {
  sub2ApiAccountRecordSchema,
  sub2ApiProxyRecordSchema,
  type Sub2ApiAccountFilters,
  type Sub2ApiAccountRecord,
  type Sub2ApiConnectionConfig,
  type Sub2ApiProxyRecord
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
