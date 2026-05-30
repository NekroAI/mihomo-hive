// Read-only observation of the login-scoring closed loop. NO secret columns.
// Run inside container: docker exec -i mihomo-hive node < observe-login.js
const D = require("/app/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3");
const db = new D("/data/state.db", { readonly: true });

const CUTOFF = process.env.CUTOFF || "2026-05-30T18:36:00Z"; // post-deploy

// 1) login jobs created after deploy — did the NEW picker start succeeding?
const post = db
  .prepare("SELECT status,count(*) c FROM account_jobs WHERE kind='codex_login' AND created_at > ? GROUP BY status")
  .all(CUTOFF);

// 2) running/most-recent login jobs (status + when)
const recent = db
  .prepare("SELECT status,created_at,updated_at FROM account_jobs WHERE kind='codex_login' ORDER BY updated_at DESC LIMIT 6")
  .all();

// 3) node login dispersion — how many distinct nodes have accumulated login attempts,
//    and the spread (anti-concentration check).
const nodeStats = db
  .prepare("SELECT count(*) tot,sum(codex_login_success) ls,sum(codex_login_failure) lf,sum(case when (codex_login_success+codex_login_failure)>0 then 1 else 0 end) touchedLogin,sum(case when codex_login_success>0 then 1 else 0 end) provenLogin FROM nodes")
  .get();

// 4) top nodes by login attempts (concentration view)
const topNodes = db
  .prepare("SELECT name,codex_login_success ls,codex_login_failure lf,codex_reserved res FROM nodes WHERE (codex_login_success+codex_login_failure)>0 ORDER BY (codex_login_success+codex_login_failure) DESC LIMIT 10")
  .all();

// 4b) most-recent failed login jobs — redacted log_tail/detail to diagnose failure mode
const jobCols = db.prepare("PRAGMA table_info(account_jobs)").all().map((c) => c.name);
const detailCol = jobCols.includes("log_tail") ? "log_tail" : jobCols.includes("detail") ? "detail" : null;
const failDetail = detailCol
  ? db
      .prepare(`SELECT updated_at, substr(${detailCol},-600) tail FROM account_jobs WHERE kind='codex_login' AND status='failed' ORDER BY updated_at DESC LIMIT 3`)
      .all()
  : [];

// 5) account intents (recovery progress) + relogin totals
const accCols = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
const reloginCol = accCols.includes("relogin_count") ? "relogin_count" : accCols.find((c) => c.includes("relogin"));
const intents = db.prepare("SELECT intent,count(*) c FROM accounts GROUP BY intent").all();
const reloginTotal = reloginCol ? db.prepare(`SELECT coalesce(sum(${reloginCol}),0) t FROM accounts`).get().t : null;

console.log(
  JSON.stringify(
    { cutoff: CUTOFF, postDeployLoginJobs: post, recentLoginJobs: recent, nodeStats, topNodes, failDetail, intents, reloginTotal },
    null,
    1
  )
);
