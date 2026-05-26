import type { FilterProfile, FilterRule, ProxyNode } from "@mihomo-hive/schemas";

export function filterNodes(nodes: ProxyNode[], profile: FilterProfile): ProxyNode[] {
  if (profile.rules.length === 0) {
    return profile.invert ? [] : nodes;
  }
  return nodes.filter((node) => {
    const results = profile.rules.map((rule) => matchesRule(node, rule));
    const matched = profile.mode === "any" ? results.some(Boolean) : results.every(Boolean);
    return profile.invert ? !matched : matched;
  });
}

function matchesRule(node: ProxyNode, rule: FilterRule): boolean {
  const rawValue = String(node[rule.field] ?? "");
  const candidate = rule.caseSensitive ? rawValue : rawValue.toLowerCase();
  const expected = rule.caseSensitive ? rule.value : rule.value.toLowerCase();

  switch (rule.op) {
    case "contains":
      return candidate.includes(expected);
    case "not_contains":
      return !candidate.includes(expected);
    case "equals":
      return candidate === expected;
    case "not_equals":
      return candidate !== expected;
    case "regex":
      return new RegExp(rule.value, rule.caseSensitive ? "" : "i").test(rawValue);
  }
}
