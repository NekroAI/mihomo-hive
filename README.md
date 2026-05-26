# Mihomo Hive

Mihomo Hive 是一个固定出口代理池管理工具，用于把订阅中的代理节点整理成稳定、可导出的本地代理入口。

它适合需要“一个身份长期绑定一个出口”的自动化场景：先从订阅中提取节点，再为每个节点分配固定本地端口，最后导出给上游系统使用。

```text
127.0.0.1:10001 -> 节点 A
127.0.0.1:10002 -> 节点 B
127.0.0.1:10003 -> 节点 C
```

## 能力概览

- 导入 Clash YAML 和 base64 节点订阅。
- 使用 Clash 兼容请求头拉取订阅内容。
- 标准化节点信息，并按稳定 hash 去重。
- 按地区、关键词、协议等规则筛选节点。
- 为节点分配稳定本地端口，订阅更新后尽量保持端口不漂移。
- 生成 Mihomo 多 listener 配置。
- 批量测试节点到 IP echo、OpenAI API、Claude API 等目标的连通性。
- 导出 Sub2API 兼容代理 JSON。
- 提供 CLI、HTTP API 和轻量 Web UI。

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
      HIVE_CONFIG: /data/hive.config.json
      HIVE_DATA_DIR: /data
      HIVE_GENERATED_DIR: /data/generated
      MIHOMO_BIN: /usr/local/bin/mihomo
```

启动服务：

```bash
docker compose up -d
```

导入订阅并生成出口：

```bash
docker exec mihomo-hive node apps/cli/dist/index.js sub add --name demo --url "https://example.com/sub"
docker exec mihomo-hive node apps/cli/dist/index.js sub fetch
docker exec mihomo-hive node apps/cli/dist/index.js nodes import
docker exec mihomo-hive node apps/cli/dist/index.js ports assign --range 10001-10300
docker exec mihomo-hive node apps/cli/dist/index.js mihomo render
docker exec mihomo-hive node apps/cli/dist/index.js mihomo start
docker exec mihomo-hive node apps/cli/dist/index.js export sub2api --host 127.0.0.1 --output /data/generated/sub2api-proxies.json
```

筛选可用节点：

```bash
docker exec mihomo-hive node apps/cli/dist/index.js nodes test --targets openai,claude --timeout-ms 15000 --concurrency 8
docker exec mihomo-hive node apps/cli/dist/index.js mihomo render
docker exec mihomo-hive node apps/cli/dist/index.js mihomo reload
docker exec mihomo-hive node apps/cli/dist/index.js export sub2api --host 127.0.0.1 --output /data/generated/sub2api-proxies.json
```

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

## CLI 常用命令

```bash
docker exec mihomo-hive node apps/cli/dist/index.js sub list
docker exec mihomo-hive node apps/cli/dist/index.js nodes list
docker exec mihomo-hive node apps/cli/dist/index.js mihomo status
docker exec mihomo-hive node apps/cli/dist/index.js mihomo stop
```

## Web UI

服务启动后，Web UI 默认监听：

```text
http://127.0.0.1:8787
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
