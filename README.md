# Mihomo Hive

**两条能力并行的代理工作台**：

1. **专业订阅转换工具** — 把订阅里的代理节点固定到本地端口，提供稳定的 listener。无需 Sub2API 也能独立使用。
2. **Sub2API 接入自动调度** — 在订阅转换的基础上声明"账号绑定应该是什么样"，编排器自动维护代理池和账号绑定。

```text
127.0.0.1:10001 -> 节点 A
127.0.0.1:10002 -> 节点 B
127.0.0.1:10003 -> 节点 C
```

任何"一个身份长期绑定一个出口"的自动化场景都能用：自家脚本、自动化工具、AI 代理桥、Sub2API 等等。

---

## 能力概览

### 订阅转换 & 节点池管理

不依赖任何外部系统就能用：

- 解析 Clash YAML 订阅 + URI 形式（vmess 完整解析；其他协议保留原始 URI 供 Mihomo 直接消费）
- 节点稳定 hash 去重；按地区、关键词、协议筛选
- 订阅自动定期刷新，新节点自动入池，被过滤的旧节点自动删除
- 双段延迟测试：
  - **L1**：服务直连代理 host:port 的 TCP 握手延迟
  - **L2**：通过本地 Mihomo listener 到 OpenAI / Claude / IP echo 的端到端延迟
- 完整生命周期：候选 → 启用 → 冷却 → 退役 → 删除（每步既能手动也能自动）
- 稳定本地端口分配，订阅刷新后基于节点 hash 复用端口不漂移
- Mihomo 多 listener 配置生成；服务启动自动 boot / reload
- 导出 Sub2API JSON / 直接通过 `127.0.0.1:{port}` 给上游使用

### Sub2API 自动调度（可选启用）

只在 Web UI 配置好 Sub2API 连接后才生效：

- **声明式 Spec**：在面板里描述节点池 + 账号绑定应该是什么样，每 30 秒一次 reconcile 自动调节
- **入站代理（intake proxy）**：用户在 Sub2API 后台配的兜底代理；新账号默认挂这里，reconcile 自动引流到 Hive 节点
- **保护代理规则**：命中规则的代理双向锁定（不分配新账号、已绑账号也不被搬走）
- **容量再平衡**：过载节点账号按 LIFO 外迁；HRW 哈希让节点集合变化时漂移最少（≈ 1/N）
- **故障自愈**：基于 Sub2API upstream-errors 滑动窗口；错误超预算 → 退避（1m/5m/15m/1h/6h）→ 永久驱逐 → 退役
- **灰度阀 + 火警开关**：单次 reconcile 限 10%/50 个账号；暂停态仍跑 dry-run 写审计
- **切换日工具**：哈希策略切换前完整预览影响范围

详细原理见 [ADR 0003](docs/decisions/0003-declarative-orchestration.md)。

### 账号自动注册与续登（需外部 codex-tool，**可选**）

在 Sub2API 调度之上的进一步自动化：自动注册新账号、账号 token 失效后自动重新登录续命，
让账号池长期自维持、降低人工与接码成本。

- **自动注册**：经选定的干净出口注册新账号并落地 Sub2API（每个账号记录接码激活 ID）。
- **自动续登**：账号 token 被吊销 → 经干净出口免费重新登录(邮箱 OTP)拿新 token，回到可用。
- **失败精确归因**：账号已停用(OpenAI 删除/停用)→ 退役;出口/consent/Sentinel/限流等环境类
  → 不退役、退避重试。退役 = 确定死号这一终态。
- **账号运维开关**:每个账号可开关"是否接受自动运维",支持批量停掉/隔离实验。
- **关键经验**：账号是否被风控标记主要取决于出口 IP 质量(干净/住宅 vs 机房)与登录频率;
  干净出口注册的账号能长期免费续登,机房 IP + 高频会被风控标记(手机验证/快速封停)。

> **codex-tool 是独立的闭源组件,本仓库不含其源码,且整体可选。**
> - **没有 codex-tool 时:** 上面的"订阅转换 & 节点池管理""Sub2API 自动调度"以及账号**查看**
>   (账号列表/健康/意图,来自 Sub2API 观测)全部正常可用——核心代理池产品不依赖 codex-tool。
> - **codex-tool 只用于** 自动注册 / 自动登录续登这两类动作;未配置时这两项不可用,其余功能不受影响。
> - 账号编排的自动注册/恢复默认关闭(`spec.enabled=false`),需在 UI 显式开启并配置 codex-tool
>   连接(系统页有"测试连通")。CLI 自动维护见 `hive fleet`。

### 审计可观测

- 每次 reconcile 写一条 `reconcile_ticks` 行（observed / planned / applied 全量 JSON），自动保留 7 天
- 节点危险操作（删除 / 排空）作为 OperationJob 可在 UI 追溯
- Web UI 实时 KPI：节点池供给 / 承载效率 / 24h 漂移数 / 退避中节点

### 部署

- 预构建 Docker 镜像（GHCR）+ host network 直接监听本地端口
- CLI 与 HTTP API 共用同一套核心模块和数据库

---

## 快速使用

推荐直接使用预构建镜像：

```text
ghcr.io/nekroai/mihomo-hive:latest
```

`docker-compose.yml`：

```yaml
services:
  mihomo-hive:
    image: ghcr.io/nekroai/mihomo-hive:latest
    container_name: mihomo-hive
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./runtime:/data
    environment:
      HIVE_HOST: 0.0.0.0
      HIVE_PORT: 9990
      HIVE_CONFIG: /data/hive.config.json
      HIVE_DATA_DIR: /data
      HIVE_GENERATED_DIR: /data/generated
      MIHOMO_BIN: /usr/local/bin/mihomo
```

启动 / 更新：

```bash
docker compose up -d           # 启动
docker compose pull && docker compose up -d   # 更新到最新镜像
```

数据保存在 `./runtime`，更新镜像和重建容器不会清空配置、节点和访问密码。

打开 Web UI，首次访问要求设置访问密码：

```text
http://127.0.0.1:9990
```

`HIVE_HOST` / `HIVE_PORT` 可通过环境变量改：

```yaml
environment:
  HIVE_HOST: 127.0.0.1
  HIVE_PORT: 9991
```

---

## Web UI 三个工作区

顶部 segmented tab 切换：

| 工作区 | 干什么 |
|---|---|
| **节点池** | 导入订阅、勾选节点、分配端口、测试、启用调度。日常操作主战场 |
| **账号编排** | 配置 Sub2API 连接 + Spec 策略；展示编排状态（KPI / 节点矩阵 / 最近调和） |
| **导出** | 把当前选中节点打包成 Sub2API JSON（下载或写入服务器文件） |

### 节点池工作流

进入节点池后，按工具栏从左到右走：

1. **左栏导入订阅** — 添加订阅 URL，预览，勾选要保留的节点
2. **勾选 + 【分配端口】** — 给所选节点分端口、渲染 Mihomo 配置、reload listener。不动 lifecycle、不推 Sub2API
3. **【测试所选】或【测试全部】** — L1 直连握手延迟 + L2 OpenAI/Claude 端到端延迟，颜色编码立刻看出哪个节点慢
4. **【启用调度】** — 把所选节点 lifecycle 设为 `schedulable`，**同时**推送到 Sub2API 并回填 proxy_id。完成后节点立即出现在账号编排页节点矩阵
5. （可选）切到**账号编排** tab 配置 Spec，让编排器接管账号绑定

> **如果只用订阅转换功能**：只需要 1 → 2 → 3，跳过启用调度。节点已经在 `127.0.0.1:{port}` 上可用，直接接到上游。

下拉菜单（工具栏 `⋯`）里是低频动作：
- **诊断 → 重建 Mihomo**：yaml 损坏 / 进程异常时的强制重渲染 + reload，不动其他状态
- **生命周期**：暂停 / 冷却 / 退役 / 删除（所选）
- **筛选**：选择 status=active 的节点

### 导出 JSON 结构

```json
{
  "proxies": [
    {
      "proxy_key": "socks5|127.0.0.1|10001||",
      "name": "node-001",
      "protocol": "socks5",
      "host": "127.0.0.1",
      "port": 10001,
      "status": "active"
    }
  ],
  "accounts": []
}
```

`proxy_key` 格式 `protocol|host|port|username|password` 是 Sub2API 端做幂等去重的依据，**禁止修改**。

---

## CLI 自动化

CLI 与 Web UI 使用同一套数据库和核心逻辑，适合脚本化任务和排障：

```bash
# 订阅 / 节点
docker exec mihomo-hive node apps/cli/dist/index.js sub list
docker exec mihomo-hive node apps/cli/dist/index.js sub add --name demo --url "https://example.com/sub"
docker exec mihomo-hive node apps/cli/dist/index.js sub fetch
docker exec mihomo-hive node apps/cli/dist/index.js nodes import
docker exec mihomo-hive node apps/cli/dist/index.js nodes list

# 端口 / 配置 / Mihomo
docker exec mihomo-hive node apps/cli/dist/index.js ports assign --range 10001-10300
docker exec mihomo-hive node apps/cli/dist/index.js mihomo render
docker exec mihomo-hive node apps/cli/dist/index.js mihomo start
docker exec mihomo-hive node apps/cli/dist/index.js mihomo status

# 测试（L1 + L2，结果与 Web UI 一致）
docker exec mihomo-hive node apps/cli/dist/index.js nodes test --targets openai,claude --timeout-ms 15000 --concurrency 8

# 导出
docker exec mihomo-hive node apps/cli/dist/index.js export sub2api --host 127.0.0.1 --output /data/generated/sub2api-proxies.json
```

内置测试目标：

- `ip`：`https://api.ipify.org`，期望 HTTP 200
- `openai`：`https://api.openai.com/v1/models`，无 token 时期望 HTTP 401
- `claude`：`https://api.anthropic.com/v1/messages`，GET 请求期望 HTTP 405

### 忘记访问密码

```bash
docker exec mihomo-hive node apps/cli/dist/index.js auth reset-password --password "new-strong-password"

# 或从 stdin 传，避免落入 shell 历史
printf '%s' 'new-strong-password' | docker exec -i mihomo-hive node apps/cli/dist/index.js auth reset-password --password-stdin
```

重置密码会撤销所有已登录会话。

---

## 开发

TypeScript monorepo：

- Node.js 22 LTS（兼容 Node.js 20）
- pnpm workspace
- Hono + tRPC + Zod
- SQLite WAL + Drizzle ORM
- React + Vite + TanStack Query

本地开发命令：

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm --filter @mihomo-hive/server dev
```

更多技术文档：

- [架构总览](docs/architecture.md)
- [数据模型](docs/data-model.md)
- [运维手册](docs/runbook.md)
- [CI/CD](docs/cicd.md)
- [ADR 0003 声明式编排](docs/decisions/0003-declarative-orchestration.md)
