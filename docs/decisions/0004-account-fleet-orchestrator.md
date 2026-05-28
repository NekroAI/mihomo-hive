# ADR 0004 —— 账号编排器（Account Fleet Orchestrator）

**Status**: Accepted · 2026-05-28
**Supersedes**: 0003 部分——本 ADR 把 0003 的"账号 ↔ 代理绑定调度"明确改名为"代理编排"，并在它之上叠加全新一级能力"账号编排"。
**Detail design**: `notes/account-fleet-design.md`（gitignored，含完整 16 节方案，含状态机、Spec、决策树、UI 草图、分期）

---

## 上下文

到 ADR 0003 为止，Hive 解决了"账号 → 代理绑定的稳定/确定性调度"。账号本身的生命周期（注册 / 邮箱 OTP 登录 / 退役 / 凭据维护）仍是用户在 `codex-tool` 私有 CLI 上手工维护，再人工把 token 灌进 Sub2API。

随着账号池规模上千，人肉维护不可持续。目标：**用户一次配置后全自动运营 Sub2API 账号池**；用户只需要做必要支出（接码 SMS 余额），不再人工跑 codex-tool / 不再人工修复掉登录账号。

## 关键认识

1. **`POST /admin/openai/refresh-token` 是管道不是恢复路径**：Sub2API 内部已对存量账号做 token refresh；当 Sub2API 标账号 broken 时它的 refresh_token 已死。这个端点的真实作用是"把外部 (codex-tool) 新生成的 refresh_token 落地 Sub2API"，是 codex_login / codex_register 末段的公共管道。
2. **只有两条恢复路径**：
   - PATH_A: `codex-tool login --phone --password` —— 走邮箱 OTP（skymail），**免费**，~30s
   - PATH_B: `codex-tool all --count 1` —— 接码 SMS，**收费**，~2–5min
3. **codex-tool 是私有闭源**：Hive 通过 spawn 二进制 + stdin JSON config + stdout envelope 调用，不 vendor 源码。详见 `../codex-create/docs/external-integration.md`。
4. **三维状态（origin × intent × health）**是消化"新老账号能力差异"的核心抽象。详见设计文档 §4。

## 决策

### 1. 总体架构

跟现有 ReconcileScheduler 平级、并联运行一个 `AccountFleetScheduler` + `AccountJobsWorker`：

```
ReconcileScheduler (代理编排, 30s tick)
        ↓ 写 account.proxy_id
        Sub2API

AccountFleetScheduler (账号编排, 5min tick)
        ↓ plan → 入队 account_jobs
AccountJobsWorker (异步消费)
        ↓ spawn codex-tool / 调 Sub2API
        codex-tool binary + Sub2API
```

两 scheduler 严格解耦：账号编排不动 `proxy_id`，只动账号生命周期。

### 2. 数据模型

新增 4 张表（packages/db/src/client.ts + schema.ts）：

- `accounts` —— 本地账号镜像，含 origin/intent/health + 加密 `enc_phone` / `enc_password` / `enc_refresh_token` / `enc_id_token` 等
- `account_jobs` —— worker 的异步队列
- `account_fleet_ticks` —— scheduler 审计记录
- `account_budgets` —— SMS / 注册三级预算累计（day / month）

加密：`packages/core/src/account-crypto.ts` AES-256-GCM，主密钥从 `HIVE_ACCOUNT_KEY` env 加载。

### 3. Sub2API 写入端点扩展（packages/core/src/sub2api-client.ts）

6 个新方法（全部带 Zod 响应校验 + 单元测试）：
`refreshOpenaiToken` / `createAccount` / `getAccountUsage` / `deleteAccount` / `setAccountSchedulable` / `listGroups`

### 4. codex-tool adapter（packages/core/src/codex-tool.ts）

- 三方法：`smsCountries` / `login` / `registerOne`
- spawn binary 时**严格隔离 env**（只传 PATH/HOME），避免泄漏 `HIVE_ACCOUNT_KEY` 等 server 端 env
- stdout 解析后即刻 GC（永不入日志）
- stderr 走 redact 中间件（去手机号 / JWT / refresh_token 原文）
- 退出码映射到错误类型（0=ok, 2=arg, 3=external, 4=verification, 5=fs）
- 完整契约见 `../codex-create/docs/external-integration.md` 和 `cli-contract.md`

### 5. 修复路径决策树（packages/core/src/account-fleet.ts §plan）

```
broken account
  ├ retired_legacy / adopted_observing → SKIP
  ├ adopted_active 但 brokenConsecutiveTicks < 阈值 → DEFER
  ├ adopted_active 已到阈值 → DEMOTE_TO_OBSERVING
  ├ recoveryAttempts ≥ max → AUTO_RETIRE
  ├ now < nextRecoveryAfter → DEFER（退避中）
  ├ 有 encPhone+encPassword → PATH_A: codex_login
  └ 否则 → PATH_B: codex_register（受三级预算约束）
```

### 6. 三级预算控本

- `perTickCap` —— 单 tick 最多注册数
- `dailyBudget` —— 当天预算（`account_budgets.window_key = YYYY-MM-DD-day`）
- `monthlyBudget` —— 当月预算（`window_key = YYYY-MM-month`）
- 任一耗尽 → gate 阶段截断 + `tick.skippedReason='budget_exhausted'`
- 紧急补给模式（healthy/target < minHealthyRatio）：默认提升 perTickCap 但仍受日预算

### 7. 模式切换

- `HIVE_ACCOUNT_FLEET_MODE=dry_run`（默认）：scheduler 跑 sense + diagnose + plan + gate，**不入队 jobs**，写 `skippedReason='dry_run'` tick
- `HIVE_ACCOUNT_FLEET_MODE=apply`：gated actions 转 jobs 入队，worker 真调外部
- `HIVE_DISABLE_ACCOUNT_FLEET=true`：完全关闭

### 8. UI

新增 `apps/web/src/routes/AccountFleetRoute.tsx`，双面板布局（与现有 AutomationRoute 对称）：
- 左：`AccountFleetSpecPanel`（6 张折叠卡：自动维护开关 + 目标 / 健康 / 修复 / 出生 / 退役 / codex-tool 连接）
- 右：`AccountFleetStatusPanel`（KPI / 桶分布 / 最近 ticks / 最近 jobs）

顶部 nav 从 "节点池 / 账号编排 / 导出" 改为 **节点池 / 代理编排 / 账号编排 / 导出**——原"账号编排"重命名为"代理编排"。

## 安全

| 项 | 措施 |
|---|---|
| Token 加密 | AES-256-GCM 单字段加密；版本前缀 `v1:` 留 key rotation 余地 |
| codex-tool stdout | adapter 解析后 GC；jobs.payloadJson / resultJson 走 redact |
| stderr 模式 | `\+\d{7,15}` 替 `***PHONE***`；`eyJ...` 替 `***JWT***`；`rt_...` 替 `***RT***` |
| Sub2API API key | settings 表存（与 0003 一致），UI 只暴露 `apiKeyConfigured: boolean` |
| 子进程 env | 只传 PATH/HOME，不传 `HIVE_ACCOUNT_KEY` 等 secrets |

## 失败模式

| 场景 | 行为 |
|---|---|
| Sub2API 不可达 | scheduler.tick 写 `skippedReason='error'`；worker job 标 failed |
| codex-tool 二进制不存在 | job 标 failed with `kind=bin_not_found`；scheduler 下个 tick 再排（受 backoff） |
| HIVE_ACCOUNT_KEY 未设 | dry_run 模式仍能跑（不需要解密）；apply 模式下涉及 codex_login / codex_register 的 jobs 全部失败并提示用户配置 |
| codex-tool oauth_failed | 不丢账号——以 `oauth-failed-*` email 落地本地 `accounts`，原始 phone+password 仍可走 PATH_A 后续恢复 |
| daily budget 耗尽 | gate 截断；UI 显眼红色横幅 |

## 一次配置后能跑多久不需要人工

满足所有以下条件后 server 可以**无人值守运营 Sub2API 账号池**：

1. `HIVE_ACCOUNT_KEY` 已设 + `HIVE_ACCOUNT_FLEET_MODE=apply`
2. Sub2API 连接已配
3. AccountFleetSpec 已配（codex-tool 路径 / skymail / chatgpt OAuth client_id / SMS provider 余额充足）
4. 至少一个 schedulable + active 节点供 codex-tool 走出口代理

之后：
- 自动观察账号 health（每 5min 一个 tick）
- 自动调用 codex_login 修复 phone+password 已知的掉线账号
- 自动 codex_register 补充健康账号数量到 target（受三级预算）
- 自动退役长期失败 / 死号
- 用户唯一需要做：充 SMS 平台余额 + 偶尔看 KPI

## 实施分期（已完成 P0–P7）

| Phase | 范围 | 测试 |
|---|---|---|
| P0 | UI 改名 + 占位 route | e2e |
| P1 | 4 张表 + Zod + crypto | 38 单元测试 |
| P2 | 6 个 Sub2API 端点 + Zod | 12 单元测试 |
| P3 | codex-tool adapter | 18 单元测试 |
| P4 | AccountFleetScheduler dry-run + 决策树纯函数 | 30 单元测试 |
| P5 | UI（SpecPanel + StatusPanel）| 构建通过 |
| P6 | AccountJobsWorker + 6 个 job handlers + adopter actions | 5 集成测试 |
| P7 | 配额轮询（observe_usage）+ 预算累计 + ADR + .env.example | 收尾 |

## 代理感知 egress 选择（增量）

`AccountFleetSpec.codexTool.egress.mode = managed-node` 模式的语义已升级：
- 不再"取候选数组的第一个"
- 注册场景：`selectEgressForRegister` 按 `weight = max(1, qualityScore) / (load+1)` 加权随机
- 登录场景：`selectEgressForLogin` 优先用 `account.egressNodeHash`（上次绑定的节点），失效时回退到注册逻辑
- 严格池过滤 = schedulable + active + assignedPort + `lastTestTargets` 中 openai 目标 `ok=true`
- 严格池为空 → 宽松池（去掉 openai 检查）兜底；宽松池也空 → 抛 `NoEgressAvailableError`
- 选完后回填 `accounts.egress_node_hash`，形成软粘性

参考：`packages/core/src/account-fleet-egress.ts` + 14 单元测试。

## codex-tool 容器接入

- 主镜像不内嵌 codex-tool（OSS / 闭源边界）
- 提供 `examples/Dockerfile.codex-tool.example` + `examples/docker-compose.override.example.yml` 演示"私有衍生镜像"路径
- 详细形态对比见 `docs/runbook.md` §"启用账号编排 / 0. 部署形态选择"

## 后续

- **账号收编工作台 multi-step UI**（设计文档 §11）—— 目前只有 adopter actions tRPC 端点；P5 的 SpecPanel 暂未集成专门工作台。需要时再加。
- **加密 spec 中的 SkyMail/SMS API key**—— 当前明文存 settings；可加 `enc_secrets` 字段 + 启动时解密。
- **Update 单账号端点**—— Sub2API 抓包没收到，目前走 DELETE + 重新 createAccount 路径。
- **多 platform 扩展**—— 当前假设 platform=openai。anthropic/gemini 待 codex-tool 支持。
