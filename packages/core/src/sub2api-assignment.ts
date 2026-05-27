import { createHash } from "node:crypto";
import {
  sub2ApiAssignmentOptionsSchema,
  sub2ApiAssignmentPreviewSchema,
  type Sub2ApiAccountRecord,
  type Sub2ApiAssignmentChange,
  type Sub2ApiAssignmentOptions,
  type Sub2ApiAssignmentPreview,
  type Sub2ApiProtectedProxyRule,
  type Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";

export function planSub2ApiAssignments(input: {
  proxies: Sub2ApiProxyRecord[];
  accounts: Sub2ApiAccountRecord[];
  options: Sub2ApiAssignmentOptions;
}): Sub2ApiAssignmentPreview {
  const options = sub2ApiAssignmentOptionsSchema.parse(input.options);
  const protectedProxies = input.proxies.filter((proxy) => matchesProtectedProxy(proxy, options.protectedRule));
  const protectedProxyIds = new Set(protectedProxies.map((proxy) => proxy.id));
  const assignableProxies = input.proxies
    .filter((proxy) => proxy.status === "active" && !protectedProxyIds.has(proxy.id))
    .sort(compareProxy);
  const assignableProxyIds = new Set(assignableProxies.map((proxy) => proxy.id));
  const proxyNames = new Map(input.proxies.map((proxy) => [proxy.id, proxy.name]));

  const protectedAccounts: Sub2ApiAccountRecord[] = [];
  const unchangedAccounts: Sub2ApiAccountRecord[] = [];
  const changes: Sub2ApiAssignmentChange[] = [];
  const errors: string[] = [];

  if (assignableProxies.length === 0 && input.accounts.some((account) => !protectedProxyIds.has(account.proxy_id ?? -1))) {
    errors.push("没有可用于分配的 Sub2API active 代理。");
  }

  for (const account of uniqueAccounts(input.accounts)) {
    const currentProxyId = account.proxy_id ?? null;
    if (currentProxyId && protectedProxyIds.has(currentProxyId)) {
      protectedAccounts.push(account);
      continue;
    }

    if (!options.overwriteExisting && currentProxyId && assignableProxyIds.has(currentProxyId)) {
      unchangedAccounts.push(account);
      continue;
    }

    const target = pickStableProxy(account, assignableProxies);
    if (!target) {
      unchangedAccounts.push(account);
      continue;
    }

    if (currentProxyId === target.id) {
      unchangedAccounts.push(account);
      continue;
    }

    changes.push({
      accountId: account.id,
      accountName: account.name,
      oldProxyId: currentProxyId,
      oldProxyName: currentProxyId ? proxyNames.get(currentProxyId) ?? null : null,
      newProxyId: target.id,
      newProxyName: target.name,
      reason: resolveChangeReason(account, assignableProxyIds, options.overwriteExisting)
    });
  }

  return sub2ApiAssignmentPreviewSchema.parse({
    options,
    summary: {
      accounts: input.accounts.length,
      proxies: input.proxies.length,
      protectedProxies: protectedProxies.length,
      assignableProxies: assignableProxies.length,
      protectedAccounts: protectedAccounts.length,
      unchangedAccounts: unchangedAccounts.length,
      changedAccounts: changes.length,
      batches: new Set(changes.map((change) => change.newProxyId)).size
    },
    protectedProxies,
    assignableProxies,
    protectedAccounts,
    unchangedAccounts,
    changes,
    errors
  });
}

export function matchesProtectedProxy(proxy: Sub2ApiProxyRecord, rule: Sub2ApiProtectedProxyRule): boolean {
  const hasRule =
    rule.proxyIds.length > 0 ||
    rule.nameIncludes.length > 0 ||
    rule.hostIncludes.length > 0 ||
    Boolean(rule.port) ||
    rule.countryIncludes.length > 0 ||
    rule.regionIncludes.length > 0 ||
    rule.status.length > 0;
  if (!hasRule) {
    return false;
  }
  if (rule.proxyIds.includes(proxy.id)) {
    return true;
  }
  return (
    (rule.nameIncludes.length > 0 && includesText(proxy.name, rule.nameIncludes)) ||
    (rule.hostIncludes.length > 0 && includesText(proxy.host, rule.hostIncludes)) ||
    (Boolean(rule.port) && proxy.port === rule.port) ||
    (rule.countryIncludes.length > 0 && includesText(proxy.country ?? "", rule.countryIncludes)) ||
    (rule.regionIncludes.length > 0 && includesText(proxy.region ?? "", rule.regionIncludes)) ||
    (rule.status.length > 0 && proxy.status === rule.status)
  );
}

export function groupAssignmentChangesByProxy(changes: Sub2ApiAssignmentChange[]): Array<{
  proxyId: number;
  accountIds: number[];
}> {
  const groups = new Map<number, number[]>();
  for (const change of changes) {
    groups.set(change.newProxyId, [...(groups.get(change.newProxyId) ?? []), change.accountId]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([proxyId, accountIds]) => ({ proxyId, accountIds }));
}

function pickStableProxy(account: Sub2ApiAccountRecord, proxies: Sub2ApiProxyRecord[]): Sub2ApiProxyRecord | undefined {
  if (proxies.length === 0) {
    return undefined;
  }
  const key = `${account.id}:${account.name}`;
  const digest = createHash("sha256").update(key).digest();
  const index = digest.readUInt32BE(0) % proxies.length;
  return proxies[index];
}

function resolveChangeReason(
  account: Sub2ApiAccountRecord,
  assignableProxyIds: Set<number>,
  overwriteExisting: boolean
): Sub2ApiAssignmentChange["reason"] {
  if (overwriteExisting) {
    return "overwrite";
  }
  if (!account.proxy_id) {
    return "missing_proxy";
  }
  if (!assignableProxyIds.has(account.proxy_id)) {
    return "invalid_proxy";
  }
  return "overwrite";
}

function uniqueAccounts(accounts: Sub2ApiAccountRecord[]): Sub2ApiAccountRecord[] {
  const seen = new Set<number>();
  return accounts.filter((account) => {
    if (seen.has(account.id)) {
      return false;
    }
    seen.add(account.id);
    return true;
  });
}

function compareProxy(a: Sub2ApiProxyRecord, b: Sub2ApiProxyRecord): number {
  return a.id - b.id || a.host.localeCompare(b.host) || a.port - b.port;
}

function includesText(value: string, expected: string): boolean {
  return expected.length === 0 || value.toLowerCase().includes(expected.toLowerCase());
}
