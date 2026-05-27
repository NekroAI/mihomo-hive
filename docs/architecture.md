# 架构

Mihomo Hive 是一个**声明式编排器**：用户在 Spec 里描述"节点池和账号绑定应该是什么样"，系统跑 Reconcile Loop 自动调节当前状态去逼近 Spec。

详细的设计原则与状态机见 [ADR 0003](decisions/0003-declarative-orchestration.md)。

```text
              Spec (用户期望)
                 │
                 ▼
     Reconcile Loop (周期/事件触发)
       observe → decide → plan → gate → apply
                 │
                 ▼
              Status (现状)
                 │
                 ▼
        Audit (OperationJob / reconcile_ticks)
```

## 运行模型

- Node.js 服务提供 HTTP API，并托管构建后的 Web UI。
- CLI 与服务共用同一套核心模块和数据库模型。
- SQLite WAL 存储订阅源、节点、端口分配、Spec、reconcile 历史等持久状态。
- Mihomo 负责监听本地端口并把每个入口固定到指定节点。
- 生成物默认写入 `generated/` 或容器中的 `/data/generated/`。
- 服务启动会自动 boot Mihomo（基于上次发布的配置）并启动 reconcile 调度器。

## 声明式编排（ADR 0003）

**用户编辑的对象**：`OrchestrationSpec` 单行配置文档，含四类策略：

| 策略 | 字段 | 回答 |
|---|---|---|
| `supply` | 订阅刷新周期、入池门槛、退役天数 | 我有哪些节点能用？如何加 / 移除？ |
| `capacity` | 目标负载（auto / 手动）、overload / underload 比例、硬上限 | 节点能否最大效率工作？是否有浪费？ |
| `stickiness` | hash 策略（stable / HRW）、再平衡阈值、单 tick 迁移上限 | 账号能否少漂移？ |
| `health` | 错误预算 / 窗口长度、backoff 序列、永久驱逐次数 | 故障能否自动调整？ |

外加两个特殊字段：
- `intake.proxyId`：入站代理（用户在 Sub2API 手动配的兜底代理），新账号默认挂这里，reconcile 每 tick 以最高优先级引流到合适的 Hive 节点。
- `protectedRule`：保护代理规则，命中规则的代理被双向锁定（不分配新账号，已绑账号不被迁走）。

**Reconcile Loop**：服务启动注入 `ReconcileScheduler`，按 `spec.reconcileIntervalMs`（默认 30s）触发，五步纯函数 `observe → decide → plan → gate → apply`。`spec.enabled = false` 时仍跑前 4 步写 dry-run tick，便于排查；只跳过 step 5 的实际写入。

**安全阀**：单次 tick 最多影响 `min(总账号×graceBatchPercent, graceBatchAbs)` 个变更，迁移类（rebalance_overload / drift_correction）额外受 `stickiness.perTickMigrationCap` 限制。策略 bug 不会一次性炸全集群。

**节点意图状态机**：

```
candidate → standby → serving ↔ quarantined → evicted → retired
                          ↑ 错误数 ≥ errorBudget   ↓ evictAfterDays 天
                          ↓ 退避到期且无错        无变化
                          serving
```

`serving / quarantined / evicted` 由 reconcile decide 根据 upstream-errors 信号自动转换；`retired / deleted` 由超时计时或用户手动触发。

## 固定出口模型

每个 `schedulable` 节点获得一个稳定本地端口。订阅更新后，系统会基于节点 hash 复用已有端口，让上游系统可以长期绑定同一个出口。

## 节点生命周期

- `candidate`：订阅预览后导入的候选节点，尚未参与调度。
- `testing` → 测试中。
- `schedulable`：可发布到 Mihomo 并参与 Sub2API 账号绑定。
- `disabled`：用户暂停调度（或被 inPoolGate 拒入池）。
- `draining`：准备下线，等待账号迁出。
- `cooling_down`：测试失败或用户手动冷却。
- `retired`：长期驱逐后自动归档；不再渲染。
- `deleted`：完全删除（Sub2API 代理也已删除）。

## Sub2API 协调模型

Sub2API 集成遵循"托管代理前缀 → 保护代理 → 推导保护账号 → 声明式重绑定"。

- **托管代理识别**：所有 Hive 推到 Sub2API 的代理名称都带可配置前缀（默认 `MH-`）。Reconcile / 排空 / 清理操作只针对带前缀的代理，永不误碰用户手动配置的代理。
- **保护规则**：用户只选保护代理（名称包含、host 包含、端口、国家等条件），系统从 `account.proxy_id` 自动推导保护账号。保护账号 100% 不被 reconcile 修改。
- **入站代理**：用户挑一个 Sub2API 现有代理作为新账号的"漏斗入口"，reconcile 自动引流到 Hive 节点。
- **写入前重读 live**：所有 apply 类路径在执行前会重新从 Sub2API 拉取最新数据，避免依赖过期的前端预览。

## 模块划分

- `packages/schemas`：Zod schema 和共享类型（含 OrchestrationSpec / ReconcileTick）。
- `packages/core`：纯业务逻辑（reconcile、strategy-switch、subscription-preview、sub2api-client、ports、render 等）。
- `packages/db`：SQLite 仓储层。
- `packages/mihomo`：Mihomo 进程控制（pid + signal）。
- `packages/exporters`：Sub2API 等导出格式。
- `apps/cli`：命令行工具。
- `apps/server`：Hono API、tRPC 路由、Reconcile Scheduler、静态 UI 托管。
- `apps/web`：React Web UI（节点池 / 自动化 / 高级运维 三个 workspace）。
