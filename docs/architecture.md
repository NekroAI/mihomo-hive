# 架构

Mihomo Hive 将订阅节点转换为稳定的本地代理出口。

```text
subscriptions
  -> parser/importer
  -> filter profiles
  -> port allocator
  -> generated/mihomo.yaml
  -> single Mihomo process with many mixed listeners
  -> Sub2API 兼容导出
```

首个部署目标是 `nexus-star`，Sub2API 也在同一台主机上运行，使用 `127.0.0.1` 访问导出的代理端口。应用使用 Docker host network，不配置 Docker `ports:` 映射，因为 Mihomo 会直接绑定宿主机 loopback 地址。

## 运行模型

- 一个 Node.js 服务提供 API，并托管构建后的 UI。
- 一个 Mihomo 进程由 Node 服务或 CLI 控制。
- SQLite WAL 存储订阅、节点、端口分配和测试结果。
- 生成物写入 `generated/`。

## 固定出口不变量

每个 active 节点获得一个稳定本地端口。节点不可用时只更新状态，不自动迁移账号或端口绑定。
