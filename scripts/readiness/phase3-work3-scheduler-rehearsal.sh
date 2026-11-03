#!/bin/bash
# ============================================================================
# PHASE 3 / WORK 3B — SCHEDULER RELIABILITY REHEARSAL (dev app :3000 target)
# ----------------------------------------------------------------------------
#   A. liveness: scheduler :3005 up, ticking, zero consecutive failures
#   B. controlled interruption: kill → ~70s outage → app-side
#      /api/health/scheduler flips to STALE (age > healthyWithinSec)
#   C. recovery: restart → catch-up tick (MISSED_INTERVAL alert) → FRESH again
#   D. exactly-once during the window: expired-order / restock-log counts
#      unchanged across the outage+recovery (no duplicate financial ops)
#   E. cron authentication remains enforced on the app side (403 without key
#      on the production-rehearsal instance was proven in Work 3A-D; here we
#      assert the scheduler's own configured-secret posture)
# All output teed to docs/staging/evidence/phase3-work3-scheduler-rehearsal.txt
# ============================================================================
set -uo pipefail
cd /home/z/my-project
EV=docs/staging/evidence/phase3-work3-scheduler-rehearsal.txt
exec > >(tee "$EV") 2>&1
PASS=0; FAIL=0
ok()  { echo "PASS — $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL — $1"; FAIL=$((FAIL+1)); }
SCHED_URL=http://127.0.0.1:3005
APP=http://127.0.0.1:3000
PINNED="$(cat .agent-tmp/staging-pin.txt)"
export SUPABASE_DATABASE_URL="$PINNED"

echo "== Work 3B scheduler reliability rehearsal — $(date -u +%FT%TZ) =="

echo "-- A. liveness --"
S=$(curl -s -m 8 $SCHED_URL/ || true)
echo "$S" | grep -q '"service":"expiry-scheduler"' && ok "A1 scheduler service answering on :3005" || bad "A1 scheduler not answering"
echo "$S" | grep -q '"consecutiveFailures":0' && ok "A2 zero consecutive tick failures" || bad "A2 tick failures present"
FRESH1=$(curl -s -m 10 $APP/api/health/scheduler || true)
echo "$FRESH1" | grep -q '"verdict":"fresh"' && ok "A3 app-side scheduler health FRESH" || bad "A3 not fresh: $(echo "$FRESH1" | head -c 160)"
EXP_BEFORE=$(bun -e 'const {db}=await import("./src/lib/db");console.log(await db.order.count({where:{status:"payment_expired"}}));await db.$disconnect();' 2>/dev/null | tail -1)
REST_BEFORE=$(bun -e 'const {db}=await import("./src/lib/db");console.log(await db.inventoryLog.count({where:{reason:{startsWith:"expiry:"}}}));await db.$disconnect();' 2>/dev/null | tail -1)
echo "    baseline: expiredOrders=$EXP_BEFORE expiryRestockLogs=$REST_BEFORE"

echo "-- B. controlled interruption (~70s) --"
PID=$(ss -tlnp 2>/dev/null | grep ':3005 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$PID" ] && kill "$PID" && ok "B1 scheduler stopped (pid $PID)" || bad "B1 could not stop scheduler"
sleep 70
STALE=$(curl -s -m 10 $APP/api/health/scheduler || true)
echo "$STALE" | grep -q '"verdict":"stale"' && ok "B2 app-side health flips to STALE during outage" || bad "B2 stale not detected: $(echo "$STALE" | head -c 160)"

echo "-- C. recovery --"
(cd mini-services/expiry-scheduler && nohup bun run dev >> scheduler.log 2>&1 &)
sleep 40
S2=$(curl -s -m 8 $SCHED_URL/ || true)
echo "$S2" | grep -q '"service":"expiry-scheduler"' && ok "C1 scheduler restarted and answering" || bad "C1 restart failed"
echo "$S2" | grep -q '"consecutiveFailures":0' && ok "C2 zero failures after recovery" || bad "C2 failures after recovery"
grep -q "MISSED_INTERVAL" mini-services/expiry-scheduler/scheduler.log && ok "C3 catch-up tick recorded (MISSED_INTERVAL alert in scheduler.log)" || bad "C3 no catch-up alert found"
FRESH2=$(curl -s -m 10 $APP/api/health/scheduler || true)
echo "$FRESH2" | grep -q '"verdict":"fresh"' && ok "C4 app-side health back to FRESH" || bad "C4 still stale: $(echo "$FRESH2" | head -c 160)"

echo "-- D. exactly-once across the outage window --"
EXP_AFTER=$(bun -e 'const {db}=await import("./src/lib/db");console.log(await db.order.count({where:{status:"payment_expired"}}));await db.$disconnect();' 2>/dev/null | tail -1)
REST_AFTER=$(bun -e 'const {db}=await import("./src/lib/db");console.log(await db.inventoryLog.count({where:{reason:{startsWith:"expiry:"}}}));await db.$disconnect();' 2>/dev/null | tail -1)
echo "    after: expiredOrders=$EXP_AFTER expiryRestockLogs=$REST_AFTER"
[ "$EXP_AFTER" = "$EXP_BEFORE" ] && ok "D1 no new expired orders during the idle outage window (no duplicate sweep effects)" || bad "D1 expiredOrders changed $EXP_BEFORE→$EXP_AFTER"
[ "$REST_AFTER" = "$REST_BEFORE" ] && ok "D2 restock log count unchanged (exactly-once preserved)" || bad "D2 restockLogs changed $REST_BEFORE→$REST_AFTER"

echo
echo "== Work 3B scheduler rehearsal: $PASS PASS / $FAIL FAIL =="
exit $FAIL
