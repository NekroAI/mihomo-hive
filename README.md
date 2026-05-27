# Mihomo Hive

Mihomo Hive 是一个固定出口代理池管理工具，用于把订阅中的代理节点整理成稳定、可测试、可导出的本地代理入口。

它适合需要“一个身份长期绑定一个出口”的自动化场景：从订阅中提取节点，为节点分配固定本地端口，并通过 Web UI、API 或导出文件交给上游系统使用。

```text
127.0.0.1:10001 -> 节点 A
127.0.0.1:10002 -> 节点 B
127.0.0.1:10003 -> 节点 C
```

## 能力概览

**节点池**
- 导入 Clash YAML 和 base64 节点订阅（自动定期刷新，新节点自动入池，被过滤的旧节点自动删除）。
- 按稳定 hash 去重；按地区、关键词、协议等规则筛选。
- 节点连通性测试（OpenAI / Claude / IP echo），可配最大延迟门槛拒入池。
- 为每个可调度节点分配稳定本地端口，订阅更新后尽量保持端口不漂移。
- 完整生命周期管理：候选 → 启用 → 冷却 → 退役 → 删除，每步都能手动也都能自动。
- 生成 Mihomo 多 listener 配置；服务启动自动 boot / reload。

**声明式编排（Sub2API 自动接管）**
- 用户在 Spec 里描述"节点池和账号绑定应该是什么样"，系统每 30 秒跑一次 reconcile 自动调节实际状态。
- 入站代理（intake proxy）：用户在 Sub2API 后台配的兜底代理；新账号默认挂这里，reconcile 自动引流到合适的 Hive 节点。
- 保护代理规则：双向锁定—不会被分配新账号，已绑账号也不会被搬走。
- 容量再平衡：过载节点上的账号按 LIFO 外迁到欠载节点；HRW 哈希让节点集合变化时漂移最少（≈ 1/N）。
- 故障自愈：基于 Sub2API upstream-errors 滑动窗口；错误超预算 → 退避（1m / 5m / 15m / 1h / 6h）→ 永久驱逐 → 退役。
- 灰度阀 + 火警开关：单次 reconcile 限 10% / 50 个账号，策略错也炸不了全集群；暂停态仍跑 dry-run 写审计。
- 切换日工具：哈希策略切换前完整预览影响范围，确认后一次性执行。

**审计可观测**
- 每次 reconcile 写一条 `reconcile_ticks` 行（observed / planned / applied 全量 JSON），自动保留 7 天。
- 任意节点危险操作（删除 / 排空）作为 OperationJob 可在 UI 追溯。
- Web UI 实时 KPI：节点池供给 / 承载效率 / 24h 漂移数 / 退避中节点。

**部署**
- 预构建 Docker 镜像（GHCR）+ host network 直接监听本地端口。
- CLI 与 HTTP API 共用同一套核心模块和数据库。

## 快速使用

Mihomo Hive 推荐直接使用预构建镜像：

```text
ghcr.io/nekroai/mihomo-hive:latest
```

创建 `docker-compose.yml`：

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

启动服务：

```bash
docker compose up -d
```

更新应用：

```bash
docker compose pull
docker compose up -d
```

数据会保存在 `./runtime` 目录中，更新镜像和重建容器不会清空已有配置、节点和访问密码。

打开 Web UI。首次访问会要求设置访问密码：

```text
http://127.0.0.1:9990
```

`HIVE_HOST` 控制 Web UI/API 监听地址，默认是 `0.0.0.0`；`HIVE_PORT` 控制监听端口，默认是 `9990`。两者都可以通过环境变量覆盖：

```yaml
environment:
  HIVE_HOST: 127.0.0.1
  HIVE_PORT: 9991
```

## Web UI 工作流

进入 Web UI 后，可以按顺序完成：

1. 添加订阅 URL。
2. 拉取订阅。
3. 导入节点。
4. 设置端口段并分配端口。
5. 生成 Mihomo 配置。
6. 启动或 reload Mihomo。
7. 测试 OpenAI / Claude 连通性。
8. 写出 Sub2API JSON。

导出的 Sub2API JSON 结构示例：

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

## CLI 自动化

CLI 与 Web UI 使用同一套数据库和核心逻辑，适合脚本化任务和排障：

```bash
docker exec mihomo-hive node apps/cli/dist/index.js sub list
docker exec mihomo-hive node apps/cli/dist/index.js nodes list
docker exec mihomo-hive node apps/cli/dist/index.js mihomo status
docker exec mihomo-hive node apps/cli/dist/index.js export sub2api --host 127.0.0.1 --output /data/generated/sub2api-proxies.json
```

忘记访问密码时，可以在服务器上手动重置。重置会同时撤销所有已登录会话：

```bash
docker exec mihomo-hive node apps/cli/dist/index.js auth reset-password --password "new-strong-password"
```

也可以从标准输入传入密码，避免把密码留在 shell 历史里：

```bash
printf '%s' 'new-strong-password' | docker exec -i mihomo-hive node apps/cli/dist/index.js auth reset-password --password-stdin
```

## 开发

本项目使用 TypeScript monorepo：

- Node.js 22 LTS，兼容 Node.js 20。
- pnpm workspace。
- Hono + tRPC + Zod。
- SQLite WAL + Drizzle ORM。
- React + Vite + TanStack Query + shadcn/ui + Tailwind CSS。
- Vitest、tsc、eslint、prettier。

本地开发命令：

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm --filter @mihomo-hive/server dev
```
