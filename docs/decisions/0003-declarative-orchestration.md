# ADR 0003：声明式编排（Spec + Reconcile Loop）

> 状态：草案，待用户 review 后进入实施
> 上下文：原 Sub2API 自动化页是命令式按钮集合，用户要逐个判断"现在该按哪个"。
> 与之矛盾的真实诉求是"用户指定应该是什么样的，系统自动调节"。

## 1. 设计目标

把 Mihomo Hive 的 Sub2API 联动从**命令式工具**升级为**声明式控制系统**，明确回答用户的 4 个真问题：

| 用户真问题 | 系统怎么回答 |
|---|---|
| 1. 我有哪些节点能用？如何加 / 移除？ | `SupplyPolicy`：订阅源 + 入池门槛 + 出池策略；系统自动执行刷新、入池、退役 |
| 2. 节点能否最大效率工作？是否有浪费？ | `CapacityPolicy`：目标负载 + 过载/欠载阈值；Reconcile 主动把账号在节点间小步迁移 |
| 3. 账号出口节点能否少漂移？ | 用 Rendezvous Hashing + 阈值触发 + 灰度限速；只有"超出过载阈值"才触发刚好够的迁移 |
| 4. 故障能否自动调整？ | 仅以 `upstream-errors` 做主信号，滑动窗口 + 指数退避状态机 |

## 2. 核心隐喻

```
┌─────────────┐  reconcile loop  ┌─────────────┐
│  Spec       │ ───────────────▶ │  Status     │
│ 用户期望     │ ◀─────观测────── │ 系统现状     │
└─────────────┘                  └─────────────┘
       │                              │
       ▼                              ▼
   Audit (OperationJob 流，已有)
```

- **Spec**：用户唯一编辑的对象。数据库持久化。
- **Status**：本地观测 + Sub2API live 抓取，缓存为主、不长期存。
- **Reconcile**：周期 + 事件触发，做 5 步（观测 → 判定 → 规划 → 灰度 → 执行）。
- **Audit**：每次 reconcile 生成一个 OperationJob（沿用现有审计架构）。

## 3. 数据模型（Spec 侧）

新增表 `orchestration_spec`（单行配置）：

```ts
interface OrchestrationSpec {
  // — 自动协调开关 —
  enabled: boolean;                    // 火警开关；false 时只观测不执行（默认 true）
  reconcileIntervalMs: number;         // 周期；默认 30_000
  graceBatchPercent: number;           // 单次 reconcile 最多影响 N% 账号（默认 5）
  graceBatchAbs: number;               // 单次 reconcile 最多影响 N 个账号（默认 20，取 min）

  // — 节点供给 (回答 #1) —
  supply: {
    autoFetchSubscriptions: boolean;   // 启用订阅定时刷新（默认 true）
    fetchIntervalMs: number;           // 订阅刷新周期，默认 6h
    inPoolGate: {
      requirePassedTest: boolean;      // 必须通过本地连通性测试（默认 true）
      maxLatencyMs?: number;           // 上限（默认 8000）
      minQualityScore?: number;        // Sub2API 质量分门槛（默认无）
    };
    evictAfterDays: number;            // 连续 unhealthy 多少天退役（默认 7）
  };

  // — 容量策略 (回答 #2) —
  capacity: {
    targetPerNode: "auto" | number;    // "auto" = totalAccounts / healthyNodes
    overloadRatio: number;             // 超过目标 ×1.20 视为过载（默认 1.2）
    underloadRatio: number;            // 低于目标 ×0.60 视为欠载（默认 0.6）
    hardMaxPerNode: number;            // 任何节点的硬上限（默认 200）
  };

  // — 稳定性 (回答 #3) —
  stickiness: {
    strategy: "rendezvous-hash";       // 当前只实现 HRW
    rebalanceTriggerPercent: number;   // 偏差 >= N% 才再平衡（默认 15）
    perTickMigrationCap: number;       // 单次 reconcile 最多迁 N 个账号（默认 10，等同于 graceBatch 内的子配额）
  };

  // — 故障自愈 (回答 #4) —
  health: {
    signalSource: "upstream-errors";   // 仅此一种信号（用户最终决策）
    windowMs: number;                  // 滑动窗口（默认 300_000 = 5 分钟）
    errorRateThreshold: number;        // 错误率破 N% 触发退避（默认 0.05）
    backoffSequenceMs: number[];       // 默认 [60_000, 300_000, 900_000, 3_600_000, 21_600_000]
    evictAfterBackoffs: number;        // 连续失败 N 个退避周期后永久驱逐（默认 5）
  };

  // — 保护 (已有) —
  protectedRule: Sub2ApiProtectedProxyRule;
}
```

节点表新增列（`nodes` 表）：

```sql
ALTER TABLE nodes ADD COLUMN intent_role TEXT NOT NULL DEFAULT 'standby'
  CHECK (intent_role IN ('serving', 'standby', 'quarantined', 'evicted'));
ALTER TABLE nodes ADD COLUMN backoff_until TEXT;            -- ISO 时间，到期前不会服务
ALTER TABLE nodes ADD COLUMN backoff_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN health_score INTEGER;          -- 0-100，由 upstream-errors 衍生
ALTER TABLE nodes ADD COLUMN last_health_check TEXT;
```

新增 `reconcile_ticks` 表（审计 + 排错）：

```sql
CREATE TABLE reconcile_ticks (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  observed_summary_json TEXT NOT NULL,    -- 节点/账号/错误数总览
  planned_changes_json TEXT NOT NULL,     -- diff
  applied_changes_json TEXT NOT NULL,     -- 实际执行（受 graceBatch 限制）
  skipped_reason TEXT,                    -- 'paused' / 'batch_capped' / 'no_change'
  operation_id TEXT                       -- 关联 OperationJob
);
```

## 4. Reconcile Loop 详细规格

### 4.1 触发

- **周期**：每 `reconcileIntervalMs` 触发一次（默认 30s）。
- **事件**：
  - 订阅刷新完成
  - 节点测试完成
  - 用户保存 Spec
  - 节点 backoff 计时器到点
- **手动**："立即调和" 按钮（保留，便于救火）。

### 4.2 五步

#### Step 1：观测

并行拉取 4 个数据源：
1. `client.listAllProxies()` — Sub2API 当前代理 + `account_count`
2. `client.listAllAccounts({status: ""})` — Sub2API 当前账号（含 proxy_id）
3. `client.listAllUpstreamErrors({timeRange: "<windowMs>"})` — 最近窗口错误
4. `repo.listNodes()` — 本地节点（含 intent_role / backoff_until / health_score / sub2apiProxyId）

聚合派生：
- `accountToProxy: Map<accountId, proxyId>`
- `proxyToBoundAccounts: Map<proxyId, accountId[]>`
- `errorsByProxy: Map<proxyId, { total, errors, errorRate }>`
- `protectedProxyIds: Set<proxyId>`（按 SupplyPolicy.protectedRule）
- `managedProxyIds: Set<proxyId>`（按 managedProxyPrefix）

#### Step 2：判定（每节点的目标 intent_role）

```
对每个 schedulable 本地节点：
  errorRate = errorsByProxy.get(proxyId).errorRate   // 默认 0 当没数据时
  现 backoff 中 → role = quarantined
  errorRate ≥ threshold → 进入下一个 backoff 阶段：
                            attempts += 1
                            backoff_until = now + backoffSequence[attempts-1]
                            role = quarantined
  backoff 到期且无新错 → role = serving
  attempts > evictAfterBackoffs → role = evicted
  其他 → role = serving

对每个 disabled / draining / retired / deleted 节点：
  role = standby（不参与）

对每个 evicted 节点：
  role = evicted（终态，需人工 reset）
```

#### Step 3：规划

输入：
- `servingProxyIds` = 所有 `intent_role = serving` 节点对应的 sub2api_proxy_id（过滤掉 protected/managed 之外的不算）
- `assignableProxyIds` = `servingProxyIds - protectedProxyIds`
- `accountsToConsider` = 所有非保护账号（current proxy_id 不在 protected 内）

为每个账号用 **Rendezvous Hashing (HRW)** 计算理论目标：
```
weight(proxy, account) = hash(`${proxy.id}:${account.id}`).readUint32BE(0)
target = assignableProxies.maxBy(weight)
```

HRW 性质：proxy 集合增删 1 个时，只有 `1/N` 比例的账号会改变目标，其余保持原 target。

但**理论目标不一定是当前绑定**。是否触发迁移按 CapacityPolicy 决定：

```
计算每个 serving proxy 的 expected_load = N (按 HRW 计算) vs target_load:
  target_load = totalAssignableAccounts / assignableProxyCount  // 即 capacity.targetPerNode = "auto"
                或 user-set 值

对每个 proxy:
  current_load = proxyToBoundAccounts.get(proxyId).length
  overload = current_load > target_load × overloadRatio
  underload = current_load < target_load × underloadRatio
  
  if overload:
    挑选 current_load - target_load × overloadRatio 个账号要迁出
    优先级：最近迁入的账号（LIFO） + HRW 目标已经在别处的账号
  if underload:
    被动等其他 overload 节点把账号送来；不主动拉取
```

planned changes 还包括：
- 死代理上的账号 → 迁到 HRW 目标
- 没绑定代理的账号 → 绑到 HRW 目标
- managed proxy 但本地节点已 retired → 触发清理（drain + delete）

#### Step 4：灰度

planned changes 数组按以下顺序排序：
1. **紧急**：账号绑定到 quarantined / evicted / 已删除代理
2. **过载**：从 overload 节点迁出
3. **填补**：把无绑定账号塞到 underload 节点
4. **健康再平衡**：理论 HRW vs 当前的细微差异（最低优先级）

截取前 `min(spec.graceBatchAbs, total × spec.graceBatchPercent / 100)` 个。

后面的留到下次 reconcile。这是核心安全阀——策略 bug 不会一次炸全集群。

#### Step 5：执行

按目标 proxy_id 分组（已有 `groupAssignmentChangesByProxy`），批量调用 `bulkUpdateProxy`。

写 reconcile_tick 行：observed / planned / applied 全部 JSON dump。

如果 `spec.enabled = false`：跳过 Step 5；写 `skipped_reason = 'paused'`。

### 4.3 节点供给的子循环

独立于主 reconcile，订阅刷新有自己的周期（`supply.fetchIntervalMs`，默认 6h）：

```
forEach subscription enabled:
  content = fetch(url)
  preview = buildSubscriptionImportPreview(...)
  applyImport(preview, autoApplyOnRefresh: true)
    → 新节点入 candidate
    → 命中过滤的现有节点删除
  forEach candidate node:
    if 还未测过 → 安排测试
    if 通过 inPoolGate → role = serving (自动启用)
    if 未通过 → role = standby (保留待手动决策)
```

退役子流程：每天扫一次
```
forEach node where intent_role = quarantined:
  if quarantined 已连续超过 supply.evictAfterDays:
    role = evicted
```

## 5. 状态机

```
                          ┌─────────────────────────────────────┐
                          │                                     │
                          ▼                                     │
candidate ─测试通过─▶ standby ─用户启用─▶ serving ◀─退避结束重测─┘
                          │                  │
                          │                  │ upstream errorRate > 阈值
                          │                  │
                          │                  ▼
                          │              quarantined
                          │                  │
                          │                  │ 连续 N 次 backoff 失败
                          │                  ▼
                          └────用户启用─── evicted

任意态 ─用户暂停─▶ disabled ─用户启用─▶ 回到 serving (跳过测试)
任意态 ─用户删除─▶ deleted (走 applyDelete 流程)
任意态 ─退役自动条件─▶ retired
```

## 6. 均衡 vs 稳定的调和

用户在 Spec 决策中选了"均衡优先"，但又要"少漂移"。这两者表面冲突，实际可同时达成：

- **HRW 保证最小漂移**：节点集合稳定时，账号永远落到同一 proxy。节点增删时只 1/N 账号改变目标。
- **阈值触发**：再平衡不是"每次 reconcile 都重算所有账号位置"，而是"只搬过载节点上'超出目标线'的那部分"。
- **绑定保持优先**：账号 X 已绑到 proxy A，而 HRW 算它应该去 B——只要 A 没过载、A 健康、A 不是 evicted，X 留在 A。

结果：稳定状态下漂移 = 0；节点变化时漂移 ≈ 受影响的最小账号集合；过载触发时漂移 = 刚好够把负载拉到目标线的账号数。

## 7. 故障识别（仅 upstream-errors）

用户决策：**最小依赖，只看 upstream-errors**。

含义：
- 不依赖本地 curl 测试（仅作为入池门槛，不作为运行时健康信号）
- 不依赖 Sub2API quality_score（不主动调用 quality-check，省 API）
- 节点 health_score 完全由滑动窗口内 `(5xx + 429 + timeout) / total_requests` 决定

代价 / 缓解：
- **静默期问题**：夜间无流量时无信号；解决 = 静默期不调整 health_score（保持上次值）
- **冷启动问题**：刚加入节点无历史；解决 = 默认 health_score = 80（中位），需要至少 N 次请求才纳入判定
- **样本量不足**：5min 窗口内 < 10 次请求时不触发 quarantine

数据获取节流：
- 每分钟拉一次 `listAllUpstreamErrors({timeRange: "5m"})`
- 缓存到内存；reconcile 直接读缓存，不每次都打远端
- Sub2API 接口超时 → 视为"无信号"，沿用上次值

## 8. UI 重构

### 8.1 自动化页布局变更

左侧 380px："**调度策略**" 一个大 Panel，4 个折叠区块对应 4 类 Spec：
- 节点供给（订阅 + 入池门槛）
- 容量策略
- 稳定性（含激进度滑块或保守/均衡/激进三档）
- 故障自愈
- 保护对象（已有，沉到底部）
- "保存策略并立即调和一次" 按钮

右侧主面板：

**顶部 4 KPI 卡**（一目了然）：
| 卡 | 数字格式 | 颜色规则 |
|---|---|---|
| 节点池供给 | `健康 47 / 池 60` | 健康 ≥ 80% → 绿；50-80% → 黄；< 50% → 红 |
| 承载效率 | `利用率 78%` | 50-90% 绿；< 50% 黄（浪费）；> 90% 红（过载） |
| 绑定稳定 | `24h 漂移 12` | < N 绿；> N×3 黄；> N×10 红 |
| 故障自愈 | `退避中 3 节点` | 0 绿；1-N 黄；> N 红 |

**中部节点矩阵**：表格一行一节点
- 节点名 / Sub2API ID / role badge / 承载 / 容量上限 / health_score / backoff_until / **下次 reconcile 计划动作**（自然语言：「将外迁 4 个账号」/「3 分钟后退避结束，将重测」/「闲置中，等待新账号」）

**底部"自动协调状态"**：
- 大开关：[ ON ●  ▌ ] 自动协调
- 当前 reconcile 周期：`30s` · 上次执行：`14:23:01` · 下次预计：`14:23:31`
- "立即调和一次" 按钮
- 最近 5 条 reconcile 摘要（自然语言句子）

### 8.2 现有按钮的去向

| 旧按钮 | 新位置 |
|---|---|
| 推送本地节点 | reconcile 自动做；UI 撤到"运维工具箱"折叠区 |
| 回填映射 | reconcile 自动做；撤到工具箱 |
| 刷新计划 | reconcile 自动做；自动协调 OFF 时也定期观测；撤到工具箱 |
| 应用自动绑定 | reconcile 自动做；保留为"立即调和一次" 别名 |
| 一键质量检查 | 节点初次入池触发；用户手动入口撤到工具箱 |
| 排空托管代理 | reconcile 在节点 evict 时自动做；工具箱保留批量入口 |
| 清理空代理 | reconcile 每个周期检查；工具箱保留 |

### 8.3 节点池页的轻量配合

NodeOpsBar 加 "排空/退役/恢复" 三个新动作（替代当前的"排空/删除"二合一）：
- **退役**：role = retired，不再服务但保留记录
- **排空**：把账号迁走但保留节点（适合临时维护）
- **删除**：现有 applyDelete 流程

## 9. API 命名重整

把 reconcile / maintenance / automation 三个 namespace 收敛到 **`sub2api.automation.*`** 单一入口，让"自动化"作为名实相符的概念：

| 旧路径 | 新路径 | 备注 |
|---|---|---|
| `sub2api.sync` | `sub2api.automation.refresh` | 仅观测，不写 |
| `sub2api.assign.preview` | `sub2api.automation.previewReconcile` | preview 一次完整 reconcile 的 plan |
| `sub2api.assign.applyChanges` | `sub2api.automation.applyOnce` | "立即调和一次" |
| `sub2api.maintenance.preview` | （并入 previewReconcile） | |
| `sub2api.maintenance.drainManaged` | `sub2api.automation.drainNodes` | 接受 `nodeHashes: []`，单/多节点皆可 |
| `sub2api.maintenance.cleanupEmpty` | （reconcile 自动做） | 工具箱保留 `sub2api.tools.cleanupEmpty` |
| `sub2api.automation.syncManagedProxies` | `sub2api.tools.pushNodes` | 退到工具箱 |
| `sub2api.automation.qualityCheckManaged` | `sub2api.tools.qualityCheck` | 退到工具箱 |
| `sub2api.automation.upstreamErrorSummary` | `sub2api.automation.statusSnapshot` | reconcile 状态视图的数据源 |
| `sub2api.reconcile.preview/applyChanges` | （并入 automation.*） | 兼容保留 alias 30 天 |

新 endpoint：
- `sub2api.spec.get / save` — Spec CRUD
- `sub2api.automation.statusSnapshot` — 当前观测 + 节点 intent + 上次 reconcile 摘要
- `sub2api.automation.tickHistory` — reconcile_ticks 分页查询（审计）
- `sub2api.automation.pause / resume` — 等同于 `spec.enabled` 改写，但语义更清晰

## 10. 渐进升级路径

### 阶段 A：基础设施（最小可用）
- 引入 `orchestration_spec` 表 + `nodes.intent_role` 等列 + `reconcile_ticks` 表
- 实现 reconcile loop 主体（5 步），用 setInterval 起步，加 graceBatch 灰度阀
- Spec API（get/save）
- UI 左侧 Spec 编辑卡 + 右侧 4 KPI + 节点矩阵 + 自动协调开关
- 保留旧按钮在"运维工具箱"折叠区

**完成标准**：用户保存一份 Spec，关闭页面，1 分钟后回来发现节点上的账号已经被自动分配/重平衡，且 Audit 能解释每步做了什么。

### 阶段 B：故障自愈
- 集成 `listAllUpstreamErrors` 滑动窗口
- 节点状态机（serving ↔ quarantined ↔ evicted）+ backoff 序列
- KPI 卡的"故障自愈"列接通

**完成标准**：人工制造一个节点的错误率，观察系统在一个 reconcile 周期内把它打入 quarantined，账号不被立刻迁走（除非选了短租约模式）；错误消失后自动恢复。

### 阶段 C：稳定性升级
- 把 `pickStableProxy` 替换为 Rendezvous Hashing 实现
- 添加"切换日工具"：一次性把所有账号按新算法重映射的 preview，用户确认后执行（这一次允许大漂移，之后稳定）
- HRW 单元测试覆盖：节点集合变化时漂移率 ≈ 1/N

**完成标准**：观察连续多个 reconcile 周期，漂移数字稳定接近 0；增减 1 个节点时只看到约 1/N 账号迁移。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Reconcile loop 策略 bug → 一次性炸全集群 | graceBatch 双限制（百分比 + 绝对值）；spec.enabled 火警开关 |
| Sub2API API 限流 | bulkUpdateProxy 批量大小封顶（< 50 per call）；upstream-errors 每分钟最多拉一次 |
| HRW 切换需要大迁移 | 切换日工具，一次性 preview + 用户确认；之后稳定 |
| Reconcile 与用户手动操作并发 | 用户手动写入触发立即 reconcile；reconcile 期间锁住 Spec write（< 30s） |
| 静默期（夜间）无 upstream-errors 信号 | 不触发新 quarantine；保持现状直到有新流量 |
| reconcile_ticks 表无限增长 | 保留最近 7 天（约 20k 行）；旧的归档或截断 |
| 节点测试和 reconcile 重叠占用 Mihomo | 测试是 mutation，会写 saveNodes；reconcile 不动节点表的 status/lifecycle，只动 sub2api_proxy_id 和 backoff_until。无冲突 |

## 11.5 入站代理（Intake Proxy）补充

新增 `OrchestrationSpec.intake.proxyId` 字段。

**语义**：用户在 Sub2API 后台手动配置的一个代理（通常是兜底直连 / 家庭线路），作为新账号的"漏斗入口"——用户创建账号时默认挂到这里。

**为什么需要**：Sub2API 系统对账号有"必须绑定一个代理"的语义。新账号如果不挂在某个具体代理上就不存在；但 Hive 还没"看到"它就无法决定该挂到哪。Intake Proxy 让用户能跳过这层决策——挂到这里就行，剩下交给 Hive。

**Reconcile 行为**：
- 在 plan 步骤增加最高优先级 kind = `drain_intake`：扫描 intake 代理上的所有账号 → 按 HRW 算每个账号的理想 Hive 节点 → 生成迁移变更
- 这些变更**绕过 graceBatch 百分比限制**（但仍受 `stickiness.perTickMigrationCap` 上限），因为账号停在 intake 上是"零调度状态"，引流出去是首要任务
- 完成后 intake 上账号数 = 0，账号已经在 Hive 健康节点上

**约束**：
- intake 代理不能是 Hive 托管代理（不能有 managedProxyPrefix）—— 否则混入正常调度池
- intake 代理不能命中保护规则 —— 否则账号永远迁不走
- 验证逻辑：spec.save 时检查两条约束，否则拒绝并返回原因
- 用户取消 intake（proxyId = null）后，新账号将以"未绑定"状态进入，reconcile 仍能通过 `bind_missing` 路径接管

**UI**：左侧 Spec 编辑栏顶部加一个"默认入站代理"小区，下拉选择 Sub2API 现有代理；显示其当前账号数 + "下次 reconcile 将引流 N 个"。

## 12. 不在本 ADR 范围

- 多 Sub2API 实例联邦
- 按账号优先级分级（VIP 账号优先排程）
- 跨地区流量调度
- 容量自动扩容（自动加订阅源）

这些是 Stage D+ 的事，未来再写新 ADR。

## 13. 决策

采纳本 ADR 描述的方向：声明式 Spec + Reconcile Loop，默认 ON + 火警开关，均衡优先 + HRW 最小漂移，故障识别仅依赖 upstream-errors。

按阶段 A → B → C 实施。每阶段独立 PR，CI 必须绿才能进下一阶段。

---

**评审清单（请用户 review 时核对）**：
- [ ] Spec 的 4 类字段是否覆盖了所有"我想要它怎样"的表达
- [ ] graceBatch 默认 5% / 20 个是否过于保守（100-300 节点规模下）
- [ ] 退役判定（7 天）是否合理
- [ ] HRW 切换日的大漂移是否可接受
- [ ] 是否需要保留"完全手动模式"（spec.enabled = false 时还要不要 reconcile 跑观测）
