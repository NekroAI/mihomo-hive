import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ConfirmDialog, ToastStack, type ToastMessage } from "./components/ui.js";
import { AuthScreen } from "./features/auth/AuthScreen.js";
import { ExportPanel } from "./features/export/ExportPanel.js";
import { NodeTable } from "./features/nodes/NodeTable.js";
import { canExportNode, defaultNodeFilters, filterNodes, type NodeFilters } from "./features/nodes/node-utils.js";
import { PipelinePanel, type TaskFeedback } from "./features/pipeline/PipelinePanel.js";
import { RuntimeHeader } from "./features/runtime/RuntimeHeader.js";
import { fetchAuthStatus, logout, type AuthStatus } from "./lib/auth.js";
import { useLocalStorageState } from "./lib/persistence.js";
import { queryClient, trpc, trpcClient } from "./lib/trpc.js";

export function AppRoot() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function App() {
  const utils = trpc.useUtils();
  const [authStatus, setAuthStatus] = React.useState<AuthStatus | undefined>();
  const authenticated = Boolean(authStatus?.authenticated);

  const refreshAuth = React.useCallback(async () => {
    setAuthStatus(await fetchAuthStatus());
  }, []);

  React.useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  async function handleAuthenticated() {
    await refreshAuth();
    await utils.invalidate();
  }

  async function handleLogout() {
    await logout();
    queryClient.clear();
    await refreshAuth();
  }

  if (!authStatus || !authenticated) {
    return <AuthScreen status={authStatus} onAuthenticated={handleAuthenticated} />;
  }

  return <Dashboard onLogout={handleLogout} />;
}

function Dashboard(props: { onLogout: () => void }) {
  const utils = trpc.useUtils();
  const config = trpc.runtime.config.useQuery();
  const runtimeStatus = trpc.runtime.status.useQuery(undefined, { refetchInterval: 5000 });
  const subscriptions = trpc.subscriptions.list.useQuery();
  const nodes = trpc.nodes.list.useQuery();

  const [subscriptionName, setSubscriptionName] = React.useState("");
  const [subscriptionUrl, setSubscriptionUrl] = React.useState("");
  const [portRange, setPortRange] = React.useState("10001-10300");
  const [exportHost, setExportHost] = React.useState("127.0.0.1");
  const [exportFilename, setExportFilename] = React.useState("sub2api-proxies.json");
  const [filters, setFilters] = useLocalStorageState<NodeFilters>("mihomo-hive.node-filters", defaultNodeFilters);
  const [selectedHashesList, setSelectedHashesList] = useLocalStorageState<string[]>("mihomo-hive.selected-hashes", []);
  const selectedHashes = React.useMemo(() => new Set(selectedHashesList), [selectedHashesList]);
  const [task, setTask] = React.useState<TaskFeedback>({
    state: "idle",
    title: "等待操作",
    detail: "从左侧任务流开始，先添加或拉取订阅。"
  });
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const [confirmAction, setConfirmAction] = React.useState<ConfirmAction | undefined>();
  const [downloading, setDownloading] = React.useState(false);

  React.useEffect(() => {
    if (config.data) {
      setPortRange(`${config.data.portRangeStart}-${config.data.portRangeEnd}`);
      setExportHost(config.data.exportHost);
    }
  }, [config.data]);

  const allNodes = nodes.data ?? [];
  const filteredNodes = React.useMemo(() => filterNodes(allNodes, filters), [allNodes, filters]);
  const activeCount = allNodes.filter((node) => node.status === "active").length;
  const assignedCount = allNodes.filter((node) => node.assignedPort).length;
  const exportableSelectedCount = allNodes.filter((node) => selectedHashes.has(node.hash) && canExportNode(node)).length;
  const sourceNames = React.useMemo(
    () => new Map((subscriptions.data ?? []).map((source) => [source.id, source.name])),
    [subscriptions.data]
  );

  const exportPreview = trpc.exports.previewSub2api.useQuery(
    {
      selectedHashes: selectedHashesList,
      host: exportHost,
      filename: exportFilename
    },
    { enabled: selectedHashesList.length > 0 }
  );

  const refreshOperationalData = React.useCallback(async () => {
    await Promise.all([
      utils.subscriptions.list.invalidate(),
      utils.nodes.list.invalidate(),
      utils.runtime.status.invalidate(),
      utils.exports.previewSub2api.invalidate()
    ]);
  }, [utils]);

  const addSubscription = trpc.subscriptions.add.useMutation({
    onMutate: () => startTask(setTask, "正在添加订阅", "保存订阅源，稍后可继续拉取节点。"),
    onSuccess: async () => {
      setSubscriptionName("");
      setSubscriptionUrl("");
      await finishTask(setTask, pushToast, "订阅已添加", "可以继续拉取订阅内容。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "订阅添加失败", error.message)
  });
  const fetchSubscriptions = trpc.subscriptions.fetch.useMutation({
    onMutate: () => startTask(setTask, "正在拉取订阅", "正在请求已启用订阅源，完成后会显示字节数。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "订阅拉取完成", `成功拉取 ${result.length} 个订阅源。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "订阅拉取失败", error.message)
  });
  const importNodes = trpc.nodes.import.useMutation({
    onMutate: () => startTask(setTask, "正在导入节点", "正在解析 Clash YAML 或 base64 订阅内容。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "节点导入完成", `导入或更新 ${result.imported} 个节点。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "节点导入失败", error.message)
  });
  const assignPorts = trpc.nodes.assignPorts.useMutation({
    onMutate: () => startTask(setTask, "正在分配端口", `端口段 ${portRange}，会保留已有稳定端口。`),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "端口分配完成", `已分配 ${result.assigned} 个端口，跳过 ${result.occupied} 个占用端口。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "端口分配失败", error.message)
  });
  const testNodes = trpc.nodes.test.useMutation({
    onMutate: () => startTask(setTask, "正在批量测试", "正在使用 OpenAI / Claude 目标检查本地 listener 可用性。"),
    onSuccess: async (result) => {
      const tone = result.failed > 0 ? "warning" : "success";
      setTask({
        state: result.failed > 0 ? "success" : "success",
        title: "批量测试完成",
        detail: `测试 ${result.tested} 个节点，通过 ${result.passed} 个，失败 ${result.failed} 个。`
      });
      pushToast(tone, "批量测试完成", `通过 ${result.passed}/${result.tested}。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "批量测试失败", error.message)
  });
  const renderMihomo = trpc.mihomo.render.useMutation({
    onMutate: () => startTask(setTask, "正在生成 Mihomo 配置", "只会渲染可用且已分配端口的节点。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Mihomo 配置已生成", `生成 ${result.listeners} 个 listener。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Mihomo 配置生成失败", error.message)
  });
  const startMihomo = trpc.mihomo.start.useMutation({
    onMutate: () => startTask(setTask, "正在启动 Mihomo", "服务会在后台保持运行。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, result.running ? "Mihomo 已运行" : "Mihomo 未运行", result.pid ? `PID ${result.pid}` : "未获取到 PID。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Mihomo 启动失败", error.message)
  });
  const reloadMihomo = trpc.mihomo.reload.useMutation({
    onMutate: () => startTask(setTask, "正在重载 Mihomo", "会向当前 Mihomo 进程发送 reload 信号。"),
    onSuccess: async () => {
      await finishTask(setTask, pushToast, "Mihomo 已重载", "配置变更已提交给运行进程。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Mihomo 重载失败", error.message)
  });
  const stopMihomo = trpc.mihomo.stop.useMutation({
    onMutate: () => startTask(setTask, "正在停止 Mihomo", "正在停止后台 Mihomo 进程。"),
    onSuccess: async () => {
      await finishTask(setTask, pushToast, "Mihomo 已停止", "本地出口 listener 已关闭。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Mihomo 停止失败", error.message)
  });
  const writeExport = trpc.exports.writeSub2api.useMutation({
    onMutate: () => startTask(setTask, "正在写入 Sub2API JSON", `将 ${exportableSelectedCount} 个可导出节点写入服务器文件。`),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Sub2API JSON 已写入", `${result.proxies} 个代理已写入 ${result.output}。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Sub2API 写入失败", error.message)
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
    writeExport.isPending ||
    downloading;

  function pushToast(tone: ToastMessage["tone"], title: string, detail?: string) {
    const id = crypto.randomUUID();
    setToasts((items) => [...items.slice(-3), { id, tone, title, detail }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 5000);
  }

  function mutateSelection(updater: (current: Set<string>) => Set<string>) {
    setSelectedHashesList((current) => Array.from(updater(new Set(current))));
  }

  function requestConfirmation(action: ConfirmAction) {
    setConfirmAction(action);
  }

  async function runConfirmedAction() {
    const action = confirmAction;
    if (!action) {
      return;
    }
    setConfirmAction(undefined);
    await action.run();
  }

  async function downloadExport() {
    setDownloading(true);
    startTask(setTask, "正在准备下载", `将下载 ${exportableSelectedCount} 个可导出节点。`);
    try {
      const response = await fetch("/api/exports/sub2api/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          selectedHashes: selectedHashesList,
          host: exportHost,
          filename: exportFilename
        })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFilename.endsWith(".json") ? exportFilename : `${exportFilename}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      await finishTask(setTask, pushToast, "下载已触发", `浏览器正在下载 ${link.download}。`);
    } catch (error) {
      failTask(setTask, pushToast, "下载失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main className="app-shell">
      <RuntimeHeader
        running={Boolean(runtimeStatus.data?.running)}
        nodes={allNodes.length}
        active={activeCount}
        assigned={assignedCount}
        onLogout={props.onLogout}
      />
      <section className="app-grid">
        <PipelinePanel
          subscriptions={subscriptions.data ?? []}
          subscriptionName={subscriptionName}
          subscriptionUrl={subscriptionUrl}
          portRange={portRange}
          filteredCount={filteredNodes.length}
          selectedCount={selectedHashes.size}
          assignedCount={assignedCount}
          canTest={assignedCount > 0}
          canRender={activeCount > 0}
          task={task}
          busy={busy}
          onSubscriptionNameChange={setSubscriptionName}
          onSubscriptionUrlChange={setSubscriptionUrl}
          onPortRangeChange={setPortRange}
          onAddSubscription={() => addSubscription.mutate({ name: subscriptionName, url: subscriptionUrl })}
          onFetch={() => fetchSubscriptions.mutate()}
          onImport={() => importNodes.mutate()}
          onAssignPorts={() =>
            requestConfirmation({
              title: "确认分配端口",
              description: `将按 ${portRange} 为可用或未测试节点分配稳定端口。`,
              detail: `当前数据库共有 ${allNodes.length} 个节点，已分配 ${assignedCount} 个端口。`,
              confirmLabel: "开始分配",
              run: async () => assignPorts.mutate({ range: portRange, skipPortCheck: false })
            })
          }
          onTest={() =>
            requestConfirmation({
              title: "确认批量测试",
              description: "将测试所有已分配端口的节点，并把失败节点标记为失败。",
              detail: `当前已分配端口 ${assignedCount} 个，测试目标为 OpenAI / Claude。`,
              confirmLabel: "开始测试",
              run: async () => testNodes.mutate({ targets: ["openai", "claude"], timeoutMs: 15_000, concurrency: 8 })
            })
          }
          onRender={() =>
            requestConfirmation({
              title: "确认生成 Mihomo 配置",
              description: "将重新生成 Mihomo 配置文件，只包含可用且已分配端口的节点。",
              detail: `预计 listener 数量为 ${allNodes.filter(canExportNode).length}。`,
              confirmLabel: "生成配置",
              run: async () => renderMihomo.mutate()
            })
          }
          onStart={() => startMihomo.mutate()}
          onReload={() =>
            requestConfirmation({
              title: "确认重载 Mihomo",
              description: "会向当前 Mihomo 进程发送 reload 信号。",
              detail: "请确认配置文件已经生成。",
              confirmLabel: "重载",
              run: async () => reloadMihomo.mutate()
            })
          }
          onStop={() =>
            requestConfirmation({
              title: "确认停止 Mihomo",
              description: "停止后本机出口 listener 会关闭。",
              detail: "Sub2API 继续使用这些端口时会连接失败。",
              confirmLabel: "停止",
              dangerous: true,
              run: async () => stopMihomo.mutate()
            })
          }
        />

        <NodeTable
          nodes={allNodes}
          filteredNodes={filteredNodes}
          filters={filters}
          sourceNames={sourceNames}
          selectedHashes={selectedHashes}
          onFiltersChange={setFilters}
          onToggleNode={(hash, selected) =>
            mutateSelection((current) => {
              if (selected) {
                current.add(hash);
              } else {
                current.delete(hash);
              }
              return current;
            })
          }
          onSelectFiltered={(exportableOnly) =>
            mutateSelection((current) => {
              for (const node of filteredNodes) {
                if (!exportableOnly || canExportNode(node)) {
                  current.add(node.hash);
                }
              }
              return current;
            })
          }
          onInvertFiltered={() =>
            mutateSelection((current) => {
              for (const node of filteredNodes) {
                if (current.has(node.hash)) {
                  current.delete(node.hash);
                } else {
                  current.add(node.hash);
                }
              }
              return current;
            })
          }
          onClearSelection={() => setSelectedHashesList([])}
        />

        <ExportPanel
          host={exportHost}
          filename={exportFilename}
          selectedCount={selectedHashes.size}
          preview={exportPreview.data}
          loading={exportPreview.isFetching}
          writing={writeExport.isPending}
          downloading={downloading}
          onHostChange={setExportHost}
          onFilenameChange={setExportFilename}
          onDownload={downloadExport}
          onWrite={() =>
            requestConfirmation({
              title: "确认写入服务器文件",
              description: `将把 ${exportableSelectedCount} 个可导出节点写入 generated/sub2api-proxies.json。`,
              detail: "非可用或无端口节点不会进入文件。",
              confirmLabel: "写入文件",
              run: async () =>
                writeExport.mutate({
                  selectedHashes: selectedHashesList,
                  host: exportHost,
                  filename: exportFilename
                })
            })
          }
        />
      </section>

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title ?? ""}
        description={confirmAction?.description ?? ""}
        detail={confirmAction?.detail}
        confirmLabel={confirmAction?.confirmLabel ?? "确认"}
        dangerous={confirmAction?.dangerous}
        loading={busy}
        onCancel={() => setConfirmAction(undefined)}
        onConfirm={runConfirmedAction}
      />
      <ToastStack messages={toasts} onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    </main>
  );
}

interface ConfirmAction {
  title: string;
  description: string;
  detail?: React.ReactNode;
  confirmLabel: string;
  dangerous?: boolean;
  run: () => Promise<void>;
}

function startTask(setTask: React.Dispatch<React.SetStateAction<TaskFeedback>>, title: string, detail: string) {
  setTask({ state: "pending", title, detail, startedAt: Date.now() });
}

async function finishTask(
  setTask: React.Dispatch<React.SetStateAction<TaskFeedback>>,
  pushToast: (tone: ToastMessage["tone"], title: string, detail?: string) => void,
  title: string,
  detail: string
) {
  setTask({ state: "success", title, detail });
  pushToast("success", title, detail);
}

function failTask(
  setTask: React.Dispatch<React.SetStateAction<TaskFeedback>>,
  pushToast: (tone: ToastMessage["tone"], title: string, detail?: string) => void,
  title: string,
  detail: string
) {
  setTask({ state: "error", title, detail, technical: detail });
  pushToast("danger", title, detail);
}
