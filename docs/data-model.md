# 数据模型

重要 schema 位于 `packages/schemas`。

- `RuntimeConfig`：监听地址、导出地址、端口段、路径和 Mihomo binary 配置。
- `ProxyNode`：标准化后的订阅节点，包含基于完整原始节点配置生成的稳定 hash、原始 Clash 兼容配置、状态和分配端口。
- `FilterProfile`：用于筛选节点的包含/排除规则。
- `Sub2ApiExport`：供 Sub2API 消费的导出 JSON。

SQLite schema 与这些对象保持对应，并将原始节点配置保存为 JSON。
