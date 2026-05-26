# Mihomo Hive

Mihomo Hive 是一个固定出口代理池管理工具，用于把订阅中的代理节点整理成稳定、可测试、可导出的本地代理入口。

它适合需要“一个身份长期绑定一个出口”的自动化场景：从订阅中提取节点，为节点分配固定本地端口，并通过 Web UI、API 或导出文件交给上游系统使用。

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
- 通过 Web UI 完成订阅拉取、节点导入、端口分配、连通性测试、配置生成和导出。
- 生成 Mihomo 多 listener 配置。
- 批量测试节点到 IP echo、OpenAI API、Claude API 等目标的连通性。
- 导出 Sub2API 兼容代理 JSON。
- 提供 CLI 和 HTTP API，便于自动化运维。

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
