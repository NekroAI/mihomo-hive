# 数据模型

所有产品类型的唯一定义源位于 `packages/schemas/src/*`，全部用 Zod schema 描述。

---

## 运行配置 & 节点池（能力 1）

| 类型 | 说明 |
|---|---|
| `RuntimeConfig` | 监听地址、导出地址、端口段、路径、Mihomo binary |
| `ProxyNode` | 标准化后的订阅节点。含 hash、原始 Clash 配置、测试状态、生命周期、调度开关、分配端口；外加编排字段：`intentRole / backoffUntil / backoffAttempts / healthScore / lastHealthCheck` |
| `NodeLifecycleStatus` | `candidate / testing / schedulable / disabled / draining / cooling_down / retired / deleted` |
| `NodeIntentRole` | `serving / standby / quarantined / evicted`（ADR 0003，reconcile 自动维护） |
| `SubscriptionImportPreview` | 订阅拉取后的预览：`import / update / skip_duplicate / skip_existing / skip_filtered` 动作分类 + `deletesExisting` 标记 |
| `NodeDeletionPlan` | 节点删除前的影响面（Sub2API 阻塞账号） |
| `FilterProfile` | 节点筛选规则（包含 / 排除） |

### 测试结果字段（P5-R 后）

| 字段 | 含义 |
|---|---|
| `lastTestStatus` | 旧格式 `openai:401,claude:405`，向后兼容 |
| `lastTestLatencyMs` | **新语义：L1 延迟**。服务直连代理 `host:port` 的 TCP 握手时间，不经 Mihomo、不打业务目标 |
| `lastTestTargets` | 新字段，JSON 数组：`[{ targetId, ok, latencyMs, httpStatus?, message? }]`。每个测试目标的 L2 端到端结果 |

UI 端 NodeTable 显示：
- "代理延迟" 列 = `lastTestLatencyMs`（L1）
- "目标延迟" 列 = `lastTestTargets` 解析（L2），每个 target 一个 chip + 秒数 + 颜色编码

---

## 声明式编排（ADR 0003，能力 2）

### Spec

`OrchestrationSpec` —— 用户唯一编辑的"期望"对象。五类策略：

| 策略字段 | 内容 |
|---|---|
| `supply` | 订阅刷新周期、入池门槛（`maxLatencyMs / minQualityScore`）、退役天数（`evictAfterDays`） |
| `capacity` | `targetPerNode`（`auto` / 手动）、`overloadRatio` / `underloadRatio`、`hardMaxPerNode` |
| `stickiness` | 哈希策略（`stable-hash` / `rendezvous-hash`）、再平衡阈值、`perTickMigrationCap` |
| `health` | `errorBudgetPerWindow / windowMs`、`backoffSequenceMs`（默认 1m/5m/15m/1h/6h）、`evictAfterBackoffs` |
| `intake` | `proxyId`（入站代理）+ `bypassGraceBatch`（绕过灰度限速） |

外加 top-level 字段：`enabled`（火警开关）、`reconcileIntervalMs`、`graceBatchPercent / graceBatchAbs`、`protectedRule`（保护代理规则）。

### Reconcile 数据流

| 类型 | 说明 |
|---|---|
| `ProxyHealthSignal` | reconcile 输入信号：每个 proxy 在窗口内的错误条数（`errorsInWindow`） |
| `ReconcilePlannedChange` | 单条变更：`kind ∈ drain_intake / bind_missing / rebind_dead / rebalance_overload / rebalance_fill / drift_correction`；含 `fromProxyName / toProxyName` 快照避免代理后续被改名导致无法回溯 |
| `ReconcileNodeIntent` | 单个节点经过 decide 后的角色判定 + load + nextAction 自然语言 + 富展示字段（`localName / proxyName / host / port / country / protocol`） |
| `ReconcileObservedSummary` | 单次 reconcile 的全局快照（proxies / accounts / utilization） |
| `ReconcileTick` | **完整**审计行，含 `nodeIntents / plannedChanges / appliedChanges` 三个数组。持久化到 `reconcile_ticks` 表 |
| `ReconcileTickSummary` | **轻量**摘要：`id / startedAt / finishedAt / durationMs / enabled / plannedTotal / appliedTotal / skippedReason / errorMessage`。用于历史列表展示，单条详情走 `orchestrator.tickDetail(id)` 按需拉 |

### Snapshot

`OrchestrationStatusSnapshot` —— UI 主面板的数据源：

```ts
{
  spec: OrchestrationSpec,
  lastTick?: ReconcileTick,                    // 完整数据，给 KPI + NodeMatrix 用
  recentTicks: ReconcileTickSummary[],          // 摘要列表（最多 200 条），给"最近调和"卡用
  nodeIntents: ReconcileNodeIntent[],
  observedSummary?: ReconcileObservedSummary,
  kpis: {
    healthyProxies, totalProxies, utilizationPercent,
    driftCount24h, quarantinedCount
  }
}
```

### 性能背景

statusSnapshot 端点采用 summary 列表 + 单条 detail 按需拉，原因：

- 直接返回 500 条完整 ReconcileTick（每条 ~50KB）会让响应 ~25MB
- DB 层 `listRecentReconcileTickSummaries` 跳过 4 个 JSON 列 + 不走 zod parse，500 条 ~5ms
- driftCount24h 用 SQL JSON1 聚合直接统计 applied_changes，避免在 JS 层 reduce 500 条数组

---

## Sub2API 协作

| 类型 | 说明 |
|---|---|
| `Sub2ApiConnectionConfig` / `Sub2ApiSafeConnectionConfig` | 连接信息（baseUrl / apiKey / timezone / managedProxyPrefix） |
| `Sub2ApiProxyRecord` | Sub2API 返回的代理记录，含 `account_count`、`status`、地理信息 |
| `Sub2ApiAccountRecord` | Sub2API 账号记录，含 `proxy_id` 当前绑定 |
| `Sub2ApiExport` | 供 Sub2API 消费的导出 JSON（含 `proxy_key`） |
| `Sub2ApiAccountFilters / Sub2ApiProtectedProxyRule` | 账号筛选 + 保护规则 |
| `Sub2ApiAssignmentPreview / ApplyResult` | 账号绑定计划 |
| `Sub2ApiMaintenancePreview / ApplyResult` | 托管代理维护（drain / cleanup） |
| `Sub2ApiImportProxyDataResult / Sub2ApiProxyQualityResult / Sub2ApiUpstreamError` | Sub2API 各接口响应 |
| `OperationJob` | 后台长任务的状态记录（步骤 / 状态 / 详情） |

---

## 持久化

SQLite WAL 模式，schema 与上述类型对应。

- `nodes` 表 P5-R 加 `last_test_targets TEXT` 列，存 JSON 数组
- `reconcile_ticks` 表通过 orchestrator 每日一次自动清理保留 7 天
- 所有 schema 变更走 `addColumnIfMissing` 增量迁移，保证已部署的 SQLite 平滑升级
