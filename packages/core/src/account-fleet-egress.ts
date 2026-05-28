/**
 * 账号编排的代理出口选择 —— 质量+负载加权随机，软粘性（login 时优先用过的节点）。
 *
 * 设计原则（notes/account-fleet-design.md 补充）：
 *   - 不是严格绑定。账号编排只对 codex-tool 调用的出口代理选择负责；
 *     reconcile 期间的 account.proxy_id 绑定仍归代理编排。
 *   - 注册（register / import_to_sub2api）：在质量合格池中加权随机，让新账号
 *     IP 出生地自然分散，避免"永远在同一个节点注册"被风控。
 *   - 登录（codex_login）：优先尝试账号上次绑定的节点（egressNodeHash）；
 *     它不再满足质量门槛 → fallback 到注册逻辑。
 *   - 连通性兜底：质量池为空时不抛错，宽松池（schedulable + active + assignedPort）
 *     再选一个；宽松池也为空 → 真没法跑，抛 NoEgressAvailableError。
 *
 * 加权公式：weight = max(1, qualityScore) / (currentLoad + 1)
 *   - qualityScore 高的节点优先（quality 越高权重越大）
 *   - currentLoad 高的节点降权（负载越低权重越大）
 *   - +1 避免除零；max(1) 防止 qualityScore=0 时权重为 0 完全不被选
 *
 * 随机性：默认 Math.random()；测试可注入 seedable rand。
 */

import type { ProxyNode } from "@mihomo-hive/schemas";

export class NoEgressAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoEgressAvailableError";
  }
}

export interface EgressCandidate {
  hash: string;
  port: number;
  qualityScore: number;
  /** 当前有多少个 hive accounts 把这个节点作为 egressNodeHash（负载估计） */
  load: number;
  /** lastTestTargets 中 openai 目标是否 ok */
  openaiOk: boolean;
  /** 节点是否经过测试 —— 没测过的不优先 */
  tested: boolean;
}

export interface EgressSelection {
  hash: string;
  port: number;
  reason: "preferred" | "weighted_quality" | "fallback_relaxed";
}

export interface EgressSelectorInput {
  nodes: ProxyNode[];
  /** account.id → egressNodeHash 的反查表，用于估计每个节点的当前出口负载。 */
  egressLoadByNodeHash: Map<string, number>;
  /** 测试随机数源；默认 Math.random()。 */
  rand?: () => number;
}

/**
 * 把 ProxyNode 列表过滤到"可作出口"的候选，并按 quality / load 打分。
 *
 * 过滤规则（严格池）：
 *   schedulable && status='active' && assignedPort && lastTestTargets 中 openai.ok=true
 *
 * 宽松池（严格池为空时 fallback）：
 *   schedulable && status='active' && assignedPort
 *   **且** 不能是"已测过且明确 openai.ok=false"的节点（保留未测过的，因为可能可用）
 *
 * 这条约束实现"至少不要把明知 openai 不通的节点选出来"——如果用户最初要求是
 * 严格的 openai 连通性兜底，宽松池就只允许 strict + 未测过的，不允许已确认失败的。
 */
export function buildEgressCandidates(input: EgressSelectorInput): {
  strict: EgressCandidate[];
  relaxed: EgressCandidate[];
} {
  const strict: EgressCandidate[] = [];
  const relaxed: EgressCandidate[] = [];
  for (const node of input.nodes) {
    if (!node.schedulable || node.status !== "active" || !node.assignedPort) continue;
    const load = input.egressLoadByNodeHash.get(node.hash) ?? 0;
    const quality = node.qualityScore ?? 50;
    const { openaiOk, tested } = inspectOpenAITestResult(node);
    const candidate: EgressCandidate = {
      hash: node.hash,
      port: node.assignedPort,
      qualityScore: quality,
      load,
      openaiOk,
      tested
    };
    // 严格池：必须 openai 测过且通过
    if (openaiOk) strict.push(candidate);
    // 宽松池：openai 通过 ∪ 未测过；排除"测过且失败"
    if (openaiOk || !tested) relaxed.push(candidate);
  }
  return { strict, relaxed };
}

/**
 * 解析 ProxyNode.lastTestTargets（JSON 字符串）找到 openai 目标的结果。
 * 缺测 / 解析失败 → 视为 {openaiOk:false, tested:false}。
 */
function inspectOpenAITestResult(node: ProxyNode): { openaiOk: boolean; tested: boolean } {
  if (!node.lastTestTargets) return { openaiOk: false, tested: false };
  try {
    const arr = JSON.parse(node.lastTestTargets) as Array<{ targetId?: string; ok?: boolean }>;
    if (!Array.isArray(arr)) return { openaiOk: false, tested: false };
    const openai = arr.find((row) => row?.targetId === "openai");
    if (!openai) return { openaiOk: false, tested: false };
    return { openaiOk: Boolean(openai.ok), tested: true };
  } catch {
    return { openaiOk: false, tested: false };
  }
}

/**
 * 注册场景 —— 在严格池中按 quality/load 加权随机选一个。
 * 严格池空 → 宽松池选一个；宽松池空 → 抛 NoEgressAvailableError。
 */
export function selectEgressForRegister(input: EgressSelectorInput): EgressSelection {
  const { strict, relaxed } = buildEgressCandidates(input);
  const rand = input.rand ?? Math.random;
  const fromStrict = pickWeighted(strict, rand);
  if (fromStrict) {
    return { hash: fromStrict.hash, port: fromStrict.port, reason: "weighted_quality" };
  }
  const fromRelaxed = pickWeighted(relaxed, rand);
  if (fromRelaxed) {
    return { hash: fromRelaxed.hash, port: fromRelaxed.port, reason: "fallback_relaxed" };
  }
  throw new NoEgressAvailableError(
    "no eligible egress node: need schedulable + active + assigned port (preferably with passing openai test)"
  );
}

/**
 * 登录场景 —— 优先尝试 preferredHash 对应的节点（如果还满足质量门槛）；
 * 否则等同 selectEgressForRegister。
 */
export function selectEgressForLogin(
  input: EgressSelectorInput & { preferredHash: string | null }
): EgressSelection {
  const { strict, relaxed } = buildEgressCandidates(input);
  // 优先取 preferred —— 必须仍在严格池中（保证 openai 仍可达）
  if (input.preferredHash) {
    const sticky = strict.find((c) => c.hash === input.preferredHash);
    if (sticky) {
      return { hash: sticky.hash, port: sticky.port, reason: "preferred" };
    }
  }
  // fallback：跟注册一样
  return selectEgressForRegister({
    nodes: input.nodes,
    egressLoadByNodeHash: input.egressLoadByNodeHash,
    ...(input.rand ? { rand: input.rand } : {})
  });
}

/**
 * 加权随机：weight = max(1, qualityScore) / (load + 1)
 * 返回 undefined 当数组为空。
 */
function pickWeighted(candidates: EgressCandidate[], rand: () => number): EgressCandidate | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const weights = candidates.map((c) => Math.max(1, c.qualityScore) / (c.load + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return candidates[0];
  let r = rand() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/**
 * 从 accounts 列表反推出每个本地节点 hash 的当前出口负载（egress 计数）。
 * worker 在选 egress 前调一次，把结果传给 selectXxx。
 */
export function buildEgressLoadMap(
  accounts: Array<{ egressNodeHash: string | null }>
): Map<string, number> {
  const map = new Map<string, number>();
  for (const acc of accounts) {
    if (!acc.egressNodeHash) continue;
    map.set(acc.egressNodeHash, (map.get(acc.egressNodeHash) ?? 0) + 1);
  }
  return map;
}
