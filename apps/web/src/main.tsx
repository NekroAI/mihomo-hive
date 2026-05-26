import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import type { AppRouter } from "../../server/src/router.js";
import { Activity, Database, Download, Network, Server } from "lucide-react";
import "./styles.css";

const trpc = createTRPCReact<AppRouter>();
const queryClient = new QueryClient();
const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/trpc"
    })
  ]
});

function App() {
  const config = trpc.runtime.config.useQuery();
  const status = trpc.runtime.status.useQuery(undefined, { refetchInterval: 5000 });
  const nodes = trpc.nodes.list.useQuery();
  const exportData = trpc.exports.sub2api.useQuery(undefined, { enabled: Boolean(nodes.data) });

  const active = nodes.data?.filter((node) => node.status === "active").length ?? 0;
  const assigned = nodes.data?.filter((node) => node.assignedPort).length ?? 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-panel">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold">Mihomo Hive</h1>
            <p className="text-sm text-slate-600">nexus-star 固定出口代理池</p>
          </div>
          <a
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white"
            href="/api/exports/sub2api"
          >
            <Download size={16} />
            导出 Sub2API
          </a>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-4 px-6 py-6 md:grid-cols-4">
        <Stat icon={<Server size={18} />} label="Mihomo" value={status.data?.running ? "运行中" : "未运行"} />
        <Stat icon={<Network size={18} />} label="节点总数" value={String(nodes.data?.length ?? 0)} />
        <Stat icon={<Activity size={18} />} label="Active 节点" value={String(active)} />
        <Stat icon={<Database size={18} />} label="已分配端口" value={String(assigned)} />
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-6 pb-8 lg:grid-cols-[1fr_360px]">
        <div className="overflow-hidden rounded-lg border border-border bg-panel">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-medium">节点出口</h2>
          </div>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-4 py-2">端口</th>
                  <th className="px-4 py-2">状态</th>
                  <th className="px-4 py-2">地区</th>
                  <th className="px-4 py-2">协议</th>
                  <th className="px-4 py-2">名称</th>
                </tr>
              </thead>
              <tbody>
                {(nodes.data ?? []).slice(0, 300).map((node) => (
                  <tr key={node.hash} className="border-t border-border">
                    <td className="px-4 py-2 font-mono">{node.assignedPort ?? "-"}</td>
                    <td className="px-4 py-2">{node.status}</td>
                    <td className="px-4 py-2">{node.region}</td>
                    <td className="px-4 py-2">{node.type}</td>
                    <td className="max-w-[420px] truncate px-4 py-2">{node.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="space-y-4">
          <Panel title="运行配置">
            <Row label="监听地址" value={config.data?.listenHost ?? "-"} />
            <Row label="导出地址" value={config.data?.exportHost ?? "-"} />
            <Row
              label="端口段"
              value={
                config.data ? `${config.data.portRangeStart}-${config.data.portRangeEnd}` : "-"
              }
            />
          </Panel>
          <Panel title="Sub2API 预览">
            <Row label="导出节点" value={String(exportData.data?.proxies.length ?? 0)} />
            <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
              {JSON.stringify(exportData.data?.proxies.slice(0, 3) ?? [], null, 2)}
            </pre>
          </Panel>
        </aside>
      </section>
    </main>
  );
}

function Stat(props: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 text-accent">{props.icon}</div>
      <div className="text-sm text-slate-600">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold">{props.value}</div>
    </div>
  );
}

function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="font-medium">{props.title}</h2>
      <div className="mt-3">{props.children}</div>
    </section>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-2 text-sm last:border-b-0">
      <span className="text-slate-600">{props.label}</span>
      <span className="font-mono">{props.value}</span>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  </React.StrictMode>
);
