# AI 开发指南

本项目专门为 AI 后续接管和持续迭代设计。

- 先阅读 `packages/schemas` 理解产品概念。
- 修改 CLI、API 或 UI 前，先阅读 `packages/core`。
- 优先在纯函数旁边补测试。
- 生成文件格式必须保持确定性，避免无意义 diff。
- 数据库迁移必须兼容已有 SQLite 状态。
