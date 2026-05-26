import {
  sub2ApiExportSchema,
  type ProxyNode,
  type Sub2ApiExport
} from "@mihomo-hive/schemas";

export interface ExportSub2ApiOptions {
  host: string;
  username?: string;
  password?: string;
}

export function exportSub2Api(nodes: ProxyNode[], options: ExportSub2ApiOptions): Sub2ApiExport {
  const proxies = nodes
    .filter((node) => node.assignedPort)
    .sort((a, b) => Number(a.assignedPort) - Number(b.assignedPort))
    .map((node) => {
      const protocol = "socks5" as const;
      const username = readOptionalString(options.username);
      const password = readOptionalString(options.password);
      const proxyKey = [protocol, options.host, Number(node.assignedPort), username ?? "", password ?? ""].join("|");
      return {
        proxy_key: proxyKey,
        name: node.name,
        protocol,
        host: options.host,
        port: Number(node.assignedPort),
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        status: node.status === "active" ? ("active" as const) : ("inactive" as const)
      };
    });

  return sub2ApiExportSchema.parse({
    proxies,
    accounts: []
  });
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
