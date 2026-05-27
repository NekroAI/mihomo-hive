import {
  sub2ApiMaintenancePreviewSchema,
  type Sub2ApiAccountRecord,
  type Sub2ApiAssignmentChange,
  type Sub2ApiAssignmentPreview,
  type Sub2ApiMaintenancePreview,
  type Sub2ApiProtectedProxyRule,
  type Sub2ApiProxyRecord
} from "@mihomo-hive/schemas";
import { groupAssignmentChangesByProxy, matchesProtectedProxy } from "./sub2api-assignment.js";

export function isManagedProxy(proxy: Sub2ApiProxyRecord, prefix: string): boolean {
  return proxy.name.startsWith(prefix);
}

export function planSub2ApiManagedMaintenance(input: {
  proxies: Sub2ApiProxyRecord[];
  accounts: Sub2ApiAccountRecord[];
  protectedRule: Sub2ApiProtectedProxyRule;
  managedProxyPrefix: string;
}): Sub2ApiMaintenancePreview {
  const managedProxies = input.proxies.filter((proxy) => isManagedProxy(proxy, input.managedProxyPrefix)).sort(compareProxy);
  const managedProxyIds = new Set(managedProxies.map((proxy) => proxy.id));
  const protectedProxies = input.proxies.filter((proxy) => matchesProtectedProxy(proxy, input.protectedRule));
  const protectedProxyIds = new Set(protectedProxies.map((proxy) => proxy.id));
  const assignableTargets = input.proxies
    .filter((proxy) => proxy.status === "active" && !managedProxyIds.has(proxy.id) && !protectedProxyIds.has(proxy.id))
    .sort(compareProxy);
  const assignableTargetIds = new Set(assignableTargets.map((proxy) => proxy.id));
  const proxyNames = new Map(input.proxies.map((proxy) => [proxy.id, proxy.name]));

  const protectedAccounts: Sub2ApiAccountRecord[] = [];
  const unchangedAccounts: Sub2ApiAccountRecord[] = [];
  const changes: Sub2ApiAssignmentChange[] = [];
  const errors: string[] = [];

  for (const account of uniqueAccounts(input.accounts)) {
    const currentProxyId = account.proxy_id ?? null;
    if (!currentProxyId || !managedProxyIds.has(currentProxyId)) {
      unchangedAccounts.push(account);
      continue;
    }
    if (protectedProxyIds.has(currentProxyId)) {
      protectedAccounts.push(account);
      continue;
    }
    const target = pickLeastLoadedTarget(assignableTargets, changes);
    if (!target) {
      unchangedAccounts.push(account);
      continue;
    }
    changes.push({
      accountId: account.id,
      accountName: account.name,
      oldProxyId: currentProxyId,
      oldProxyName: proxyNames.get(currentProxyId) ?? null,
      newProxyId: target.id,
      newProxyName: target.name,
      reason: assignableTargetIds.has(currentProxyId) ? "overwrite" : "invalid_proxy"
    });
  }

  if (managedProxies.length > 0 && changes.length > 0 && assignableTargets.length === 0) {
    errors.push("没有可用于排空 Hive 托管代理的非保护 active 代理。");
  }

  const accountsByProxy = countAccountsByProxy(input.accounts);
  const emptyManagedProxies = managedProxies.filter((proxy) => (accountsByProxy.get(proxy.id) ?? 0) === 0);
  const drainPlan: Sub2ApiAssignmentPreview = {
    options: {
      filters: {
        platform: "",
        type: "",
        status: "",
        privacyMode: "",
        group: "",
        search: ""
      },
      protectedRule: input.protectedRule,
      overwriteExisting: true
    },
    summary: {
      accounts: input.accounts.length,
      proxies: input.proxies.length,
      protectedProxies: protectedProxies.length,
      assignableProxies: assignableTargets.length,
      protectedAccounts: protectedAccounts.length,
      unchangedAccounts: unchangedAccounts.length,
      changedAccounts: changes.length,
      batches: groupAssignmentChangesByProxy(changes).length
    },
    protectedProxies,
    assignableProxies: assignableTargets,
    protectedAccounts,
    unchangedAccounts,
    changes,
    errors
  };

  return sub2ApiMaintenancePreviewSchema.parse({
    managedProxyPrefix: input.managedProxyPrefix,
    summary: {
      proxies: input.proxies.length,
      managedProxies: managedProxies.length,
      managedAccounts: input.accounts.filter((account) => account.proxy_id && managedProxyIds.has(account.proxy_id)).length,
      emptyManagedProxies: emptyManagedProxies.length,
      drainChanges: changes.length,
      protectedAccounts: protectedAccounts.length,
      assignableTargets: assignableTargets.length
    },
    managedProxies,
    emptyManagedProxies,
    drainPlan,
    risks: errors
  });
}

function pickLeastLoadedTarget(
  targets: Sub2ApiProxyRecord[],
  plannedChanges: Sub2ApiAssignmentChange[]
): Sub2ApiProxyRecord | undefined {
  if (targets.length === 0) {
    return undefined;
  }
  const planned = new Map<number, number>();
  for (const change of plannedChanges) {
    planned.set(change.newProxyId, (planned.get(change.newProxyId) ?? 0) + 1);
  }
  return [...targets].sort((a, b) => (a.account_count ?? 0) + (planned.get(a.id) ?? 0) - ((b.account_count ?? 0) + (planned.get(b.id) ?? 0)) || a.id - b.id)[0];
}

function countAccountsByProxy(accounts: Sub2ApiAccountRecord[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const account of accounts) {
    if (account.proxy_id) {
      counts.set(account.proxy_id, (counts.get(account.proxy_id) ?? 0) + 1);
    }
  }
  return counts;
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
