// TEMP: verify .env Supabase credentials are char-exact vs the user-provided values,
// and functionally validate anon + service keys against Supabase PostgREST.
import { readFileSync } from "fs";

const expected = {
  SUPABASE_URL: "https://tujvscnonmupldrqkqen.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1anZzY25vbm11cGxkcnFrcWVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNzQzMjUsImV4cCI6MjEwNzk1MDMyNX0.2yGmvMVS9N3QQY-HuJwUeGy5hMmYoGJA2WABciKEd5A",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1anZzY25vbm11cGxkcnFrcWVuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjM3NDMyNSwiZXhwIjoyMTA3OTUwMzI1fQ.T_TY4ox_ffOCYvyWgPKEFJ3pX-WxoPyp_CUO0mMsoOU",
};

const env = Object.fromEntries(
  readFileSync("/home/z/my-project/.env", "utf8")
    .split("\n")
    .filter((l) => l && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    })
);

for (const [k, want] of Object.entries(expected)) {
  const got = env[k] ?? "";
  if (got === want) console.log(`EXACT  ${k}`);
  else {
    let i = 0;
    while (i < Math.min(got.length, want.length) && got[i] === want[i]) i++;
    console.log(`DIFF   ${k} at char ${i}: got ${JSON.stringify(got.slice(i, i + 6))} want ${JSON.stringify(want.slice(i, i + 6))}`);
  }
}

const rest = `${expected.SUPABASE_URL}/rest/v1/`;
for (const k of ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const) {
  const r = await fetch(rest, { headers: { apikey: env[k], Authorization: `Bearer ${env[k]}` } });
  console.log(`REST   ${k} -> HTTP ${r.status} ${r.ok ? "(valid)" : "(check key)"}`);
}
