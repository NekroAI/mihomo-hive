# 数据模型

重要 schema 位于 `packages/schemas`。

- `RuntimeConfig`：监听地址、导出地址、端口段、路径和 Mihomo binary 配置。
- `ProxyNode`：标准化后的订阅节点，包含基于完整原始节点配置生成的稳定 hash、原始 Clash 兼容配置、测试状态、生命周期、调度开关和分配端口。
- `NodeLifecycleStatus`：节点池生命周期，区分候选、可调度、暂停、排空、冷却、退役和删除。
- `SubscriptionImportPreview`：订阅拉取后的预览结果，展示将导入、更新、过滤、重复或已存在的节点。
- `NodeDeletionPlan`：节点删除前的影响面，包含 Sub2API 阻塞账号和是否需要先排空。
- `FilterProfile`：用于筛选节点的包含/排除规则。
- `Sub2ApiExport`：供 Sub2API 消费的导出 JSON。
- `Sub2ApiReconcilePlan`：Sub2API 账号代理绑定计划，服务端会在应用前重新读取 live 数据。
- `Sub2ApiMaintenancePreview`：Sub2API 托管代理维护计划，统计可排空账号、可清理空代理和风险项。
- `OperationJob`：后台发布、协调和其他长任务的状态记录。

SQLite schema 与这些对象保持对应，并将原始节点配置保存为 JSON。
