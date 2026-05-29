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

### 启用账号编排（账号全自动维护）

详细设计见 ADR 0004 / `notes/account-fleet-design.md`。简要工作流：

#### 0. 部署形态选择

codex-tool 是私有闭源 + Playwright/Chromium 重依赖（镜像 1.5 GB+），不能内嵌主镜像。四种接入：

| 方式 | 适用 | 改动 |
|---|---|---|
| **A. 私有衍生镜像** | 多机部署 / 多环境镜像统一 | `examples/Dockerfile.codex-tool.example` 构建私有 image，compose 切 tag |
| **B. 宿主机直跑 mihomo-hive** | 单机 / 开发 | `node apps/server/dist/index.js`，codex-tool 跟 Hive 同主机 `PATH` 共享 |
| **C. 暂不接入** | 仅用代理编排 / 只看面板 | 设 `HIVE_DISABLE_ACCOUNT_FLEET=true`，或保持 spec.enabled=false（spec 编辑可用，jobs 不入队） |
| **D. 宿主机装 + 挂载进容器（推荐）** | 单机生产 / 想 Docker 隔离 mihomo-hive 同时复用主机 codex-tool 升级流 | 见下 |

#### 0a. 路径 D：宿主机装 + 挂载（实操，对应 nexus-star 当前部署）

**首次部署**：

```bash
# 主机装 uv + standalone Python 3.11
uv python install 3.11

# 拉 codex-tool 源码（私有 repo，先 gh auth login 或 git credential 配好）
gh auth setup-git
git clone https://github.com/NekroAI/codex-create.git ~/Projects/codex-create

# editable 安装 codex-tool（自动建独立 venv，pip 拉所有 deps）
# --with click：codex-tool 有 typer hard-import click 但没声明，必须显式补
cd ~/Projects/codex-create
uv tool install -e . --python 3.11 --with click

# Playwright Chromium（codex-tool Sentinel 验证码绕过用）
uvx --from playwright playwright install chromium

# 验证
~/.local/bin/codex-tool --help    # 应输出中文帮助
```

`docker-compose.yml` 加挂载 + PATH（**容器内路径必须与主机一致**，因为 codex-tool 启动脚本的 shebang 是绝对路径 `/home/miose/.local/share/uv/tools/codex-tool/bin/python`）：

```yaml
services:
  mihomo-hive:
    environment:
      PATH: "/home/miose/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
      PLAYWRIGHT_BROWSERS_PATH: "/home/miose/.cache/ms-playwright"
    volumes:
      - ./runtime:/data
      - /home/miose/.local/bin:/home/miose/.local/bin:ro             # codex-tool 启动脚本
      - /home/miose/.local/share/uv:/home/miose/.local/share/uv:ro   # standalone Python + venv
      - /home/miose/Projects/codex-create:/home/miose/Projects/codex-create:ro  # editable 源码
      - /home/miose/.cache/ms-playwright:/home/miose/.cache/ms-playwright:ro    # Chromium
```

**chromium 系统依赖**（libnss3、libatk 等）目前**未装到容器内**：
- `sms countries` / `login` 命令不需要 chromium → 不受影响
- `all` 注册流程在触发 Sentinel 验证码时才需要 → 真触发时容器内 `apt install libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation` 一次（重建容器会丢，长期方案是做最小衍生镜像只装 chromium runtime deps）

**升级 codex-tool**：

```bash
ssh nexus-star
cd ~/Projects/codex-create && git pull
uv tool install -e . --python 3.11 --force --with click
# 容器内 codex-tool 立即指向新版本，不需要 docker restart
```

**升级 chromium**：`uvx --from playwright playwright install chromium`

**Hive 端 spec.codexTool.binPath 设为绝对路径**：`/home/miose/.local/bin/codex-tool`（不要靠 PATH，避免某天 PATH 漂移）。

#### 1. 设置 env

   ```bash
   HIVE_ACCOUNT_KEY=$(openssl rand -base64 32)   # AES-256-GCM 主密钥
   ```

   > 历史 env `HIVE_ACCOUNT_FLEET_MODE` / `CODEX_TOOL_BIN` 已弃用：
   > - 启停由 `spec.enabled` 控制（UI "自动维护" 按钮）
   > - codex-tool 路径由 `spec.codexTool.binPath` 控制
2. 切到**账号编排** tab → "⑥ codex-tool 连接" 卡填：
   - codex-tool 路径（如果没用 env）
   - SkyMail base_url / admin_email / admin_password
   - ChatGPT mail_domain / chat_web_client_id / codex_client_id
   - 接码 provider 与 service code
   - 出口代理模式（默认 managed-node，自动选健康节点）
3. "① 目标产能" 卡设 `healthyAccountsTarget` / `targetGroupId` / `defaultProxyId`
4. "④ 出生策略" 卡设三级预算 `perTickCap / dailyBudget / monthlyBudget`
5. 保存策略 → 点 **【立即调和】** 触发首次

之后 AccountFleetScheduler 每 5min 一个 tick：
- 观察账号 health（refresh_token / rate_limit / quota / upstream-errors 四路信号）
- 自动 `codex_login` 修复掉登录账号（phone+password 已知者）
- 自动 `codex_register` 补充新账号（受预算）
- 自动退役长期失败 / 死号

用户唯一需要做：充 SMS 余额 + 偶尔看 KPI。

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
- [CI/CD](cicd.md)
