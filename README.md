# Mihomo Hive

Mihomo Hive 是一个面向 AI 持续开发的固定出口代理池管理工具。

首版目标部署在 `nexus-star` Linux 主机，Sub2API 也部署在同一台主机。项目使用 Docker `network_mode: host`，通过单个 Mihomo 进程生成 100-300 个本地 mixed listeners。

```text
127.0.0.1:10001 -> 节点 A
127.0.0.1:10002 -> 节点 B
127.0.0.1:10003 -> 节点 C
```

## 核心能力

- 导入 Clash YAML 和 base64 节点订阅。
- 默认使用 `Clash.Meta` 请求头拉取机场订阅，避免服务端按旧客户端返回占位节点。
- 标准化节点并按 hash 去重。
- 支持地区、关键词、协议过滤。
- 自动分配稳定端口段。
- 生成单进程多 listener 的 Mihomo 配置。
- 导出 Sub2API 兼容 JSON。
- 提供 CLI、Hono API 和轻量 Web UI。

## 快速开始

```bash
pnpm install
pnpm check
pnpm --filter @mihomo-hive/cli hive init
pnpm --filter @mihomo-hive/cli hive sub add --name demo --file ./subscriptions/source.yaml
pnpm --filter @mihomo-hive/cli hive nodes import
pnpm --filter @mihomo-hive/cli hive ports assign --range 10001-10300
pnpm --filter @mihomo-hive/cli hive mihomo render
pnpm --filter @mihomo-hive/cli hive export sub2api --host 127.0.0.1
```

## nexus-star 部署

```bash
docker compose up -d --build
```

Compose 文件使用 host network，不配置 100-300 个 Docker `ports:` 映射。

## 非目标

首版不实现账号调度、自动换节点、随机负载均衡或平台风控规避策略。
