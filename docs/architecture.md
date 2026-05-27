# 架构

Mihomo Hive v2 将代理订阅转换为稳定、可测试、可调度的本地出口池，并通过 Sub2API 连接器维护账号到代理的确定性绑定。

```text
订阅源
  -> 拉取并预览
  -> 筛选导入候选节点
  -> 测试并启用调度
  -> 发布 Mihomo 本地 mixed listeners
  -> 同步 Sub2API 代理映射
  -> 生成并应用账号绑定计划
```

## 运行模型

- Node.js 服务提供 HTTP API，并托管构建后的 Web UI。
- CLI 与服务共用同一套核心模块和数据库模型。
- SQLite WAL 存储订阅源、节点、端口分配、测试结果和运行状态。
- Mihomo 负责监听本地端口并把每个入口固定到指定节点。
- 生成物默认写入 `generated/` 或容器中的 `/data/generated/`。

## 固定出口模型

每个 `schedulable` 节点获得一个稳定本地端口。订阅更新后，系统会基于节点 hash 复用已有端口，从而让上游系统可以长期绑定同一个出口。

节点测试失败时会进入 `cooling_down`，不会继续作为新增账号的调度目标。删除节点前系统会生成排空计划，确认 Sub2API 中没有账号继续使用该代理后再删除。

## 节点生命周期

- `candidate`：订阅预览后导入的候选节点，尚未参与调度。
- `schedulable`：可发布到 Mihomo 并参与 Sub2API 账号绑定。
- `disabled`：用户暂停调度，不再作为新绑定目标。
- `draining`：准备下线，等待账号迁出。
- `cooling_down`：质量检测失败或被系统冷却。
- `retired` / `deleted`：不再参与运行和导出。

## Sub2API 协调模型

Sub2API 集成遵循“托管代理前缀 -> 保护代理 -> 推导保护账号 -> 计划化重绑定”的规则。Mihomo Hive 导出的代理名称会带有统一前缀，便于系统识别哪些代理由本应用管理。用户只选择保护代理节点，系统根据账号当前 `proxy_id` 自动推导保护账号。所有绑定变更都先生成预览计划，应用时服务端重新读取 Sub2API live 数据，避免使用过期前端状态。

维护类操作也按同一套识别规则执行：

- 一键排空 Hive 代理：将绑定到托管代理的账号迁移到非保护、非托管、active 的代理上。
- 清理空 Hive 代理：只删除没有账号使用且名称带托管前缀的代理。

## 模块划分

- `packages/schemas`：Zod schema 和共享类型。
- `packages/core`：订阅解析、过滤、端口分配、配置渲染、节点测试。
- `packages/db`：SQLite 仓储层。
- `packages/mihomo`：Mihomo 进程控制。
- `packages/exporters`：Sub2API 等导出格式。
- `apps/cli`：命令行工具。
- `apps/server`：Hono API、tRPC 路由、静态 UI 托管。
- `apps/web`：React Web UI。
