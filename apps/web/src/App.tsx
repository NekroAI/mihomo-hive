import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ConfirmDialog, ToastStack, type ToastMessage } from "./components/ui.js";
import { AuthScreen } from "./features/auth/AuthScreen.js";
import { canExportNode, defaultNodeFilters, filterNodes, type NodeFilters } from "./features/nodes/node-utils.js";
import { RuntimeHeader } from "./features/runtime/RuntimeHeader.js";
import { AdminRoute } from "./routes/AdminRoute.js";
import { AutomationRoute } from "./routes/AutomationRoute.js";
import { NodesRoute } from "./routes/NodesRoute.js";
import { useTaskFeedback, type TaskFeedback } from "./hooks/useTaskFeedback.js";
import { useConfirmAction, type ConfirmAction } from "./hooks/useConfirmAction.js";
import { fetchAuthStatus, logout, type AuthStatus } from "./lib/auth.js";
import { useLocalStorageState } from "./lib/persistence.js";
import { queryClient, trpc, trpcClient } from "./lib/trpc.js";
import type { NodeDeletionPlan, Sub2ApiAccountFilters, Sub2ApiProtectedProxyRule, SubscriptionImportPreview } from "@mihomo-hive/schemas";

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
  const sub2apiConfig = trpc.sub2api.config.get.useQuery();
  const sub2apiProtectedRule = trpc.sub2api.proxies.protectedRule.useQuery();

  const [subscriptionName, setSubscriptionName] = React.useState("");
  const [subscriptionUrl, setSubscriptionUrl] = React.useState("");
  const [subscriptionKeywords, setSubscriptionKeywords] = React.useState("");
  const [portRange, setPortRange] = React.useState("10001-10300");
  const [exportHost, setExportHost] = React.useState("127.0.0.1");
  const [exportFilename, setExportFilename] = React.useState("sub2api-proxies.json");
  const [failedNodeStatus, setFailedNodeStatus] = React.useState<"active" | "inactive">("inactive");
  const [sub2apiBaseUrl, setSub2apiBaseUrl] = React.useState("");
  const [sub2apiApiKey, setSub2apiApiKey] = React.useState("");
  const [sub2apiTimezone, setSub2apiTimezone] = React.useState("Asia/Shanghai");
  const [sub2apiManagedPrefix, setSub2apiManagedPrefix] = React.useState("MH-");
  const [sub2apiFilters, setSub2apiFilters] = useLocalStorageState<Sub2ApiAccountFilters>("mihomo-hive.sub2api-filters", {
    platform: "openai",
    type: "",
    status: "active",
    privacyMode: "",
    group: "",
    search: ""
  });
  const [sub2apiProtected, setSub2apiProtected] = useLocalStorageState<Sub2ApiProtectedProxyRule>("mihomo-hive.sub2api-protected", {
    proxyIds: [],
    nameIncludes: "",
    hostIncludes: "",
    countryIncludes: "",
    regionIncludes: "",
    status: ""
  });
  const [sub2apiOverwrite, setSub2apiOverwrite] = React.useState(false);
  const [errorSummaryTimeRange, setErrorSummaryTimeRange] = useLocalStorageState<string>(
    "mihomo-hive.upstream-error-window",
    "1h"
  );
  const [workspaceRaw, setWorkspace] = useLocalStorageState<"nodes" | "automation" | "runtime">(
    "mihomo-hive.workspace",
    "nodes"
  );
  // 兼容旧 localStorage 值 "sub2api" / "tasks"，统一映射到 "automation"
  const workspace: "nodes" | "automation" | "runtime" =
    (workspaceRaw as string) === "sub2api" || (workspaceRaw as string) === "tasks" ? "automation" : workspaceRaw;
  const [filters, setFilters] = useLocalStorageState<NodeFilters>("mihomo-hive.node-filters", defaultNodeFilters);
  const [selectedHashesList, setSelectedHashesList] = useLocalStorageState<string[]>("mihomo-hive.selected-hashes", []);
  const selectedHashes = React.useMemo(() => new Set(selectedHashesList), [selectedHashesList]);
  const feedback = useTaskFeedback();
  const { task, setTask, toasts, pushToast, dismissToast } = feedback;
  const confirm = useConfirmAction();
  const confirmAction = confirm.current;
  const [downloading, setDownloading] = React.useState(false);
  const [importPreview, setImportPreview] = React.useState<SubscriptionImportPreview | undefined>();
  const [deletePlan, setDeletePlan] = React.useState<NodeDeletionPlan | undefined>();

  React.useEffect(() => {
    if (config.data) {
      setPortRange(`${config.data.portRangeStart}-${config.data.portRangeEnd}`);
      setExportHost(config.data.exportHost);
    }
  }, [config.data]);

  React.useEffect(() => {
    if (sub2apiConfig.data?.baseUrl) {
      setSub2apiBaseUrl(sub2apiConfig.data.baseUrl);
      setSub2apiTimezone(sub2apiConfig.data.timezone ?? "Asia/Shanghai");
      setSub2apiManagedPrefix(sub2apiConfig.data.managedProxyPrefix ?? "MH-");
    }
  }, [sub2apiConfig.data]);

  React.useEffect(() => {
    if (sub2apiProtectedRule.data) {
      setSub2apiProtected(sub2apiProtectedRule.data);
    }
  }, [sub2apiProtectedRule.data, setSub2apiProtected]);

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
      filename: exportFilename,
      failedNodeStatus
    },
    { enabled: selectedHashesList.length > 0 }
  );
  const sub2apiProxies = trpc.sub2api.proxies.list.useQuery(undefined, {
    enabled: Boolean(sub2apiConfig.data?.configured)
  });
  const sub2apiPreview = trpc.sub2api.assign.preview.useQuery(
    {
      filters: sub2apiFilters,
      protectedRule: sub2apiProtected,
      overwriteExisting: sub2apiOverwrite
    },
    { enabled: Boolean(sub2apiConfig.data?.configured) }
  );
  const sub2apiMaintenance = trpc.sub2api.maintenance.preview.useQuery(undefined, {
    enabled: Boolean(sub2apiConfig.data?.configured)
  });
  const jobs = trpc.sub2api.jobs.list.useQuery(undefined, {
    enabled: workspace === "automation" || workspace === "runtime",
    refetchInterval: 3000
  });
  const upstreamErrorSummary = trpc.sub2api.automation.upstreamErrorSummary.useQuery(
    { timeRange: errorSummaryTimeRange },
    { enabled: workspace === "automation" && Boolean(sub2apiConfig.data?.configured), refetchInterval: 30000 }
  );

  const refreshOperationalData = React.useCallback(async () => {
    await Promise.all([
      utils.subscriptions.list.invalidate(),
      utils.nodes.list.invalidate(),
      utils.runtime.status.invalidate(),
      utils.exports.previewSub2api.invalidate(),
      utils.sub2api.config.get.invalidate(),
      utils.sub2api.proxies.list.invalidate(),
      utils.sub2api.proxies.protectedRule.invalidate(),
      utils.sub2api.assign.preview.invalidate(),
      utils.sub2api.maintenance.preview.invalidate()
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
  const previewImport = trpc.subscriptions.previewImport.useMutation({
    onMutate: () => startTask(setTask, "正在拉取并预览订阅", "系统会先展示将导入、过滤和重复的节点。"),
    onSuccess: async (result) => {
      setImportPreview(result);
      await finishTask(setTask, pushToast, "订阅预览完成", `解析 ${result.summary.total} 个节点，可导入 ${result.summary.importable} 个。`);
    },
    onError: (error) => failTask(setTask, pushToast, "订阅预览失败", error.message)
  });
  const applyImportPreview = trpc.subscriptions.applyImport.useMutation({
    onMutate: () => startTask(setTask, "正在导入预览结果", "只会导入预览中标记为导入或更新的节点。"),
    onSuccess: async (result) => {
      setImportPreview(undefined);
      await finishTask(setTask, pushToast, "节点已重新导入", `导入或更新 ${result.imported} 个节点，按过滤规则删除 ${result.deletedByFilter} 个旧节点。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "节点导入失败", error.message)
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
  const updateSubscriptionFilters = trpc.subscriptions.updateFilters.useMutation({
    onSuccess: async () => {
      pushToast("success", "订阅过滤已保存", "下次导入节点时会应用这些过滤关键词。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "订阅过滤保存失败", error.message)
  });
  const deleteSubscription = trpc.subscriptions.delete.useMutation({
    onMutate: () => startTask(setTask, "正在删除订阅", "会同时删除该订阅导入的节点。"),
    onSuccess: async () => {
      await finishTask(setTask, pushToast, "订阅已删除", "关联节点已从本地数据库移除。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "订阅删除失败", error.message)
  });
  const assignPorts = trpc.nodes.assignPorts.useMutation({
    onMutate: () => startTask(setTask, "正在分配端口", `为已启用调度的节点分配端口（${portRange}）。新导入的候选节点不会自动获得端口。`),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "端口分配完成", `已分配 ${result.assigned} 个端口，跳过 ${result.occupied} 个占用端口。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "端口分配失败", error.message)
  });
  const setNodeLifecycle = trpc.nodes.setLifecycle.useMutation({
    onMutate: () => startTask(setTask, "正在更新节点调度状态", "系统会调整所选节点的生命周期状态。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "节点调度状态已更新", `更新 ${result.updated} 个节点。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "节点调度状态更新失败", error.message)
  });
  const deleteNodes = trpc.nodes.applyDelete.useMutation({
    onMutate: () => startTask(setTask, "正在删除节点", "删除前会校验 Sub2API 账号依赖。"),
    onSuccess: async (result) => {
      setDeletePlan(undefined);
      mutateSelection(() => new Set());
      await finishTask(setTask, pushToast, "节点已删除", `删除 ${result.deleted} 个节点。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "节点删除失败", error.message)
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
  const publishRuntime = trpc.runtime.publish.useMutation({
    onMutate: () => startTask(setTask, "正在发布出口池", "系统会生成配置并自动启动或重载 Mihomo。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "出口池发布完成", `发布 ${result.listeners} 个 listener。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "出口池发布失败", error.message)
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
  const saveSub2apiConfig = trpc.sub2api.config.save.useMutation({
    onMutate: () => startTask(setTask, "正在保存 Sub2API 配置", "API Key 只会保存在服务端，不会回显到前端。"),
    onSuccess: async () => {
      setSub2apiApiKey("");
      await finishTask(setTask, pushToast, "Sub2API 配置已保存", "可以继续测试连接并拉取代理与账号。");
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Sub2API 配置保存失败", error.message)
  });
  const testSub2apiConnection = trpc.sub2api.config.test.useMutation({
    onMutate: () => startTask(setTask, "正在测试 Sub2API 连接", "使用 x-api-key 拉取代理与账号摘要。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Sub2API 连接正常", `代理 ${result.proxies} 个，账号 ${result.accounts} 个。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Sub2API 连接失败", error.message)
  });
  const syncSub2api = trpc.sub2api.sync.useMutation({
    onMutate: () => startTask(setTask, "正在同步 Sub2API", "系统会读取代理和账号，并识别 Hive 管理的代理。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Sub2API 已同步", `代理 ${result.proxies} 个，账号 ${result.accounts} 个，匹配本地节点 ${result.matchedLocalNodes} 个。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Sub2API 同步失败", error.message)
  });
  const saveProtectedRule = trpc.sub2api.proxies.saveProtectedRule.useMutation({
    onError: (error) => pushToast("danger", "保护节点保存失败", error.message)
  });
  const applySub2apiAssignments = trpc.sub2api.assign.applyChanges.useMutation({
    onMutate: () => startTask(setTask, "正在应用 Sub2API 绑定", "服务端会重新拉取账号和代理并执行批量更新。"),
    onSuccess: async (result) => {
      await finishTask(
        setTask,
        pushToast,
        "Sub2API 绑定已应用",
        `成功 ${result.success} 个，失败 ${result.failed} 个，保护 ${result.preview.summary.protectedAccounts} 个账号。`
      );
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Sub2API 绑定失败", error.message)
  });
  const drainManagedSub2api = trpc.sub2api.maintenance.drainManaged.useMutation({
    onMutate: () => startTask(setTask, "正在排空 Hive 托管代理", "会把绑定到 Hive 代理的账号迁移到非保护代理。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Hive 托管代理已排空", `迁移 ${result.reassigned} 个账号，失败 ${result.failedReassign} 个。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Hive 托管代理排空失败", error.message)
  });
  const cleanupManagedSub2api = trpc.sub2api.maintenance.cleanupEmpty.useMutation({
    onMutate: () => startTask(setTask, "正在清理 Hive 空代理", "只会删除名称带托管前缀且没有账号使用的代理。"),
    onSuccess: async (result) => {
      await finishTask(setTask, pushToast, "Hive 空代理清理完成", `删除 ${result.deletedProxies} 个代理，失败 ${result.failedDeleteProxies.length} 个。`);
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "Hive 空代理清理失败", error.message)
  });
  const pushManagedSub2api = trpc.sub2api.automation.syncManagedProxies.useMutation({
    onMutate: () =>
      startTask(setTask, "正在推送本地节点到 Sub2API", "通过 importProxyData 把 Hive 节点上行同步并回填 proxy_id。"),
    onSuccess: async (result) => {
      await finishTask(
        setTask,
        pushToast,
        "本地节点已推送 Sub2API",
        `新增 ${result.summary.proxy_created}，复用 ${result.summary.proxy_reused}，失败 ${result.summary.proxy_failed}；映射 ${result.mappedNodes} 个本地节点。`
      );
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "上行同步失败", error.message)
  });
  const qualityCheckManaged = trpc.sub2api.automation.qualityCheckManaged.useMutation({
    onMutate: () =>
      startTask(setTask, "正在对 Hive 托管代理执行质量检查", "对每个托管代理调用 quality-check 并回填分数。"),
    onSuccess: async (result) => {
      await finishTask(
        setTask,
        pushToast,
        "质量检查完成",
        `${result.passed}/${result.total} 通过；更新 ${result.updatedLocalNodes} 个本地节点的 qualityScore。`
      );
      await refreshOperationalData();
    },
    onError: (error) => failTask(setTask, pushToast, "质量检查失败", error.message)
  });

  const busy =
    addSubscription.isPending ||
    previewImport.isPending ||
    applyImportPreview.isPending ||
    fetchSubscriptions.isPending ||
    importNodes.isPending ||
    assignPorts.isPending ||
    setNodeLifecycle.isPending ||
    deleteNodes.isPending ||
    updateSubscriptionFilters.isPending ||
    deleteSubscription.isPending ||
    testNodes.isPending ||
    renderMihomo.isPending ||
    publishRuntime.isPending ||
    startMihomo.isPending ||
    reloadMihomo.isPending ||
    stopMihomo.isPending ||
    writeExport.isPending ||
    saveSub2apiConfig.isPending ||
    testSub2apiConnection.isPending ||
    applySub2apiAssignments.isPending ||
    syncSub2api.isPending ||
    pushManagedSub2api.isPending ||
    qualityCheckManaged.isPending ||
    drainManagedSub2api.isPending ||
    cleanupManagedSub2api.isPending ||
    downloading;

  function mutateSelection(updater: (current: Set<string>) => Set<string>) {
    setSelectedHashesList((current) => Array.from(updater(new Set(current))));
  }

  const requestConfirmation = confirm.request;

  function updateProtectedRule(rule: Sub2ApiProtectedProxyRule) {
    setSub2apiProtected(rule);
    if (sub2apiConfig.data?.configured) {
      saveProtectedRule.mutate(rule);
    }
  }

  function keywordList() {
    return subscriptionKeywords
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async function previewSelectedDeletePlan() {
    if (selectedHashesList.length === 0) {
      return;
    }
    startTask(setTask, "正在生成删除计划", "系统会检查 Sub2API 中是否仍有账号使用这些代理。");
    try {
      const plan = await utils.nodes.previewDelete.fetch({ hashes: selectedHashesList });
      setDeletePlan(plan);
      setTask({ state: "success", title: "删除计划已生成", detail: plan.message });
    } catch (error) {
      failTask(setTask, pushToast, "删除计划生成失败", error instanceof Error ? error.message : "未知错误");
    }
  }

  const runConfirmedAction = confirm.resolve;

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
          filename: exportFilename,
          failedNodeStatus
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
      <nav className="workspace-nav" aria-label="工作区">
        <button className={workspace === "nodes" ? "is-active" : ""} type="button" onClick={() => setWorkspace("nodes")}>
          节点池
        </button>
        <button className={workspace === "automation" ? "is-active" : ""} type="button" onClick={() => setWorkspace("automation")}>
          自动化
        </button>
        <button className={workspace === "runtime" ? "is-active" : ""} type="button" onClick={() => setWorkspace("runtime")}>
          高级运维
        </button>
      </nav>

      {workspace === "nodes" ? (
        <NodesRoute
          subscriptions={subscriptions.data ?? []}
          allNodes={allNodes}
          filteredNodes={filteredNodes}
          selectedHashes={selectedHashes}
          selectedHashesList={selectedHashesList}
          setSelectedHashesList={setSelectedHashesList}
          filters={filters}
          setFilters={setFilters}
          sourceNames={sourceNames}
          importPreview={importPreview}
          setImportPreview={setImportPreview}
          deletePlan={deletePlan}
          setDeletePlan={setDeletePlan}
          subscriptionName={subscriptionName}
          setSubscriptionName={setSubscriptionName}
          subscriptionUrl={subscriptionUrl}
          setSubscriptionUrl={setSubscriptionUrl}
          subscriptionKeywords={subscriptionKeywords}
          setSubscriptionKeywords={setSubscriptionKeywords}
          parseKeywords={keywordList}
          busy={busy}
          mutateSelection={mutateSelection}
          previewSelectedDeletePlan={previewSelectedDeletePlan}
          requestConfirmation={requestConfirmation}
          mutations={{
            addSubscription,
            previewImport,
            applyImport: applyImportPreview,
            setLifecycle: setNodeLifecycle,
            deleteNodes,
            testNodes,
            publishRuntime,
            deleteSubscription
          }}
        />
      ) : null}

      {workspace === "automation" ? (
        <AutomationRoute
          config={sub2apiConfig.data}
          baseUrl={sub2apiBaseUrl}
          apiKey={sub2apiApiKey}
          timezone={sub2apiTimezone}
          managedPrefix={sub2apiManagedPrefix}
          filters={sub2apiFilters}
          protectedRule={sub2apiProtected}
          overwriteExisting={sub2apiOverwrite}
          proxies={sub2apiProxies.data ?? []}
          proxiesFetching={sub2apiProxies.isFetching}
          preview={sub2apiPreview.data}
          previewFetching={sub2apiPreview.isFetching}
          maintenance={sub2apiMaintenance.data}
          maintenanceFetching={sub2apiMaintenance.isFetching}
          jobs={jobs.data ?? []}
          jobsLoading={jobs.isFetching}
          errorSummary={upstreamErrorSummary.data}
          errorSummaryLoading={upstreamErrorSummary.isFetching}
          errorTimeRange={errorSummaryTimeRange}
          setBaseUrl={setSub2apiBaseUrl}
          setApiKey={setSub2apiApiKey}
          setTimezone={setSub2apiTimezone}
          setManagedPrefix={setSub2apiManagedPrefix}
          setFilters={setSub2apiFilters}
          setOverwriteExisting={setSub2apiOverwrite}
          onProtectedRuleChange={updateProtectedRule}
          setErrorTimeRange={setErrorSummaryTimeRange}
          refetchProxies={() => void sub2apiProxies.refetch()}
          refetchPreview={() => void sub2apiPreview.refetch()}
          refetchMaintenance={() => void sub2apiMaintenance.refetch()}
          refetchJobs={() => void jobs.refetch()}
          refetchErrorSummary={() => void upstreamErrorSummary.refetch()}
          requestConfirmation={requestConfirmation}
          mutations={{
            saveConfig: saveSub2apiConfig,
            testConnection: testSub2apiConnection,
            sync: syncSub2api,
            apply: applySub2apiAssignments,
            drainManaged: drainManagedSub2api,
            cleanupEmpty: cleanupManagedSub2api,
            pushManaged: pushManagedSub2api,
            qualityCheck: qualityCheckManaged
          }}
        />
      ) : null}

      {workspace === "runtime" ? (
        <AdminRoute
          exportHost={exportHost}
          exportFilename={exportFilename}
          failedNodeStatus={failedNodeStatus}
          selectedCount={selectedHashes.size}
          exportableSelectedCount={exportableSelectedCount}
          selectedHashesList={selectedHashesList}
          activeCount={activeCount}
          busy={busy}
          mihomoRunning={Boolean(runtimeStatus.data?.running)}
          exportPreview={exportPreview.data}
          exportPreviewFetching={exportPreview.isFetching}
          downloading={downloading}
          setExportHost={setExportHost}
          setExportFilename={setExportFilename}
          setFailedNodeStatus={setFailedNodeStatus}
          onDownload={downloadExport}
          requestConfirmation={requestConfirmation}
          mutations={{ writeExport, publishRuntime, startMihomo, reloadMihomo, stopMihomo }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title ?? ""}
        description={confirmAction?.description ?? ""}
        detail={confirmAction?.detail}
        confirmLabel={confirmAction?.confirmLabel ?? "确认"}
        dangerous={confirmAction?.dangerous}
        loading={busy}
        onCancel={confirm.cancel}
        onConfirm={runConfirmedAction}
      />
      <ToastStack messages={toasts} onDismiss={dismissToast} />
    </main>
  );
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
