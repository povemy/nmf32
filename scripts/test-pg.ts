// TEMP: Supabase Supavisor session-pooler auth smoke test (IPv4).
// Tries latest password first, then the earlier one; reports which region authenticates.
import { Client } from "pg";

const REF = "tujvscnonmupldrqkqen";
const PWDS = ["Aiman0122769500!"]; // latest user-provided password only
const REGIONS = ["ap-southeast-1", "ap-southeast-2", "us-east-1", "eu-central-1"];

async function tryConn(region: string, pwd: string): Promise<string | null> {
  const c = new Client({
    host: `aws-0-${region}.pooler.supabase.com`,
    port: 5432,
    user: `postgres.${REF}`,
    password: pwd,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  try {
    await c.connect();
    const r = await c.query("select version(), current_database(), current_user");
    await c.end();
    return r.rows[0].version.split(" ").slice(0, 2).join(" ");
  } catch (e) {
    try { await c.end(); } catch {}
    return null;
  }
}

let found = false;
for (const region of REGIONS) {
  for (const pwd of PWDS) {
    const v = await tryConn(region, pwd);
    if (v) {
      console.log(`AUTH-OK region=${region} pwd=${pwd.slice(0, 5)}… pg=${v}`);
      found = true;
      process.exit(0);
    }
  }
}
if (!found) { console.log("AUTH-FAILED all combos"); process.exit(1); }
