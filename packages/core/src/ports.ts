import net from "node:net";
import type { ProxyNode } from "@mihomo-hive/schemas";

export interface PortRange {
  start: number;
  end: number;
}

export function parsePortRange(range: string): PortRange {
  const match = range.match(/^(\d+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid port range: ${range}`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end > 65535 || end < start) {
    throw new Error(`Invalid port range: ${range}`);
  }
  return { start, end };
}

export function enumeratePorts(range: PortRange): number[] {
  return Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index);
}

export async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function findOccupiedPorts(host: string, ports: number[]): Promise<Set<number>> {
  const checks = await Promise.all(
    ports.map(async (port) => [port, !(await isPortAvailable(host, port))] as const)
  );
  return new Set(checks.filter(([, occupied]) => occupied).map(([port]) => port));
}

export interface AssignPortsInput {
  nodes: ProxyNode[];
  range: PortRange;
  occupiedPorts?: Set<number>;
  preserveExisting?: boolean;
  /**
   * 限定参与本次分配的节点 hash 集合。
   *   - 给定时：只给这些节点（且非 retired/deleted）分端口，**不动其他节点已有端口**。
   *   - 未给定时：把所有非 retired/deleted 节点都纳入分配（candidate / disabled / schedulable / cooling_down）。
   *
   * 行为变更（ADR 0003 后）：端口分配从"只给 schedulable+cooling_down"扩大到"非 retired/deleted"。
   * 端口分配 ≠ 加入 Sub2API 调度；后者仍严格基于 lifecycleStatus === "schedulable"。这样
   * 用户可以"先给 candidate 节点挂 listener 测试，再决定是否启用调度"。
   */
  targetHashes?: string[];
}

const ASSIGNABLE_LIFECYCLES = new Set([
  "candidate",
  "schedulable",
  "cooling_down",
  "disabled",
  "draining",
  "testing"
]);

export function assignStablePorts({
  nodes,
  range,
  occupiedPorts = new Set(),
  preserveExisting = true,
  targetHashes
}: AssignPortsInput): ProxyNode[] {
  let targets: ProxyNode[];
  if (targetHashes) {
    const targetSet = new Set(targetHashes);
    targets = nodes.filter((node) => {
      if (!targetSet.has(node.hash)) return false;
      const lifecycle = node.lifecycleStatus ?? "candidate";
      return ASSIGNABLE_LIFECYCLES.has(lifecycle);
    });
  } else {
    targets = nodes.filter((node) => ASSIGNABLE_LIFECYCLES.has(node.lifecycleStatus ?? "candidate"));
  }

  // retired / deleted 节点彻底清掉端口（无论是否在 targetHashes 里）
  for (const node of nodes) {
    const lifecycle = node.lifecycleStatus ?? "candidate";
    if (lifecycle === "retired" || lifecycle === "deleted") {
      node.assignedPort = undefined;
    }
  }

  // 已用端口：1) 系统占用 2) 非目标节点已有的端口（不动它们）
  const targetHashSet = new Set(targets.map((node) => node.hash));
  const used = new Set<number>(occupiedPorts);
  for (const node of nodes) {
    if (!targetHashSet.has(node.hash) && node.assignedPort) {
      used.add(node.assignedPort);
    }
  }

  const capacity = range.end - range.start + 1 - used.size;
  if (targets.length > capacity) {
    throw new Error(
      `Not enough free ports: ${targets.length} nodes need ports, but only ${capacity} ports are available`
    );
  }

  // preserveExisting：目标节点已有 range 内、未冲突的端口就保留
  for (const node of targets) {
    if (
      preserveExisting &&
      node.assignedPort &&
      node.assignedPort >= range.start &&
      node.assignedPort <= range.end &&
      !used.has(node.assignedPort)
    ) {
      used.add(node.assignedPort);
    } else {
      node.assignedPort = undefined;
    }
  }

  for (const node of targets) {
    if (node.assignedPort) continue;
    const next = enumeratePorts(range).find((port) => !used.has(port));
    if (!next) {
      throw new Error("Port allocation failed unexpectedly");
    }
    node.assignedPort = next;
    used.add(next);
  }

  return nodes;
}
