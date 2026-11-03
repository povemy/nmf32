// Public-leak scan for the Work 2 staging run (read-only, exit non-zero on leak).
import { Client } from "pg";
import { readFileSync } from "node:fs";
const devUrl = readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim() ?? "";
const u = new URL(devUrl);
u.searchParams.delete("sslmode"); // pooler chain is self-signed from this box; explicit opt-out like lib.ts pgClient
const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();
const scans: [string, string][] = [
  ["ShopperUser lt-w2", `SELECT count(*)::int AS n FROM public."ShopperUser" WHERE email LIKE '%lt-w2-%'`],
  ["AdminUser lt-w2", `SELECT count(*)::int AS n FROM public."AdminUser" WHERE email LIKE '%lt-w2-%'`],
  ["Product [LT]", `SELECT count(*)::int AS n FROM public."Product" WHERE title LIKE '%[LT]%'`],
  ["AffiliateProfile W2", `SELECT count(*)::int AS n FROM public."AffiliateProfile" WHERE "displayName" LIKE '%LT W2%'`],
  ["AffiliatePayout last 3h", `SELECT count(*)::int AS n FROM public."AffiliatePayout" WHERE "requestedAt" > now() - interval '3 hours'`],
  ["Affiliate txns last 3h", `SELECT count(*)::int AS n FROM public."LedgerTransaction" WHERE "occurredAt" > now() - interval '3 hours' AND "txnType" LIKE 'affiliate%'`],
  ["Refund [LT]W2", `SELECT count(*)::int AS n FROM public."Refund" WHERE reason LIKE '%[LT]W2%'`],
  ["Orders last 3h", `SELECT count(*)::int AS n FROM public."Order" WHERE "createdAt" > now() - interval '3 hours'`],
];
let bad = 0;
for (const [name, q] of scans) {
  const n = (await c.query(q)).rows[0].n;
  if (n > 0) { bad++; console.log(`LEAK  ${name}: ${n}`); } else console.log(`clean ${name}`);
}
const sess = (await c.query(`SELECT count(*)::int AS n FROM public."Session" WHERE "expiresAt" < now()`)).rows[0].n;
console.log(`public.Session expired rows still present: ${sess}`);
const wda = (await c.query(`SELECT "createdAt" FROM public."WebhookDeliveryAttempt" ORDER BY "createdAt" DESC LIMIT 1`)).rows[0]?.createdAt ?? "none";
console.log(`latest public.WebhookDeliveryAttempt createdAt: ${wda}`);
console.log(bad === 0 ? "NO STAGING-TEST ARTIFACTS IN PUBLIC" : `${bad} LEAK CLASSES FOUND`);
await c.end();
process.exit(bad === 0 ? 0 : 1);
