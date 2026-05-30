/**
 * 外置 codex-tool agent 的"单口动态出口"运行时支持(server 侧)。
 *
 *   - 鉴权 user/pass:进程级随机单例,不落库,跨重渲染稳定;同时用于 ① Mihomo codex 口的
 *     users ② 下发给 agent 的代理 URL。
 *   - codexEgressRenderOpts:给 renderMihomoConfig 的 codexEgress 入参(仅在 agent+dynamic 开启时)。
 *   - isAgentHealthy:调用前探活。
 */

import { createHmac, randomBytes } from "node:crypto";
import type { AccountFleetSpec } from "@mihomo-hive/schemas";
import type { CodexEgressOptions } from "@mihomo-hive/core";
import type { HiveRepository } from "@mihomo-hive/db";

let _auth: { user: string; pass: string } | null = null;

/**
 * codex-egress 唯一鉴权口的凭据。**不落库**:从 HIVE_ACCOUNT_KEY 派生(HMAC,单向),
 * 这样跨进程重启稳定 —— 否则随机值重启后会与已持久化的 mihomo.yaml 里的 users 不一致
 * (server 启动不重渲染 mihomo,只复用旧配置),导致 agent 代理鉴权 407。
 * 无 HIVE_ACCOUNT_KEY(开发机)时退回进程级随机值。
 */
export function codexEgressAuth(): { user: string; pass: string } {
  if (!_auth) {
    const key = process.env.HIVE_ACCOUNT_KEY;
    const pass = key
      ? createHmac("sha256", key).update("codex-egress-listener-v1").digest("base64url").slice(0, 32)
      : randomBytes(24).toString("base64url");
    _auth = { user: "codex", pass };
  }
  return _auth;
}

export interface CodexEgressRuntime {
  /** 是否启用"单口 + 动态切组"出口(remoteAgent.enabled && codexEgress.dynamic && host 已配)。 */
  enabled: boolean;
  port: number;
  bindHost: string;
  host: string;
  user: string;
  pass: string;
}

export function codexEgressRuntime(spec: AccountFleetSpec): CodexEgressRuntime {
  const ce = spec.codexTool.codexEgress;
  const auth = codexEgressAuth();
  const enabled = Boolean(spec.codexTool.remoteAgent?.enabled && ce?.dynamic && (ce?.host ?? "").length > 0);
  return {
    enabled,
    port: ce?.port ?? 19000,
    bindHost: ce?.bindHost ?? "0.0.0.0",
    host: ce?.host ?? "",
    user: auth.user,
    pass: auth.pass
  };
}

/** 渲染 Mihomo 时给 renderMihomoConfig 的 codexEgress 入参;未启用返回 undefined。 */
export function codexEgressRenderOpts(repo: HiveRepository): CodexEgressOptions | undefined {
  let spec: AccountFleetSpec;
  try {
    spec = repo.getAccountFleetSpec();
  } catch {
    return undefined;
  }
  const rt = codexEgressRuntime(spec);
  if (!rt.enabled) return undefined;
  return { port: rt.port, bindHost: rt.bindHost, user: rt.user, pass: rt.pass };
}

/** 探活外置 agent。5s 超时,任何异常视为不健康。 */
export async function isAgentHealthy(url: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    return res.ok;
  } catch {
    return false;
  }
}
