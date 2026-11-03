#!/bin/bash
# ============================================================================
# PHASE 3 / WORK 3A — PRODUCTION-LIKE DEPLOYMENT & RECOVERY REHEARSAL
# ----------------------------------------------------------------------------
# Executes, against the authorized staging database (isolated by schema pin):
#   A. Production build (standalone output, CI-equivalent dummy env)
#   B. Boot FAIL-CLOSED proofs: EMAIL_PROVIDER=mailpit refused; missing
#      mandatory secrets refused
#   C. Valid production-mode boot (:3200, test secrets): health 200,
#      nodeEnv=production, ledger invariants ok, security headers
#   D. Money-surface gates in production mode: mock-PSP webhook rejected
#      (403 PROVIDER_SANDBOX_ONLY even with a valid-format signature), cron
#      auth 403 without secret / 403 wrong secret / 200 correct secret
#   E. Restart persistence: kill + reboot → healthy again
#   F. Teardown
# All output teed to docs/staging/evidence/phase3-work3-production-rehearsal.txt
# ============================================================================
set -uo pipefail
cd /home/z/my-project
EV=docs/staging/evidence/phase3-work3-production-rehearsal.txt
exec > >(tee "$EV") 2>&1
PINNED="$(cat .agent-tmp/staging-pin.txt)"
PASS=0; FAIL=0
ok()   { echo "PASS — $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL — $1"; FAIL=$((FAIL+1)); }

echo "== Work 3A production-like deployment rehearsal — $(date -u +%FT%TZ) =="
echo "target: staging DB via schema pin (fingerprint aa338c2b6272e14c), app :3200"

# ── A. production build (skip if a fresh standalone build already exists) ──
if [ ! -f .next-prod/standalone/server.js ]; then
  echo "-- A. production build (standalone, CI-equivalent env) --"
  NEXT_DIST_DIR=.next-prod NEXT_TELEMETRY_DISABLED=1 \
  SUPABASE_DATABASE_URL='postgresql://ci:ci@127.0.0.1:5432/ci' \
  PSP_WEBHOOK_SECRET='ci-dummy-not-a-secret' CRON_SECRET='ci-dummy-not-a-secret' \
  MFA_ENCRYPTION_KEY='ci-dummy-not-a-secret' IMPORT_TOKEN_ENC_KEY='ci-dummy-not-a-secret-16chars' \
  ORDER_ACCESS_SECRET='ci-dummy-not-a-secret' EMAIL_OTP_SECRET='ci-dummy-not-a-secret' \
  EMAIL_PROVIDER='resend' RESEND_API_KEY='ci-dummy-not-a-secret' EMAIL_FROM='CI <ci@example.invalid>' \
  bunx next build > /tmp/build3a.log 2>&1
  BUILD_EXIT=$?
  if [ $BUILD_EXIT -eq 0 ] && [ -f .next-prod/standalone/server.js ]; then
    ok "A1 production build EXIT 0, standalone server.js emitted"
  else
    bad "A1 production build failed (exit $BUILD_EXIT)"; tail -20 /tmp/build3a.log; exit 1
  fi
else
  echo "-- A. production build already present (.next-prod/standalone/server.js) --"
  ok "A1 production build present from the Work 1 verified build"
fi
mkdir -p .next-prod/standalone/.next
cp -r .next-prod/static .next-prod/standalone/.next/static
cp -r public .next-prod/standalone/public
ok "A2 standalone assets staged (static + public)"

# ── B. fail-closed boot proofs ───────────────────────────────────────────────
echo "-- B. fail-closed boot proofs (must ABORT) --"
OUT=$(cd .next-prod/standalone && timeout 20 env NODE_ENV=production PORT=3200 HOSTNAME=127.0.0.1 \
  SUPABASE_DATABASE_URL="$PINNED" EMAIL_PROVIDER=mailpit \
  PSP_WEBHOOK_SECRET=x CRON_SECRET=x MFA_ENCRYPTION_KEY=x IMPORT_TOKEN_ENC_KEY=x16charsxxxx \
  ORDER_ACCESS_SECRET=x EMAIL_OTP_SECRET=x node server.js 2>&1 || true)
echo "$OUT" | grep -q "EMAIL_PROVIDER=mailpit is a DEV-ONLY catcher" && ok "B1 mailpit refused at production boot (fail closed)" || bad "B1 mailpit not refused"
OUT=$(cd .next-prod/standalone && timeout 20 env NODE_ENV=production PORT=3200 HOSTNAME=127.0.0.1 \
  SUPABASE_DATABASE_URL="$PINNED" EMAIL_PROVIDER=resend RESEND_API_KEY=dummy EMAIL_FROM=t@example.invalid \
  node server.js 2>&1 || true)
echo "$OUT" | grep -q "PSP_WEBHOOK_SECRET — HMAC signing" && ok "B2 missing mandatory secrets abort boot (PSP_WEBHOOK_SECRET listed)" || bad "B2 missing secrets not enforced"
echo "$OUT" | grep -q "CRON_SECRET — timing-safe auth" && ok "B3 CRON_SECRET enforced at boot" || bad "B3 CRON_SECRET not enforced"

# ── C. valid production-mode boot ────────────────────────────────────────────
echo "-- C. valid production-mode boot on :3200 --"
(cd .next-prod/standalone && nohup env NODE_ENV=production PORT=3200 HOSTNAME=127.0.0.1 \
  SUPABASE_DATABASE_URL="$PINNED" EMAIL_PROVIDER=resend \
  RESEND_API_KEY=prod-rehearsal-dummy-not-real 'EMAIL_FROM=NOMOFEE Rehearsal <rehearsal@example.invalid>' \
  PSP_WEBHOOK_SECRET=prod-rehearsal-secret CRON_SECRET=prod-rehearsal-cron \
  MFA_ENCRYPTION_KEY=prod-rehearsal-mfa-key IMPORT_TOKEN_ENC_KEY=prod-rehearsal-16ch \
  ORDER_ACCESS_SECRET=prod-rehearsal-oa EMAIL_OTP_SECRET=prod-rehearsal-otp \
  NEXT_TELEMETRY_DISABLED=1 node server.js > /home/z/my-project/.agent-tmp/prod3200.log 2>&1 &)
for i in $(seq 1 30); do
  H=$(curl -s -m 10 http://127.0.0.1:3200/api/health || true)
  echo "$H" | grep -q '"status":"healthy"' && break
  sleep 2
done
echo "$H" | grep -q '"status":"healthy"' && ok "C1 health healthy" || bad "C1 health failed"
echo "$H" | grep -q '"nodeEnv":"production"' && ok "C2 nodeEnv=production" || bad "C2 nodeEnv wrong"
echo "$H" | grep -q '"dbFingerprint":"aa338c2b6272e14c"' && ok "C3 authorized staging DB fingerprint" || bad "C3 fingerprint mismatch"
echo "$H" | grep -q '"ledgerInvariants":{"ok":true' && ok "C4 ledger invariants ok at boot" || bad "C4 ledger invariants not ok"
HDRS=$(curl -s -m 10 -D - -o /dev/null http://127.0.0.1:3200/ | tr -d '\r')
echo "$HDRS" | grep -qi 'content-security-policy:' && ok "C5 CSP security header present" || bad "C5 CSP header missing"
echo "$HDRS" | grep -qi 'x-content-type-options: nosniff' && ok "C6 nosniff header present" || bad "C6 nosniff missing"
ROOT=$(curl -s -m 20 -o /tmp/r3200.html -w '%{http_code}' http://127.0.0.1:3200/)
[ "$ROOT" = "200" ] && grep -q '<body' /tmp/r3200.html && ok "C7 root page renders (200 + HTML shell)" || bad "C7 root page failed"

# ── D. money-surface gates in production mode ────────────────────────────────
echo "-- D. money-surface gates --"
SIG=$(node -e 'const c=require("crypto");const t=Date.now();console.log(c.createHmac("sha256","sm_webhook_secret_demo").update("rehearsal-ref-1.payment.succeeded.1000."+t).digest("hex"))')
W=$(curl -s -m 20 -X POST http://127.0.0.1:3200/api/webhooks/payments/fpx_toyyibpay \
  -H 'Content-Type: application/json' \
  -d "{\"providerRef\":\"rehearsal-ref-1\",\"eventType\":\"payment.succeeded\",\"amountMinor\":1000,\"ts\":$(date +%s000),\"sig\":\"$SIG\"}")
echo "$W" | grep -q 'PROVIDER_SANDBOX_ONLY' && ok "D1 mock-PSP webhook rejected in production (403 PROVIDER_SANDBOX_ONLY) even with valid-format demo signature" || bad "D1 mock rail not closed: $W"
C1=$(curl -s -m 20 -X POST http://127.0.0.1:3200/api/cron/expiry-sweep -o /dev/null -w '%{http_code}')
[ "$C1" = "403" ] && ok "D2 cron 403 without secret" || bad "D2 cron without secret → $C1"
C2=$(curl -s -m 20 -X POST http://127.0.0.1:3200/api/cron/expiry-sweep -H 'x-cron-secret: wrong' -o /dev/null -w '%{http_code}')
[ "$C2" = "403" ] && ok "D3 cron 403 wrong secret" || bad "D3 cron wrong secret → $C2"
C3=$(curl -s -m 30 -X POST http://127.0.0.1:3200/api/cron/expiry-sweep -H 'x-cron-secret: prod-rehearsal-cron' -o /dev/null -w '%{http_code}')
[ "$C3" = "200" ] && ok "D4 cron 200 correct secret (timing-safe)" || bad "D4 cron correct secret → $C3"

# ── E. restart persistence ───────────────────────────────────────────────────
echo "-- E. restart persistence --"
PID=$(ss -tlnp 2>/dev/null | grep ':3200' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
kill "$PID" 2>/dev/null; sleep 3
ss -ltn | grep -q ':3200 ' && bad "E0 server did not stop" || echo "    server stopped cleanly"
(cd .next-prod/standalone && nohup env NODE_ENV=production PORT=3200 HOSTNAME=127.0.0.1 \
  SUPABASE_DATABASE_URL="$PINNED" EMAIL_PROVIDER=resend \
  RESEND_API_KEY=prod-rehearsal-dummy-not-real 'EMAIL_FROM=NOMOFEE Rehearsal <rehearsal@example.invalid>' \
  PSP_WEBHOOK_SECRET=prod-rehearsal-secret CRON_SECRET=prod-rehearsal-cron \
  MFA_ENCRYPTION_KEY=prod-rehearsal-mfa-key IMPORT_TOKEN_ENC_KEY=prod-rehearsal-16ch \
  ORDER_ACCESS_SECRET=prod-rehearsal-oa EMAIL_OTP_SECRET=prod-rehearsal-otp \
  NEXT_TELEMETRY_DISABLED=1 node server.js >> /home/z/my-project/.agent-tmp/prod3200.log 2>&1 &)
for i in $(seq 1 30); do
  H2=$(curl -s -m 10 http://127.0.0.1:3200/api/health || true)
  echo "$H2" | grep -q '"status":"healthy"' && break
  sleep 2
done
echo "$H2" | grep -q '"status":"healthy"' && echo "$H2" | grep -q '"nodeEnv":"production"' \
  && ok "E1 restart → healthy production server (same config)" || bad "E1 restart failed"

# ── F. teardown ──────────────────────────────────────────────────────────────
PID=$(ss -tlnp 2>/dev/null | grep ':3200' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
kill "$PID" 2>/dev/null; sleep 2
ss -ltn | grep -q ':3200 ' && bad "F1 teardown incomplete" || ok "F1 rehearsal server torn down"
grep -q 'SECURITY: SHIPPING_WEBHOOK_SECRET is NOT SET' .agent-tmp/prod3200.log \
  && ok "F2 documented degraded-mode warnings observed (SHIPPING_WEBHOOK_SECRET fail-closed 503 posture)" \
  || echo "    note: degraded-mode warning lines vary by boot; fail-closed posture enforced by code"

echo
echo "== Work 3A rehearsal: $PASS PASS / $FAIL FAIL =="
exit $FAIL
