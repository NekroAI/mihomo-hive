# 运维手册

公开部署建议直接使用预构建镜像，运行数据挂载到独立目录。

## 启动服务

```bash
docker compose up -d
```

服务启动后会自动：
- 创建运行配置 `/data/hive.config.json`
- 启动 Mihomo（基于上次发布的 yaml；首次启动尚无 yaml 时跳过）
- 启动 ReconcileScheduler（30s 周期；未配 Sub2API 连接时仍跑，只会得到空快照）

Web UI 默认监听 `0.0.0.0:9990`：

```text
http://127.0.0.1:9990
```

`HIVE_HOST` / `HIVE_PORT` 通过环境变量改。首次访问要求设置访问密码。

## 访问密码

密码哈希保存在 SQLite 数据库中。忘记密码时通过容器内 CLI 重置：

```bash
docker exec mihomo-hive node apps/cli/dist/index.js auth reset-password --password "new-strong-password"
```

推荐从 stdin 传入避免落入 shell 历史：

```bash
printf '%s' 'new-strong-password' | docker exec -i mihomo-hive node apps/cli/dist/index.js auth reset-password --password-stdin
```

重置密码会撤销所有已登录会话。

---

## Web UI 工作流

Web UI 顶部 4 个 tab：节点池 / 代理编排 / 账号编排 / 导出。

注：原 "账号编排" tab 已重命名为 **代理编排**（管理账号 ↔ 代理绑定调度）；新增的 **账号编排** tab 用于账号生命周期自动维护（注册 / 登录 / 退役），分阶段交付。

### 仅订阅转换（不用 Sub2API）

节点池 tab 走 3 步：

1. **左栏添加订阅源** → 拉取 + 预览 → 应用导入。新节点出现在右侧节点表
2. 在节点表勾选要保留的节点，点工具栏 **【分配端口】**：给所选节点分端口 + 渲染 Mihomo + reload
3. 点 **【测试所选】** 或 **【测试全部】**：
   - 代理延迟列显示 L1（服务直连代理握手时间）
   - 目标延迟列显示 L2（OpenAI / Claude 端到端，秒数 + 颜色编码）

通过测试的节点已在 `127.0.0.1:{port}` 提供 listener，可以直接接到上游脚本。如需打包 JSON 给其他系统使用，切到**导出** tab。

### 启用 Sub2API 自动调度

在上面 3 步基础上：

4. 切到**代理编排** tab，配置 Sub2API 连接（baseUrl + adminApiKey + 托管前缀）
5. 回到节点池 tab，勾选要纳入调度的节点，点 **【启用调度】**：原子完成 `lifecycle → schedulable` + 推送到 Sub2API + 回填 proxy_id
6. 切回**代理编排** tab，在左栏 Spec 里配置：
   - 入站代理（intake.proxyId）：新账号默认挂的代理
   - 保护规则（protectedRule）：哪些代理不应被自动化触碰
   - 容量 / 健康 / 灰度 等策略

完成后 ReconcileScheduler 每 30s 一个 tick 自动调节绑定。右栏实时展示 KPI / 节点矩阵 / 最近调和日志。

### 启用账号编排（账号全自动维护，需外部 codex-tool，可选）

详细设计见 [ADR 0004](decisions/0004-account-fleet-orchestrator.md)。

> **codex-tool 是独立的闭源组件，本仓库不含其源码、整体可选。** 没有它时节点池 / Sub2API 调度 /
> 账号查看（账号列表、健康、意图，来自 Sub2API 观测）全部正常；它只用于**自动注册**与**自动登录续登**。
> 账号编排默认关闭（`spec.enabled=false`），需在 UI 显式开启并配置 codex-tool 连接。

#### 0. 部署形态选择

codex-tool 带 Playwright/Chromium 重依赖（镜像很大），不内嵌主镜像。常见接入方式：

| 方式 | 适用 | 改动 |
|---|---|---|
| **A. 私有衍生镜像** | 多机部署 / 多环境镜像统一 | 基于主镜像构建一个把 codex-tool 装进去的私有 image，compose 切 tag |
| **B. 宿主机直跑 mihomo-hive** | 单机 / 开发 | `node apps/server/dist/index.js`，codex-tool 跟 Hive 同主机 `PATH` 共享 |
| **C. 暂不接入** | 仅用节点池 / 代理编排 / 只看面板 | 保持 `spec.enabled=false`（spec 编辑可用，jobs 不入队） |
| **D. 宿主机装 + 挂载进容器（推荐）** | 单机生产 / 想 Docker 隔离 mihomo-hive 同时复用主机 codex-tool 升级流 | 见下 |

#### 0a. 路径 D：宿主机装 + 挂载（要点）

宿主机用独立 Python 环境安装 codex-tool（连同其依赖与 Playwright Chromium），然后在 `docker-compose.yml` 里把这些目录**只读挂载**进容器，并让容器内的 `PATH` / Playwright 浏览器路径与主机一致：

- **容器内路径必须与主机一致**——codex-tool 启动脚本的 shebang 是绝对路径，容器内外不一致会找不到解释器
- 挂载内容：codex-tool 启动脚本目录、Python venv 目录、（如果是 editable 安装）源码目录、Playwright Chromium 缓存目录，全部 `:ro`
- 把 `PATH` 加上 codex-tool 启动脚本目录，并设 `PLAYWRIGHT_BROWSERS_PATH` 指向挂进来的 Chromium 缓存

> 上述真实主机路径 / 用户名 / 私有源码地址按你的部署环境填写，**不要写进公开仓库**。

**chromium 系统依赖**（libnss3、libatk 等）：注册流程在触发 Sentinel 验证码时才需要 chromium；`sms countries` / `login` 不需要。若用挂载形态且容器内缺这些库，可在容器内一次性 `apt install` 对应运行时依赖（重建容器会丢，长期方案是做最小衍生镜像只装 chromium runtime deps）。

**升级**：在宿主机更新 codex-tool（editable 形态 `git pull` + 重装）/ 重新安装 Chromium 即可，容器内立即指向新版本，不需要 `docker restart`。

**Hive 端 `spec.codexTool.binPath` 设为绝对路径**（不要靠 PATH，避免某天 PATH 漂移）。

#### 1. 设置 env

   ```bash
   HIVE_ACCOUNT_KEY=$(openssl rand -base64 32)   # AES-256-GCM 主密钥
   ```

   > 启停由 `spec.enabled` 控制（UI "自动维护" 开关）；codex-tool 路径由 `spec.codexTool.binPath` 控制。
2. 切到**账号编排** tab → codex-tool 连接卡填：codex-tool 路径、邮件服务连接、ChatGPT OAuth client_id、接码 provider、出口代理模式（默认 managed-node，自动选健康节点；可开 `egress.dynamic` 单口动态出口）。
3. 目标产能卡设 `healthyAccountsTarget` / `targetGroupId` / `defaultProxyId`。
4. 出生策略卡设三级预算 `perTickCap / dailyBudget / monthlyBudget`。
5. 保存策略 → 点 **【立即调和】** 触发首次。

之后 AccountFleetScheduler 每 5min 一个 tick：
- 观察账号 health（refresh_token / rate_limit / quota / upstream-errors 信号；并用 Sub2API 实时账号列表对账，远端找不到的本地账号判 broken）
- 自动 `codex_login` 给 token 失效的账号经干净出口重新登录续命（phone+password 已知者）
- 自动 `codex_register` 补充新账号（受三级预算）
- 自动退役**确定死号**（`account_unusable`）；出口/网络/consent/Sentinel 类失败永不退役，退避重试（封顶 6h）

#### 关键经验（决定续登成败）

账号是否被风控标记，主要取决于**出口 IP 质量**（干净/住宅 vs 机房）与**登录频率**：

- 干净/住宅出口注册、温和频率的账号：邮箱 OTP 即可登录、不要求手机验证、token 被吊销后能**免费重新登录续命**（已在真实调度用新注册账号验证通过）。
- 机房 IP 注册 + 高频反复登录的账号：被 OpenAI 风控标记 → 登录时要求手机 OTP 二次验证，而临时接码号已释放收不到码 → 无法完成；严重的直接被删除/停用。

用户日常只需要：保证出口干净、控制频率、充接码余额、偶尔看 KPI。

#### 隔离实验 / 停机

- 每个账号行有"自动运维"开关；关掉则暂停该账号一切自动化并清其已排队 job。
- 工具栏"停掉全部账号"可批量关（可只停非 active），用于"停掉现有账号、只让一小批新号跑实验"。

### 节点池工具栏低频操作（`⋯` dropdown）

| 分组 | 项 | 说明 |
|---|---|---|
| 诊断 | 重建 Mihomo | yaml 损坏 / 进程挂掉时强制重渲染 + reload。不动端口、不改 lifecycle、不推 Sub2API |
| 生命周期（所选） | 暂停 / 冷却 / 退役 / 删除 | lifecycle 状态过渡 |
| 筛选 | 选择 status=active 的节点 | 快速勾选可用节点 |

---

## CLI 自动化

CLI 与 Web UI 使用同一套数据库和核心逻辑。

### 订阅与节点

```bash
hive sub add --name demo --url "https://example.com/sub"
hive sub fetch
hive sub list                       # 只输出订阅摘要，不打印订阅正文
hive nodes import
hive nodes list
```

### 端口与 Mihomo

```bash
hive ports assign --range 10001-10300
hive mihomo render
hive mihomo start                   # 首次启动；后续改动用 reload
hive mihomo reload
hive mihomo status
```

端口分配基于节点 hash 尽量保持稳定。订阅更新后同一节点会优先复用原端口。

### 测试

```bash
hive nodes test --targets openai,claude --timeout-ms 15000 --concurrency 8
```

每个节点先测 L1（服务直连代理握手），再测每个 L2 目标（经 Mihomo 走代理到目标 URL）。

内置测试目标：

| ID | URL | 期望状态 |
|---|---|---|
| `ip` | `https://api.ipify.org` | 200 |
| `openai` | `https://api.openai.com/v1/models` | 401（无 token） |
| `claude` | `https://api.anthropic.com/v1/messages` | 405（GET 请求） |

测试通过的节点 status 标 `active`，失败标 `failed`。CLI 输出包含 L1 延迟和每个目标的 status code。

### 导出

```bash
hive export sub2api --host 127.0.0.1 --output /data/generated/sub2api-proxies.json
```

导出文件只包含 `status=active` 且已分配端口的节点。Web UI 中可先筛选/勾选目标节点再下载或写出。

### 账号编排（`hive fleet`，供 AI/自动化驱动）

`hive fleet` 命令组让 AI / 脚本**无需网页登录态**直接驱动账号编排：它直接读写本地 repo/DB，运行中的 server worker 通过 poll 消费入队的 job。这是"项目由 AI 自动维护"的关键基础设施。

容器内用法：`docker exec mihomo-hive node apps/cli/dist/index.js fleet <cmd>`。

```bash
hive fleet status                       # 概览：意图/健康/运维开关分布 + 队列 + 当前可恢复数
hive fleet accounts                     # 列出账号(脱敏)，显示完整账号 id 便于 pipe 到 ops/login
hive fleet accounts --broken --ops on   # 可按 --intent / --ops on|off / --broken / --limit 过滤
hive fleet stop-all                     # 停掉账号运维并清其队列(默认只停非 active；--include-active 全停)
hive fleet start-all                    # 恢复所有账号运维开关
hive fleet ops <accountId> on|off       # 单账号运维开关(off 同时清该账号队列任务)
hive fleet register <n>                 # 入队 N 个 codex_register(立即注册新号，默认插队)
hive fleet login <accountId>            # 入队一次 codex_login(要求账号有 phone+password)
hive fleet import <refreshToken>        # 用外部 refresh_token 直接落地一个账号到 Sub2API
```

> 这些命令只入队/改状态，真正执行由 server 端 worker 完成（需 server 在跑且已配 codex-tool / Sub2API）。

---

## 开发模式

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm --filter @mihomo-hive/server dev
```

更多技术文档：

- [架构总览](architecture.md)
- [数据模型](data-model.md)
- [ADR 0003 声明式编排](decisions/0003-declarative-orchestration.md)
- [ADR 0004 账号编排](decisions/0004-account-fleet-orchestrator.md)
- [CI/CD](cicd.md)
