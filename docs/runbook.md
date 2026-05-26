# 运维手册

## 本地开发

```bash
pnpm install
pnpm check
pnpm --filter @mihomo-hive/cli hive init
pnpm --filter @mihomo-hive/server dev
```

## nexus-star 部署

```bash
docker compose up -d --build
```

Compose 文件使用 `network_mode: host`。不要添加 100-300 个 Docker 端口映射。

Sub2API 与 Mihomo Hive 同机部署时，导出 host 保持 `127.0.0.1` 即可。

使用 GHCR 镜像部署时：

```bash
docker compose pull
docker compose up -d
```

## 典型流程

```bash
hive init
hive sub add --url "https://example.com/sub"
hive sub fetch
hive nodes import
hive ports assign --range 10001-10300
hive mihomo render
hive export sub2api --host 127.0.0.1 --output generated/sub2api-proxies.json
```
