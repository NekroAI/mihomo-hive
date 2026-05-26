# ADR 0002：nexus-star 使用 Docker Host Network

首个生产目标使用 Docker `network_mode: host`。

项目预计需要 100-300 个本地代理端口。Host network 可以避免 Docker bridge NAT 和大量 `ports:` 映射，同时默认让 Mihomo 绑定在 `127.0.0.1`。
