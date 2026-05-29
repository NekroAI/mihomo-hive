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
  /** P5-AS: 经此节点 codex_login 真实成功次数（能过 Sentinel 的证据） */
  codexSuccess: number;
  /** P5-AS: 经此节点 network_or_proxy/sentinel 类失败次数 */
  codexFailure: number;
  /** P5-AS: 最近一次 codex_login 结果（用于"刚失败的 sticky 节点不再优先复用"） */
  codexLastOutcome: "success" | "failure" | null;
  /** P5-AS: 是否为保留节点（专用于注册/登录的高质量备用出口） */
  reserved: boolean;
}

export interface EgressSelection {
  hash: string;
  port: number;
  reason:
    | "preferred"
    | "weighted_quality"
    | "fallback_relaxed"
    // P5-AS codex 实战反馈分层
    | "codex_proven" // 证明能过 Sentinel 的节点（成功>0）
    | "codex_least_bad" // 全都失败过，挑失败最少的再给一次机会
    | "codex_reserved"; // 命中保留节点池
  /** 是否来自保留节点（便于 worker 日志/UI 区分）。 */
  reserved?: boolean;
}

/** codex 净胜场（成功-失败），用于 proven 节点排序。 */
function codexNet(c: EgressCandidate): number {
  return c.codexSuccess - c.codexFailure;
}

/** proven 排序：净胜场↓ → 成功数↓ → 负载↑ → 质量↓ → hash 稳定。确定性。 */
function compareProven(a: EgressCandidate, b: EgressCandidate): number {
  return (
    codexNet(b) - codexNet(a) ||
    b.codexSuccess - a.codexSuccess ||
    a.load - b.load ||
    b.qualityScore - a.qualityScore ||
    (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  );
}

/** failing 池里挑失败最少的（确定性兜底，避免节点池被打成"全失败就抛错"）。 */
function leastBad(pool: EgressCandidate[]): EgressCandidate | undefined {
  const failing = pool.filter((c) => c.codexSuccess === 0 && c.codexFailure > 0);
  if (failing.length === 0) return undefined;
  return [...failing].sort(
    (a, b) =>
      a.codexFailure - b.codexFailure ||
      b.qualityScore - a.qualityScore ||
      (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  )[0];
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
      tested,
      codexSuccess: node.codexLoginSuccess ?? 0,
      codexFailure: node.codexLoginFailure ?? 0,
      codexLastOutcome: node.codexLastOutcome ?? null,
      reserved: node.codexReserved ?? false
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
 * P5-AS 分层选择 —— codex 实战反馈优先于盲目随机：
 *   1. proven（成功>0）：证明能过 Sentinel。注册偏向分散（加权），登录确定性选最佳。
 *   2. untried（成功=0 且 失败=0）：没跑过 → 加权随机探索（发现哪些节点能过）。
 *   3. failing（成功=0 且 失败>0）：都失败过 → 挑失败最少的再给一次机会（不直接放弃）。
 * relaxedPool 决定 untried 路径的 reason 标签（weighted_quality / fallback_relaxed），
 * 以保持与历史语义一致。
 */
function pickFromPool(
  pool: EgressCandidate[],
  rand: () => number,
  mode: "login" | "register",
  isRelaxed: boolean
): EgressSelection | undefined {
  if (pool.length === 0) return undefined;
  const proven = pool.filter((c) => c.codexSuccess > 0);
  if (proven.length > 0) {
    if (mode === "login") {
      // 登录：确定性选最佳 proven —— 恢复要的是"最可能成功"，不是分散
      const best = [...proven].sort(compareProven)[0];
      if (best) return { hash: best.hash, port: best.port, reason: "codex_proven" };
    }
    // 注册：在 proven 里按 (净胜场+1)/(load+1) 加权，兼顾"能过"与 IP 分散
    const picked = pickWeightedBy(proven, (c) => (Math.max(0, codexNet(c)) + 1) / (c.load + 1), rand);
    if (picked) return { hash: picked.hash, port: picked.port, reason: "codex_proven" };
  }
  const untried = pool.filter((c) => c.codexSuccess === 0 && c.codexFailure === 0);
  const pickedUntried = pickWeighted(untried, rand);
  if (pickedUntried) {
    return {
      hash: pickedUntried.hash,
      port: pickedUntried.port,
      reason: isRelaxed ? "fallback_relaxed" : "weighted_quality"
    };
  }
  const least = leastBad(pool);
  if (least) return { hash: least.hash, port: least.port, reason: "codex_least_bad" };
  return undefined;
}

/**
 * 保留节点优先的池遍历（P5-AS）。顺序：
 *   保留-strict → 保留-relaxed → 普通-strict → 普通-relaxed
 * 保留节点是用户手动标记的高质量备用出口，注册/登录都优先走它们；命中保留池时
 * reason 统一标 codex_reserved + reserved=true，便于日志/UI 区分。普通池保持原
 * 分层 reason（codex_proven / weighted_quality / fallback_relaxed / codex_least_bad）。
 */
function selectFromPools(
  strict: EgressCandidate[],
  relaxed: EgressCandidate[],
  rand: () => number,
  mode: "login" | "register"
): EgressSelection | undefined {
  const tiers: Array<{ pool: EgressCandidate[]; isRelaxed: boolean; reserved: boolean }> = [
    { pool: strict.filter((c) => c.reserved), isRelaxed: false, reserved: true },
    { pool: relaxed.filter((c) => c.reserved), isRelaxed: true, reserved: true },
    { pool: strict.filter((c) => !c.reserved), isRelaxed: false, reserved: false },
    { pool: relaxed.filter((c) => !c.reserved), isRelaxed: true, reserved: false }
  ];
  for (const tier of tiers) {
    const pick = pickFromPool(tier.pool, rand, mode, tier.isRelaxed);
    if (pick) {
      return tier.reserved
        ? { hash: pick.hash, port: pick.port, reason: "codex_reserved", reserved: true }
        : { ...pick, reserved: false };
    }
  }
  return undefined;
}

/**
 * 注册场景 —— 统一优先走保留节点（出生 IP 干净）；无保留节点才回退普通节点，
 * 普通池内按 codex 分层（proven 优先）。都空 → 抛 NoEgressAvailableError。
 */
export function selectEgressForRegister(input: EgressSelectorInput): EgressSelection {
  const { strict, relaxed } = buildEgressCandidates(input);
  const rand = input.rand ?? Math.random;
  const pick = selectFromPools(strict, relaxed, rand, "register");
  if (pick) return pick;
  throw new NoEgressAvailableError(
    "no eligible egress node: need schedulable + active + assigned port (preferably with passing openai test)"
  );
}

/**
 * 登录场景（恢复）—— 顺序严格对应用户要求：
 *   1. 账号"上次成功的节点"（preferredHash 软粘性），仍 strict 且最近非失败 → 直接复用；
 *   2. 否则启用保留节点池（备用出口），避免在普通节点里瞎轮换触发账号风控；
 *   3. 无保留节点才回退普通节点（proven 优先 > 探索 > 失败最少）。
 */
export function selectEgressForLogin(
  input: EgressSelectorInput & { preferredHash: string | null }
): EgressSelection {
  const { strict, relaxed } = buildEgressCandidates(input);
  const rand = input.rand ?? Math.random;
  if (input.preferredHash) {
    const sticky = strict.find((c) => c.hash === input.preferredHash);
    if (sticky && sticky.codexLastOutcome !== "failure") {
      return { hash: sticky.hash, port: sticky.port, reason: "preferred", reserved: sticky.reserved };
    }
  }
  const pick = selectFromPools(strict, relaxed, rand, "login");
  if (pick) return pick;
  throw new NoEgressAvailableError(
    "no eligible egress node for login: need schedulable + active + assigned port"
  );
}

/**
 * 加权随机：weight = max(1, qualityScore) / (load + 1)
 * 返回 undefined 当数组为空。
 */
function pickWeighted(candidates: EgressCandidate[], rand: () => number): EgressCandidate | undefined {
  return pickWeightedBy(candidates, (c) => Math.max(1, c.qualityScore) / (c.load + 1), rand);
}

/** 通用加权随机：权重函数自定义。返回 undefined 当数组为空。 */
function pickWeightedBy(
  candidates: EgressCandidate[],
  weightOf: (c: EgressCandidate) => number,
  rand: () => number
): EgressCandidate | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const weights = candidates.map((c) => Math.max(0, weightOf(c)));
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
