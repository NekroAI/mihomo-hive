import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import type { AppRouter } from "../../server/src/router.js";
import {
  Activity,
  Database,
  Download,
  FileJson,
  Gauge,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  StopCircle,
  UploadCloud
} from "lucide-react";
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
  const utils = trpc.useUtils();
  const [authStatus, setAuthStatus] = React.useState<AuthStatus | undefined>();
  const [authPassword, setAuthPassword] = React.useState("");
  const [authConfirm, setAuthConfirm] = React.useState("");
  const [authMessage, setAuthMessage] = React.useState("");
  const authenticated = Boolean(authStatus?.authenticated);
  const config = trpc.runtime.config.useQuery(undefined, { enabled: authenticated });
  const subscriptions = trpc.subscriptions.list.useQuery(undefined, { enabled: authenticated });
  const status = trpc.runtime.status.useQuery(undefined, { enabled: authenticated, refetchInterval: 5000 });
  const nodes = trpc.nodes.list.useQuery(undefined, { enabled: authenticated });
  const exportData = trpc.exports.sub2api.useQuery(undefined, { enabled: authenticated && Boolean(nodes.data) });
  const [subscriptionName, setSubscriptionName] = React.useState("");
  const [subscriptionUrl, setSubscriptionUrl] = React.useState("");
  const [portRange, setPortRange] = React.useState("10001-10300");
  const [message, setMessage] = React.useState("就绪");

  const refreshAuth = React.useCallback(async () => {
    setAuthStatus(await fetchAuthStatus());
  }, []);

  React.useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  React.useEffect(() => {
    if (config.data) {
      setPortRange(`${config.data.portRangeStart}-${config.data.portRangeEnd}`);
    }
  }, [config.data]);

  const refreshAll = React.useCallback(async () => {
    await Promise.all([
      utils.subscriptions.list.invalidate(),
      utils.nodes.list.invalidate(),
      utils.runtime.status.invalidate(),
      utils.exports.sub2api.invalidate()
    ]);
  }, [utils]);

  async function submitAuth() {
    if (!authStatus) {
      return;
    }
    if (!authStatus.configured && authPassword !== authConfirm) {
      setAuthMessage("两次密码不一致");
      return;
    }
    const endpoint = authStatus.configured ? "/api/auth/login" : "/api/auth/setup";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password: authPassword })
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setAuthMessage(body.error ?? "认证失败");
      return;
    }
    setAuthPassword("");
    setAuthConfirm("");
    setAuthMessage("");
    await refreshAuth();
    await refreshAll();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    setMessage("已登出");
    await refreshAuth();
    queryClient.clear();
  }


  const addSubscription = trpc.subscriptions.add.useMutation({
    onSuccess: async () => {
      setMessage("订阅已添加");
      setSubscriptionName("");
      setSubscriptionUrl("");
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const fetchSubscriptions = trpc.subscriptions.fetch.useMutation({
    onSuccess: async (result) => {
      setMessage(`已拉取 ${result.length} 个订阅`);
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const importNodes = trpc.nodes.import.useMutation({
    onSuccess: async (result) => {
      setMessage(`已导入 ${result.imported} 个节点`);
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const assignPorts = trpc.nodes.assignPorts.useMutation({
    onSuccess: async (result) => {
      setMessage(`已分配 ${result.assigned} 个端口`);
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const testNodes = trpc.nodes.test.useMutation({
    onSuccess: async (result) => {
      setMessage(`测试完成：${result.passed}/${result.tested} 通过`);
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const renderMihomo = trpc.mihomo.render.useMutation({
    onSuccess: async (result) => {
      setMessage(`已生成 ${result.listeners} 个 listener`);
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const startMihomo = trpc.mihomo.start.useMutation({
    onSuccess: async (result) => {
      setMessage(result.running ? "Mihomo 已运行" : "Mihomo 未运行");
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const reloadMihomo = trpc.mihomo.reload.useMutation({
    onSuccess: async () => {
      setMessage("Mihomo 已 reload");
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const stopMihomo = trpc.mihomo.stop.useMutation({
    onSuccess: async () => {
      setMessage("Mihomo 已停止");
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });
  const writeExport = trpc.exports.writeSub2api.useMutation({
    onSuccess: async (result) => {
      setMessage(`已导出 ${result.proxies} 个代理`);
      await refreshAll();
    },
    onError: (error) => setMessage(error.message)
  });

  const busy =
    addSubscription.isPending ||
    fetchSubscriptions.isPending ||
    importNodes.isPending ||
    assignPorts.isPending ||
    testNodes.isPending ||
    renderMihomo.isPending ||
    startMihomo.isPending ||
    reloadMihomo.isPending ||
    stopMihomo.isPending ||
    writeExport.isPending;

  const allNodes = nodes.data ?? [];
  const active = allNodes.filter((node) => node.status === "active").length;
  const assigned = allNodes.filter((node) => node.assignedPort).length;
  const failed = allNodes.filter((node) => node.status === "failed").length;
  const activeExports = exportData.data?.proxies.filter((proxy) => proxy.status === "active").length ?? 0;


  if (!authStatus) {
    return <AuthShell title="Mihomo Hive" subtitle="正在检查访问状态" />;
  }

  if (!authStatus.authenticated) {
    return (
      <AuthShell
        title={authStatus.configured ? "登录 Mihomo Hive" : "设置访问密码"}
        subtitle={authStatus.configured ? "输入访问密码继续管理代理池。" : "首次访问需要创建一个访问密码。"}
      >
        <div className="space-y-3">
          <PasswordInput label="密码" value={authPassword} onChange={setAuthPassword} />
          {!authStatus.configured ? <PasswordInput label="确认密码" value={authConfirm} onChange={setAuthConfirm} /> : null}
          <Button
            icon={<ShieldCheck size={16} />}
            label={authStatus.configured ? "登录" : "设置并进入"}
            disabled={!authPassword || (!authStatus.configured && !authConfirm)}
            onClick={submitAuth}
          />
          {authMessage ? <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{authMessage}</div> : null}
        </div>
      </AuthShell>
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold">Mihomo Hive</h1>
            <p className="text-sm text-slate-600">固定出口代理池控制台</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill label={status.data?.running ? "运行中" : "未运行"} tone={status.data?.running ? "ok" : "idle"} />
            <IconLink href="/api/exports/sub2api" label="下载导出" icon={<Download size={16} />} />
            <button className="h-10 rounded-md border border-border px-3 text-sm font-medium text-slate-700" type="button" onClick={logout}>
              登出
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-4 px-6 py-6 md:grid-cols-4">
        <Stat icon={<Server size={18} />} label="Mihomo" value={status.data?.running ? "运行中" : "未运行"} />
        <Stat icon={<Network size={18} />} label="节点总数" value={String(allNodes.length)} />
        <Stat icon={<Activity size={18} />} label="Active 节点" value={String(active)} />
        <Stat icon={<Database size={18} />} label="已分配端口" value={String(assigned)} />
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-6 pb-8 xl:grid-cols-[380px_1fr_360px]">
        <aside className="space-y-4">
          <Panel title="订阅">
            <div className="space-y-3">
              <Input
                label="名称"
                value={subscriptionName}
                onChange={setSubscriptionName}
                placeholder="primary"
              />
              <Input
                label="URL"
                value={subscriptionUrl}
                onChange={setSubscriptionUrl}
                placeholder="https://example.com/sub"
              />
              <Button
                icon={<Plus size={16} />}
                label="添加订阅"
                disabled={busy || !subscriptionName || !subscriptionUrl}
                onClick={() => addSubscription.mutate({ name: subscriptionName, url: subscriptionUrl })}
              />
            </div>
            <div className="mt-4 space-y-2">
              {(subscriptions.data ?? []).map((item) => (
                <div key={item.id} className="rounded-md border border-border px-3 py-2 text-sm">
                  <div className="font-medium">{item.name}</div>
                  <div className="mt-1 truncate font-mono text-xs text-slate-500">{item.value}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {item.fetched ? `${item.lastContentBytes ?? 0} bytes` : "未拉取"}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="流水线">
            <div className="grid gap-2">
              <Button icon={<RefreshCw size={16} />} label="拉取订阅" disabled={busy} onClick={() => fetchSubscriptions.mutate()} />
              <Button icon={<UploadCloud size={16} />} label="导入节点" disabled={busy} onClick={() => importNodes.mutate()} />
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Input label="端口段" value={portRange} onChange={setPortRange} placeholder="10001-10300" />
                <Button
                  icon={<SlidersHorizontal size={16} />}
                  label="分配"
                  disabled={busy}
                  onClick={() => assignPorts.mutate({ range: portRange, skipPortCheck: false })}
                />
              </div>
              <Button
                icon={<ShieldCheck size={16} />}
                label="测试 OpenAI / Claude"
                disabled={busy || assigned === 0}
                onClick={() => testNodes.mutate({ targets: ["openai", "claude"], timeoutMs: 15_000, concurrency: 8 })}
              />
              <Button icon={<FileJson size={16} />} label="生成 Mihomo 配置" disabled={busy} onClick={() => renderMihomo.mutate()} />
              <div className="grid grid-cols-3 gap-2">
                <Button icon={<Play size={16} />} label="启动" disabled={busy} onClick={() => startMihomo.mutate()} />
                <Button icon={<RotateCw size={16} />} label="Reload" disabled={busy} onClick={() => reloadMihomo.mutate()} />
                <Button icon={<StopCircle size={16} />} label="停止" disabled={busy} onClick={() => stopMihomo.mutate()} />
              </div>
              <Button icon={<Download size={16} />} label="写出 Sub2API JSON" disabled={busy} onClick={() => writeExport.mutate()} />
            </div>
            <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{busy ? "处理中..." : message}</div>
          </Panel>
        </aside>

        <section className="overflow-hidden rounded-lg border border-border bg-panel">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="font-medium">节点出口</h2>
            <div className="text-sm text-slate-500">{failed} failed</div>
          </div>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-4 py-2">端口</th>
                  <th className="px-4 py-2">状态</th>
                  <th className="px-4 py-2">地区</th>
                  <th className="px-4 py-2">协议</th>
                  <th className="px-4 py-2">测试</th>
                  <th className="px-4 py-2">名称</th>
                </tr>
              </thead>
              <tbody>
                {allNodes.slice(0, 300).map((node) => (
                  <tr key={node.hash} className="border-t border-border">
                    <td className="px-4 py-2 font-mono">{node.assignedPort ?? "-"}</td>
                    <td className="px-4 py-2">
                      <StatusPill label={node.status} tone={node.status === "active" ? "ok" : node.status === "failed" ? "bad" : "idle"} />
                    </td>
                    <td className="px-4 py-2">{node.region}</td>
                    <td className="px-4 py-2">{node.type}</td>
                    <td className="max-w-[220px] truncate px-4 py-2 font-mono text-xs text-slate-500">
                      {node.lastTestStatus ?? "-"}
                    </td>
                    <td className="max-w-[360px] truncate px-4 py-2">{node.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="space-y-4">
          <Panel title="运行配置">
            <Row label="监听地址" value={config.data?.listenHost ?? "-"} />
            <Row label="导出地址" value={config.data?.exportHost ?? "-"} />
            <Row label="端口段" value={config.data ? `${config.data.portRangeStart}-${config.data.portRangeEnd}` : "-"} />
          </Panel>
          <Panel title="Sub2API">
            <Row label="导出节点" value={String(exportData.data?.proxies.length ?? 0)} />
            <Row label="Active" value={String(activeExports)} />
            <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
              {JSON.stringify(exportData.data?.proxies.slice(0, 3) ?? [], null, 2)}
            </pre>
          </Panel>
          <Panel title="健康检查">
            <Row label="API" value={config.isSuccess ? "ok" : "loading"} />
            <Row label="节点表" value={nodes.isSuccess ? "ok" : "loading"} />
            <Row label="导出预览" value={exportData.isSuccess ? "ok" : "loading"} />
          </Panel>
        </aside>
      </section>
    </main>
  );
}

interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

async function fetchAuthStatus(): Promise<AuthStatus> {
  const response = await fetch("/api/auth/status", { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("Failed to load auth status");
  }
  return (await response.json()) as AuthStatus;
}

function AuthShell(props: { title: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-border bg-panel p-6 shadow-sm">
        <div className="mb-5">
          <h1 className="text-xl font-semibold">{props.title}</h1>
          <p className="mt-1 text-sm text-slate-600">{props.subtitle}</p>
        </div>
        {props.children}
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

function Input(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-600">{props.label}</span>
      <input
        className="h-10 w-full rounded-md border border-border bg-white px-3 font-mono text-sm outline-none focus:border-accent"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
      />
    </label>
  );
}

function PasswordInput(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-600">{props.label}</span>
      <input
        className="h-10 w-full rounded-md border border-border bg-white px-3 text-sm outline-none focus:border-accent"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        type="password"
      />
    </label>
  );
}

function Button(props: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function IconLink(props: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <a
      className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-white"
      href={props.href}
    >
      {props.icon}
      {props.label}
    </a>
  );
}

function StatusPill(props: { label: string; tone: "ok" | "bad" | "idle" }) {
  const className =
    props.tone === "ok"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : props.tone === "bad"
        ? "bg-rose-50 text-rose-700 ring-rose-200"
        : "bg-slate-100 text-slate-700 ring-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ring-1 ${className}`}>
      {props.label}
    </span>
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
