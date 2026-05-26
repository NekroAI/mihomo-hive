# 运维手册

本文档记录 Mihomo Hive 的常用运行流程。公开部署建议直接使用预构建镜像，并将运行数据挂载到独立目录。

## 启动服务

```bash
docker compose up -d
```

服务启动后会自动创建运行配置，并将数据库、生成配置、导出文件保存在挂载的数据目录中。Web UI 默认地址：

```text
http://127.0.0.1:9990
```

可以通过 `HIVE_PORT` 修改 Web UI 端口。

## Web UI 流程

控制台左侧是操作流水线，按顺序执行：

1. 添加订阅 URL。
2. 拉取订阅。
3. 导入节点。
4. 设置端口段并分配端口。
5. 生成 Mihomo 配置。
6. 启动或 reload Mihomo。
7. 测试 OpenAI / Claude 连通性。
8. 写出 Sub2API JSON。

中间表格展示节点、端口、状态和最近测试结果；右侧展示运行配置和 Sub2API 导出预览。

## CLI 自动化

CLI 与 Web UI 使用同一套数据库和核心逻辑，适合脚本化任务和排障。

订阅导入：

```bash
hive sub add --name demo --url "https://example.com/sub"
hive sub fetch
hive nodes import
```

`sub list` 只展示订阅摘要，不输出订阅正文。

端口分配与配置生成：

```bash
hive ports assign --range 10001-10300
hive mihomo render
hive mihomo start
```

端口分配基于节点 hash 尽量保持稳定。订阅更新后，同一个节点会优先复用原端口。

节点连通性测试：

```bash
hive nodes test --targets openai,claude --timeout-ms 15000 --concurrency 8
```

内置测试目标：

- `ip`：访问 `https://api.ipify.org`，期望 HTTP 200。
- `openai`：访问 `https://api.openai.com/v1/models`，无 token 时期望 HTTP 401。
- `claude`：访问 `https://api.anthropic.com/v1/messages`，GET 请求期望 HTTP 405。

测试通过的节点保持 `active`，失败节点标记为 `failed`。测试完成后重新渲染并热加载配置：

```bash
hive mihomo render
hive mihomo reload
```

Sub2API 导出：

```bash
hive export sub2api --host 127.0.0.1 --output /data/generated/sub2api-proxies.json
```

导出文件会保留已分配端口，并通过 `active` / `inactive` 表示当前状态，便于上游系统继续维护稳定绑定关系。

## 开发模式

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm --filter @mihomo-hive/server dev
```
