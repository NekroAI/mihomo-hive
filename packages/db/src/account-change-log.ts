/**
 * 账号变更历史的纯函数 diff —— 持久化层在每次写入账号时调用，比较旧值/新值，
 * 把真实的 health / intent / 额度变动追加进环形缓冲（最近 N 条，head 最新）。
 *
 * 放在 db 层是刻意的：health/intent/quota 的所有写入都经过 repository
 * （upsertAccount / patchAccount），这是唯一能拿到"旧值 vs 新值"的咽喉点。
 * 本函数无任何 IO，可单测。
 */
import type { AccountChangeEntry, AccountHealth, AccountIntent } from "@mihomo-hive/schemas";

/** 参与 diff 的账号字段快照（旧值与新值各一份）。 */
export interface AccountChangeSnapshot {
  health: AccountHealth;
  intent: AccountIntent;
  quota5hPercent: number | null;
  quota7dPercent: number | null;
}

/**
 * 计算写入后的变更历史。
 *   - health 变了 → 追加一条 health（from/to）
 *   - intent 变了 → 追加一条 intent（from/to）
 *   - 额度变了 → 若 head 已经是 quota 则"合并"（保留 from、更新 to 与 at），否则新增一条
 * 三类同一次写入都触发时，按 health → intent → quota 顺序追加（同 at，先后只影响展示次序）。
 * 最终裁剪到 limit 条。prev 为 null（新建账号）时不产生任何变更条目。
 *
 * @returns 新的历史数组（head 最新）。注意：返回新数组，不修改入参。
 */
export function appendAccountChanges(
  prevHistory: AccountChangeEntry[],
  prev: AccountChangeSnapshot | null,
  next: AccountChangeSnapshot,
  at: string,
  limit: number
): AccountChangeEntry[] {
  const history = [...prevHistory];
  if (!prev) return capHistory(history, limit);

  if (prev.health !== next.health) {
    history.unshift({ kind: "health", at, from: prev.health, to: next.health });
  }
  if (prev.intent !== next.intent) {
    history.unshift({ kind: "intent", at, from: prev.intent, to: next.intent });
  }
  if (prev.quota5hPercent !== next.quota5hPercent || prev.quota7dPercent !== next.quota7dPercent) {
    const head = history[0];
    if (head && head.kind === "quota") {
      // 合并进当前这一段额度变动：保留段首 from，把 to 推进到最新
      history[0] = {
        kind: "quota",
        at,
        q5From: head.q5From,
        q5To: next.quota5hPercent,
        q7From: head.q7From,
        q7To: next.quota7dPercent
      };
    } else {
      history.unshift({
        kind: "quota",
        at,
        q5From: prev.quota5hPercent,
        q5To: next.quota5hPercent,
        q7From: prev.quota7dPercent,
        q7To: next.quota7dPercent
      });
    }
  }
  return capHistory(history, limit);
}

function capHistory(history: AccountChangeEntry[], limit: number): AccountChangeEntry[] {
  const cap = Math.max(1, Math.floor(limit));
  return history.length > cap ? history.slice(0, cap) : history;
}
