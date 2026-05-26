import { stringify } from "yaml";
import type { ProxyNode, RuntimeConfig } from "@mihomo-hive/schemas";

export interface RenderedMihomo {
  yaml: string;
  egressMap: Array<{
    nodeHash: string;
    nodeName: string;
    proxyName: string;
    listenHost: string;
    port: number;
  }>;
}

export function renderMihomoConfig(nodes: ProxyNode[], config: RuntimeConfig): RenderedMihomo {
  const activeNodes = nodes
    .filter((node) => node.status === "active" && node.assignedPort)
    .sort((a, b) => Number(a.assignedPort) - Number(b.assignedPort));

  const proxies = activeNodes.map((node, index) => ({
    ...node.raw,
    name: proxyNameForNode(node, index)
  }));

  const listeners = activeNodes.map((node, index) => ({
    name: `hive-${node.assignedPort}`,
    type: "mixed",
    listen: config.listenHost,
    port: node.assignedPort,
    udp: true,
    users: [],
    proxy: proxyNameForNode(node, index)
  }));

  const document = {
    "allow-lan": false,
    "bind-address": config.listenHost,
    mode: "rule",
    "log-level": "info",
    ipv6: true,
    "external-controller": config.externalController,
    secret: config.externalControllerSecret,
    listeners,
    proxies,
    rules: ["MATCH,DIRECT"]
  };

  return {
    yaml: stringify(document, { lineWidth: 0 }),
    egressMap: activeNodes.map((node, index) => ({
      nodeHash: node.hash,
      nodeName: node.name,
      proxyName: proxyNameForNode(node, index),
      listenHost: config.listenHost,
      port: Number(node.assignedPort)
    }))
  };
}

function proxyNameForNode(node: ProxyNode, index: number): string {
  return `hive-${String(index + 1).padStart(3, "0")}-${node.hash.slice(0, 8)}`;
}
