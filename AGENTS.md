# Mihomo Hive AI 开发指南

Mihomo Hive 是一个 AI-first TypeScript monorepo，用于基于 Mihomo 构建固定出口代理池。

## 核心规则

- 所有产品类型放在 `packages/schemas`。
- 业务逻辑放在 `packages/core`。
- 持久化逻辑放在 `packages/db`。
- CLI、server、UI 必须复用共享包，不要复制业务逻辑。
- 不要为 API 出口引入负载均衡或随机 fallback。
- 允许基于用户策略、预览计划和审计记录的确定性账号代理重绑定；禁止无审计、随机或不可解释的账号迁移。
- Sub2API 导出必须保持稳定格式：`proxy_key = protocol|host|port|username|password`。

## 部署假设

首个生产目标是 `ssh nexus-star`，使用 Docker `network_mode: host`。
Mihomo 默认监听 `127.0.0.1:10001-10300`，Sub2API 与本项目运行在同一台主机。
