// Per-window login failure-mode breakdown + intents. Read-only, no secret columns.
// 区分"账号已停用(OpenAI 403 deactivated=死)" vs "活账号但 consent/Sentinel 失败"。
const D = require("/app/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3");
const db = new D("/data/state.db", { readonly: true });

function classify(t) {
  if (/deactivated|deleted or deactivated|do not have an account/i.test(t)) return "dead(已停用)";
  if (/Too many tries|稍后再试/i.test(t)) return "ratelimit(限流)";
  if (/Sentinel 提取失败|环境校验失败/.test(t)) return "sentinel(浏览器)";
  if (/缺少目标 URL/.test(t)) return "consent(活账号)";
  if (/邮箱验证码校验失败/.test(t)) return "otp-fail";
  if (/等待邮箱验证码超时/.test(t)) return "otp-timeout";
  return "other";
}

const intents = {};
for (const r of db.prepare("SELECT intent,count(*) c FROM accounts GROUP BY intent").all()) intents[r.intent] = r.c;

// rolling window: login jobs updated in the last 20 min
const rows = db
  .prepare("SELECT status,log_tail,updated_at FROM account_jobs WHERE kind='codex_login' ORDER BY updated_at DESC LIMIT 60")
  .all();
const modes = {};
let ok = 0;
for (const r of rows) {
  if (r.status === "succeeded") { ok++; continue; }
  if (r.status !== "failed") continue;
  const m = classify(r.log_tail || "");
  modes[m] = (modes[m] || 0) + 1;
}
const t = new Date().toISOString().slice(11, 19);
const deadShare = (() => {
  const fails = Object.entries(modes).filter(([k]) => k !== undefined).reduce((a, [, v]) => a + v, 0);
  return fails ? Math.round(((modes["dead(已停用)"] || 0) / fails) * 100) : 0;
})();
console.log(
  `${t} intents{active=${intents.active || 0} recovering=${intents.recovering || 0} retired=${intents.retired || 0}} ok=${ok} dead%=${deadShare} modes=${JSON.stringify(modes)}`
);
