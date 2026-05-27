# Mihomo Hive AI 开发指南

Mihomo Hive 是一个 AI-first TypeScript monorepo，用于基于 Mihomo 构建固定出口代理池，并接管 Sub2API 中由本系统创建的代理及其账号绑定的自动化调度。

## 产品定位

不要把项目当成"节点导入 + Mihomo 操作面板"。用户只需要维护两件事：

1. **节点池**：导入订阅、预览筛选、测试、启用/暂停/排空/删除。
2. **Sub2API 自动化**：连接配置、保护代理。系统接管推送、协调、排空、清理、质量检查。

任务暴露要表达"业务意图"，不要把"分配端口 / 渲染配置 / reload / 导出 JSON / 手动绑定账号"作为主流程。

## 核心规则

- 所有产品类型放在 `packages/schemas`（Zod schema 是唯一定义源）。
- 业务逻辑放在 `packages/core`。
- 持久化逻辑放在 `packages/db`，统一通过 `HiveRepository`。
- CLI、server、UI 必须复用共享包，不要复制业务逻辑。
- 不要为 API 出口引入负载均衡或随机 fallback。
- **允许**基于用户策略（保护规则）、预览计划（preview）和审计记录（OperationJob）三件套的确定性账号代理重绑定。
- **禁止**无审计、随机或不可解释的账号迁移。这条比旧版"禁止账号自动迁移"更精确：系统主动接管调度是产品目标；只要操作可解释、可回溯、可预览，就属于"允许的自动化"。
- Sub2API 导出必须保持稳定格式：`proxy_key = protocol|host|port|username|password`。Sub2API 端依赖这个 key 做幂等去重。
- Hive 创建的 Sub2API 代理必须带可配置前缀（默认 `MH-`），用于区分"本系统管理"和"用户手工录入"，所有 drain/cleanup/quality 操作只针对带前缀的代理。

## 数据流

```
订阅源 → 预览（过滤命中已存在节点会标记删除）
       → 应用导入 → 节点候选池
       → 测试节点（curl + socks5h 通过 Mihomo listener）
       → 用户启用调度 → schedulable
       → 端口分配 → Mihomo 渲染 + reload
       → automation.syncManagedProxies 推到 Sub2API
       → automation.reconcile / drain / cleanup / quality 维护账号绑定
```

所有跨 Sub2API 的危险操作必须 preview → confirm → apply 三阶段，apply 端服务器重新读取 live 数据，禁止信任前端 stale snapshot。

## 部署假设

生产部署使用预构建镜像（`ghcr.io/nekroai/mihomo-hive:latest`）+ Docker `network_mode: host`。Mihomo 默认监听 `127.0.0.1:10001-10300`。Sub2API 与本项目通常运行在同一台主机；HIVE_HOST 默认 `0.0.0.0`，HIVE_PORT 默认 `9990`。

## 文档与提交规范

- 公开文档（README、docs/）面向开源用户，不写真实服务器名、密钥、内部环境信息。
- 本地参考资料（含密钥/cookie/抓包）放在 `Sub2API*.md` 或 `notes/`，已被 `.gitignore` 和 `.dockerignore` 屏蔽，绝不入库。
- 提交信息中文/英文皆可，但每次提交说清"动机"，不仅"做了什么"。
- 危险操作（force push / reset --hard / 删除大量数据）默认审批，工程师手动确认。
