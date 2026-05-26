# 架构

Mihomo Hive 将代理订阅转换为稳定、可测试、可导出的本地出口池。

```text
订阅源
  -> 解析与标准化
  -> 节点过滤
  -> 稳定端口分配
  -> Mihomo 配置生成
  -> 本地 mixed listeners
  -> Sub2API 兼容导出
```

## 运行模型

- Node.js 服务提供 HTTP API，并托管构建后的 Web UI。
- CLI 与服务共用同一套核心模块和数据库模型。
- SQLite WAL 存储订阅源、节点、端口分配、测试结果和运行状态。
- Mihomo 负责监听本地端口并把每个入口固定到指定节点。
- 生成物默认写入 `generated/` 或容器中的 `/data/generated/`。

## 固定出口模型

每个 active 节点获得一个稳定本地端口。订阅更新后，系统会基于节点 hash 复用已有端口，从而让上游系统可以长期绑定同一个出口。

节点测试失败时会更新状态；重新生成配置后，导出文件仍保留端口与状态信息，方便外部系统做渐进迁移或人工处理。

## 模块划分

- `packages/schemas`：Zod schema 和共享类型。
- `packages/core`：订阅解析、过滤、端口分配、配置渲染、节点测试。
- `packages/db`：SQLite 仓储层。
- `packages/mihomo`：Mihomo 进程控制。
- `packages/exporters`：Sub2API 等导出格式。
- `apps/cli`：命令行工具。
- `apps/server`：Hono API、tRPC 路由、静态 UI 托管。
- `apps/web`：React Web UI。
