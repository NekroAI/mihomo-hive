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
  // 渲染所有"有端口、非 retired/deleted"的节点为 listener。
  // 这样 candidate 节点也能被测试 / 用户验证可用性，而是否参与 Sub2API 账号调度
  // 是另外一回事（schedulable + active 才会被推送 / 接收账号）。
  const activeNodes = nodes
    .filter((node) => {
      if (!node.assignedPort) return false;
      const lifecycle = node.lifecycleStatus ?? "candidate";
      if (lifecycle === "retired" || lifecycle === "deleted") return false;
      // status === "failed" 的节点不渲染（连测都失败了）；untested / active 都行
      return node.status !== "failed";
    })
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
