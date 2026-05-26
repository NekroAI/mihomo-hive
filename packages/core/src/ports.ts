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
}

export function assignStablePorts({ nodes, range, occupiedPorts = new Set() }: AssignPortsInput): ProxyNode[] {
  const activeNodes = nodes.filter((node) => node.status === "active" || node.status === "untested");
  const capacity = range.end - range.start + 1 - occupiedPorts.size;
  if (activeNodes.length > capacity) {
    throw new Error(
      `Not enough free ports: ${activeNodes.length} nodes need ports, but only ${capacity} ports are available`
    );
  }

  const used = new Set<number>(occupiedPorts);
  for (const node of activeNodes) {
    if (
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

  for (const node of activeNodes) {
    if (node.assignedPort) {
      continue;
    }
    const next = enumeratePorts(range).find((port) => !used.has(port));
    if (!next) {
      throw new Error("Port allocation failed unexpectedly");
    }
    node.assignedPort = next;
    used.add(next);
  }

  return nodes;
}
