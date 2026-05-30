// Compact one-line sampler for the login loop. Read-only, no secret columns.
const D = require("/app/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3");
const db = new D("/data/state.db", { readonly: true });
const CUT = "2026-05-30T18:36:00Z";
const j = db.prepare("SELECT status,count(*) c FROM account_jobs WHERE kind='codex_login' AND created_at > ? GROUP BY status").all(CUT);
const m = {}; for (const r of j) m[r.status] = r.c;
const n = db.prepare("SELECT sum(codex_login_success) ls,sum(codex_login_failure) lf,sum(case when (codex_login_success+codex_login_failure)>0 then 1 else 0 end) touched,sum(case when codex_login_success>0 then 1 else 0 end) proven FROM nodes").get();
const rel = db.prepare("SELECT coalesce(sum(relogin_count),0) t FROM accounts").get().t;
const act = db.prepare("SELECT count(*) c FROM accounts WHERE intent='active'").get().c;
const rec = db.prepare("SELECT count(*) c FROM accounts WHERE intent='recovering'").get().c;
const t = new Date().toISOString().slice(11, 19);
console.log(`${t} postLogin{ok=${m.succeeded||0} fail=${m.failed||0} run=${m.running||0} q=${m.queued||0}} nodes{✓sum=${n.ls} ✗sum=${n.lf} touched=${n.touched}/65 proven=${n.proven}} relogin=${rel} active=${act} recovering=${rec}`);
