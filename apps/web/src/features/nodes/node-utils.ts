import type { ProxyNode } from "@mihomo-hive/schemas";

export interface NodeFilters {
  search: string;
  status: string;
  region: string;
  type: string;
  sourceId: string;
  portFrom: string;
  portTo: string;
  maxLatencyMs: string;
}

export const defaultNodeFilters: NodeFilters = {
  search: "",
  status: "all",
  region: "all",
  type: "all",
  sourceId: "all",
  portFrom: "",
  portTo: "",
  maxLatencyMs: ""
};

export function filterNodes(nodes: ProxyNode[], filters: NodeFilters): ProxyNode[] {
  const query = filters.search.trim().toLowerCase();
  const portFrom = Number(filters.portFrom);
  const portTo = Number(filters.portTo);
  const maxLatency = Number(filters.maxLatencyMs);

  return nodes.filter((node) => {
    if (query && !`${node.name} ${node.originalName} ${node.region} ${node.type}`.toLowerCase().includes(query)) {
      return false;
    }
    if (filters.status !== "all" && node.status !== filters.status) {
      return false;
    }
    if (filters.region !== "all" && node.region !== filters.region) {
      return false;
    }
    if (filters.type !== "all" && node.type !== filters.type) {
      return false;
    }
    if (filters.sourceId !== "all" && node.sourceId !== filters.sourceId) {
      return false;
    }
    if (Number.isFinite(portFrom) && filters.portFrom && (!node.assignedPort || node.assignedPort < portFrom)) {
      return false;
    }
    if (Number.isFinite(portTo) && filters.portTo && (!node.assignedPort || node.assignedPort > portTo)) {
      return false;
    }
    if (
      Number.isFinite(maxLatency) &&
      filters.maxLatencyMs &&
      (!node.lastTestLatencyMs || node.lastTestLatencyMs > maxLatency)
    ) {
      return false;
    }
    return true;
  });
}

export function canExportNode(node: ProxyNode): boolean {
  return node.status === "active" && Boolean(node.assignedPort);
}

export function exportBlockReason(node: ProxyNode): string {
  if (node.status !== "active") {
    return `状态为${formatNodeStatus(node.status)}`;
  }
  if (!node.assignedPort) {
    return "未分配端口";
  }
  return "可导出";
}

export function formatNodeStatus(status: ProxyNode["status"]): string {
  switch (status) {
    case "active":
      return "可用";
    case "failed":
      return "失败";
    case "untested":
      return "未测试";
    case "inactive":
      return "停用";
    default:
      return status;
  }
}

export function statusTone(status: ProxyNode["status"]): "success" | "danger" | "warning" | "neutral" {
  switch (status) {
    case "active":
      return "success";
    case "failed":
      return "danger";
    case "untested":
      return "warning";
    case "inactive":
      return "neutral";
    default:
      return "neutral";
  }
}

export function uniqueOptions(nodes: ProxyNode[], field: "region" | "type" | "sourceId"): Array<{ label: string; value: string }> {
  const values = Array.from(new Set(nodes.map((node) => node[field]).filter(Boolean))).sort((a, b) =>
    String(a).localeCompare(String(b))
  );
  return values.map((value) => ({ label: String(value), value: String(value) }));
}
