# 数据模型

重要 schema 位于 `packages/schemas`。

## 运行配置 & 节点

- `RuntimeConfig`：监听地址、导出地址、端口段、路径和 Mihomo binary 配置。
- `ProxyNode`：标准化后的订阅节点，含稳定 hash、原始 Clash 配置、测试状态、生命周期、调度开关、分配端口；外加 ADR 0003 编排字段：`intentRole / backoffUntil / backoffAttempts / healthScore / lastHealthCheck`。
- `NodeLifecycleStatus`：候选 / testing / 可调度 / 暂停 / 排空 / 冷却 / 退役 / 删除。
- `NodeIntentRole`（ADR 0003）：serving / standby / quarantined / evicted。reconcile 自动维护，决定节点是否参与账号分配。
- `SubscriptionImportPreview`：订阅拉取后的预览结果，含 import / update / skip_duplicate / skip_existing / skip_filtered 动作分类 + `deletesExisting` 标记。
- `NodeDeletionPlan`：节点删除前的影响面（Sub2API 阻塞账号）。
- `FilterProfile`：筛选节点的包含/排除规则。

## 声明式编排 (ADR 0003)

- `OrchestrationSpec`：用户唯一编辑的"期望"对象。含 5 类策略：
  - `supply`：订阅刷新周期、入池门槛（maxLatencyMs / minQualityScore）、退役天数
  - `capacity`：targetPerNode（auto/manual）、overload/underload 比例、硬上限
  - `stickiness`：hash 策略（stable-hash / rendezvous-hash）、再平衡阈值、单 tick 迁移上限
  - `health`：错误预算 / 窗口长度 / backoff 序列 / 永久驱逐次数
  - `intake`：入站代理 proxyId + 灰度阀绕过开关
  外加 `enabled`（火警开关）、`reconcileIntervalMs`、`graceBatchPercent / Abs`、`protectedRule`。
- `ProxyHealthSignal`：reconcile 输入信号（每个 proxy 窗口内错误条数）。
- `ReconcilePlannedChange`：单条变更（kind ∈ drain_intake / bind_missing / rebind_dead / rebalance_overload / rebalance_fill / drift_correction）。
- `ReconcileNodeIntent`：单个节点经过 decide 后的角色判定 + load + nextAction 自然语言。
- `ReconcileObservedSummary`：单次 reconcile 的全局快照（proxies / accounts / utilization 等）。
- `ReconcileTick`：单次 reconcile 的完整审计行（持久化在 `reconcile_ticks` 表）。
- `OrchestrationStatusSnapshot`：UI 主面板的数据源（spec + 最近 10 个 tick + KPI）。

## Sub2API 协作

- `Sub2ApiConnectionConfig` / `Sub2ApiSafeConnectionConfig`：连接信息（baseUrl / apiKey / timezone / managedProxyPrefix）。
- `Sub2ApiExport`：供 Sub2API 消费的导出 JSON。
- `Sub2ApiAccountFilters / Sub2ApiProtectedProxyRule`：账号筛选 + 保护规则。
- `Sub2ApiAssignmentPreview / Sub2ApiAssignmentApplyResult`：账号绑定计划（preview / apply）。
- `Sub2ApiMaintenancePreview / Sub2ApiMaintenanceApplyResult`：托管代理维护（drain / cleanup）。
- `Sub2ApiImportProxyDataResult / Sub2ApiProxyQualityResult / Sub2ApiUpstreamError`：Sub2API 各接口响应。
- `OperationJob`：后台长任务的状态记录（含步骤、状态、详情）。

## 持久化

SQLite WAL 模式，schema 与上述类型对应。`reconcile_ticks` 表通过 orchestrator 每日一次自动清理保留 7 天，避免无限膨胀。
