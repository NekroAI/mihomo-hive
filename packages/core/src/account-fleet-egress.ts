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
  /** 经此节点 codex_login 成功/失败累计（**登录专属**，驱动登录选节点）。 */
  loginSuccess: number;
  loginFailure: number;
  /** 经此节点 codex_register 成功/失败累计（**注册专属**，驱动注册选节点）。 */
  registerSuccess: number;
  registerFailure: number;
  /** P5-AS: 最近一次 codex 结果（用于"刚失败的 sticky 节点不再优先复用"） */
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
    | "codex_least_bad"; // 全都失败过，挑失败最少的再给一次机会
  /** 是否来自保留节点（便于 worker 日志/UI 区分）。 */
  reserved?: boolean;
}

/** failing 池里挑失败最少的（确定性兜底，避免节点池被打成"全失败就抛错"）。按给定的成败口径。 */
function leastBad(
  pool: EgressCandidate[],
  successOf: (c: EgressCandidate) => number,
  failureOf: (c: EgressCandidate) => number
): EgressCandidate | undefined {
  const failing = pool.filter((c) => successOf(c) === 0 && failureOf(c) > 0);
  if (failing.length === 0) return undefined;
  return [...failing].sort(
    (a, b) =>
      failureOf(a) - failureOf(b) ||
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
      loginSuccess: node.codexLoginSuccess ?? 0,
      loginFailure: node.codexLoginFailure ?? 0,
      registerSuccess: node.codexRegisterSuccess ?? 0,
      registerFailure: node.codexRegisterFailure ?? 0,
      codexLastOutcome: node.codexLastOutcome ?? null,
      reserved: node.codexReserved ?? false
    };
    // 严格池：必须 openai 测过且通过
    if (openaiOk) strict.push(candidate);
    // 宽松池：openai 通过 ∪ 未测过；排除"测过且失败"。
    // 保留节点例外：作为"确保永远有节点可注册/登录"的兜底，即使 openai 测过失败也保留在池内。
    if (openaiOk || !tested || candidate.reserved) relaxed.push(candidate);
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
 * 注册探索率 —— 当已有 proven（证明能注册）节点时，仍有这个比例的注册去试
 * "还没证明能注册"的节点，用于持续发现更多可注册节点。没有 proven 时则 100% 探索。
 * 探索失败通常在节点连通阶段就 fail-fast（开销低、不耗短信费），故可放心探索。
 */
const REGISTER_EXPLORE_RATE = 0.25;

/** 按 1/(load+1) 加权随机 —— 账号越少的节点越优先，实现新账号出生 IP 分散。 */
function pickDispersed(pool: EgressCandidate[], rand: () => number): EgressCandidate | undefined {
  return pickWeightedBy(pool, (c) => 1 / (c.load + 1), rand);
}

/**
 * 注册选节点（发现机制 + 分散，取代旧的"保留池优先、命中即返回"）。
 *
 * 关键改动：保留 / 非保留节点一视同仁，全部合格候选（relaxed = openai 通过 ∪ 未测，
 * 外加保留节点兜底）进入同一个池。保留节点不再独占注册名额，只作为"池子永不为空"
 * 的可用性保证。注册用 ε-greedy：
 *   - exploit（多数）：在 proven（codexSuccess>0）里按 1/(load+1) 分散 —— 新账号出生
 *     IP 均匀铺到所有"已证明能注册"的节点，不再全挤一个赢家。
 *   - explore（REGISTER_EXPLORE_RATE 比例 / 没有 proven 时全部）：试"还没证明能注册"
 *     的节点，先已验证连通(openaiOk)、再完全没验证(untested)，持续发现更多可注册节点。
 *   - 都没有可试 → leastBad 挑失败最少的再给一次机会。
 */
function pickForRegister(relaxed: EgressCandidate[], rand: () => number): EgressSelection | undefined {
  if (relaxed.length === 0) return undefined;
  // 注册看"注册专属"战绩(与登录分开)。
  const proven = relaxed.filter((c) => c.registerSuccess > 0);
  const untriedOk = relaxed.filter((c) => c.registerSuccess === 0 && c.registerFailure === 0 && c.openaiOk);
  const untriedRaw = relaxed.filter((c) => c.registerSuccess === 0 && c.registerFailure === 0 && !c.openaiOk);
  const hasUntried = untriedOk.length + untriedRaw.length > 0;

  const exploit = (): EgressSelection | undefined => {
    const p = pickDispersed(proven, rand);
    return p ? { hash: p.hash, port: p.port, reason: "codex_proven", reserved: p.reserved } : undefined;
  };
  const explore = (): EgressSelection | undefined => {
    const p = pickWeighted(untriedOk, rand);
    if (p) return { hash: p.hash, port: p.port, reason: "weighted_quality", reserved: p.reserved };
    const q = pickWeighted(untriedRaw, rand);
    if (q) return { hash: q.hash, port: q.port, reason: "fallback_relaxed", reserved: q.reserved };
    return undefined;
  };

  // 有 proven 且（没东西可探索 或 这次没抽中探索）→ exploit；否则 explore。
  if (proven.length > 0 && (!hasUntried || rand() >= REGISTER_EXPLORE_RATE)) {
    const hit = exploit();
    if (hit) return hit;
  }
  return (
    explore() ??
    exploit() ?? // 兜底：上面没走 exploit 分支但 explore 落空时，仍用 proven
    (() => {
      const least = leastBad(relaxed, (c) => c.registerSuccess, (c) => c.registerFailure);
      return least
        ? ({ hash: least.hash, port: least.port, reason: "codex_least_bad", reserved: least.reserved } as const)
        : undefined;
    })()
  );
}

/**
 * 登录选节点 —— 探索-利用加权策略（基于"登录"专属战绩）。深思后的目标：尽量探测节点、
 * 不只用验证过的、避免登录过于集中,同时仍要尽快成功。
 *
 * 每个候选权重 = 平滑登录成功率 × 探索/反集中因子,加权随机抽(非取最优):
 *   - rate = (loginSuccess+1)/(loginSuccess+loginFailure+2)  拉普拉斯平滑:
 *       没试过=0.5(可被探索);登录老失败→趋 0(淘汰登录不行的);能过→其真实率。
 *   - explore = 1/sqrt(loginSuccess+loginFailure+1)  尝试越多权重越低:
 *       给没试过的节点机会(探索),且强制把登录摊开、不集中在单个节点(反风控/反集中);
 *       某节点被风控后成功率掉 → 权重也掉,自纠正。
 * 加权随机 → 概率性铺开。候选取 relaxed(openai 通过 ∪ 未测 ∪ 保留),不预先排除,
 * 让权重自然淘汰登录不行的、保留对未知节点的探测。
 */
const LOGIN_RESERVED_BONUS = 1.5; // 保留节点(用户精选)登录时略加权,但不独占

function loginScore(c: EgressCandidate): number {
  const attempts = c.loginSuccess + c.loginFailure;
  const rate = (c.loginSuccess + 1) / (attempts + 2);
  const explore = 1 / Math.sqrt(attempts + 1);
  return rate * explore * (c.reserved ? LOGIN_RESERVED_BONUS : 1);
}

function pickForLogin(relaxed: EgressCandidate[], rand: () => number): EgressSelection | undefined {
  if (relaxed.length === 0) return undefined;
  const picked = pickWeightedBy(relaxed, loginScore, rand);
  if (!picked) return undefined;
  const reason: EgressSelection["reason"] =
    picked.loginSuccess > 0 ? "codex_proven" : picked.openaiOk ? "weighted_quality" : "fallback_relaxed";
  return { hash: picked.hash, port: picked.port, reason, reserved: picked.reserved };
}

/**
 * 注册场景 —— 在全体合格节点（保留 + 非保留一视同仁）里 exploit 分散 + explore 发现。
 * 都空 → 抛 NoEgressAvailableError。
 */
export function selectEgressForRegister(input: EgressSelectorInput): EgressSelection {
  const { relaxed } = buildEgressCandidates(input);
  const rand = input.rand ?? Math.random;
  const pick = pickForRegister(relaxed, rand);
  if (pick) return pick;
  throw new NoEgressAvailableError(
    "no eligible egress node: need schedulable + active + assigned port (preferably with passing openai test)"
  );
}

/**
 * 登录场景（恢复）—— 顺序：
 *   1. 账号"上次成功的节点"（preferredHash 软粘性），仍 strict 且最近非失败 → 直接复用；
 *   2. 否则在全体合格节点里确定性选最佳 proven（保留节点不独占，只兜底）。
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
  const pick = pickForLogin(relaxed, rand);
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
