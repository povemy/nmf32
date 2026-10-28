#!/usr/bin/env bash
# E2E (Issue A + B) — non-persistent: holiday PATCH reverted; temp holidays deleted; one additive export row.
set -u
cd /home/z/my-project
pkill -f next-server 2>/dev/null; sleep 1
setsid nohup bun run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 45); do sleep 2; code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null); [ "$code" = "200" ] && { echo "server UP"; break; }; done

BASE=http://localhost:3000
rm -f /tmp/cj.txt
LOGIN=$(curl -s -c /tmp/cj.txt -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@nomofee.io","password":"Admin123!","portal":"admin"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('token',''))" 2>/dev/null)
echo "login token len: ${#TOKEN}"
AUTH="Authorization: Bearer $TOKEN"

sim() {
  curl -s -b /tmp/cj.txt -H "$AUTH" -X POST $BASE/api/admin/commission/simulate -H 'Content-Type: application/json' -d "$1" \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];t=d.get('trace') or {};print('   commission=',d['commissionMinor'],'bps=',t.get('bps'),'source=',t.get('rule_source'),'holiday=',(t.get('holiday_id') or '')[:12],'flags=',t.get('flags'))"
}

FB=cmvdl8x1c000op7p9q4p7gh3a   # Food & Beverage, normal 500 bps
EL=cmvdl8x100005p7p9vj94eqdm   # Electronics,   normal 600 bps
BODY_FB='{"priceMinor":12000,"qty":1,"discountMinor":0,"shippingMinor":0,"categoryId":"'$FB'"}'
BODY_EL='{"priceMinor":12000,"qty":1,"discountMinor":0,"shippingMinor":0,"categoryId":"'$EL'"}'

HID=$(curl -s -b /tmp/cj.txt -H "$AUTH" $BASE/api/admin/commission/holidays | python3 -c "import sys,json;rows=json.load(sys.stdin)['data'];print([r['id'] for r in rows if 'Merdeka' in r['name']][0])")

echo "— [A1] baseline: active Merdeka holiday (0 bps) on F&B (normal 500) → full holiday:"
sim "$BODY_FB"

echo "— [A2] PATCH holiday → 300 bps (partial, below normal 500) → 12000×300/10000 = 360 sen:"
curl -s -b /tmp/cj.txt -H "$AUTH" -X PATCH $BASE/api/admin/commission/holidays/$HID -H 'Content-Type: application/json' -d '{"bps":300}' > /dev/null
sim "$BODY_FB"

echo "— [A3] PATCH holiday → 8000 bps (ABOVE normal 500) → clamps to 500 + flag:"
curl -s -b /tmp/cj.txt -H "$AUTH" -X PATCH $BASE/api/admin/commission/holidays/$HID -H 'Content-Type: application/json' -d '{"bps":8000}' > /dev/null
sim "$BODY_FB"

echo "— [C1] API rejects sub-bps precision (percent 8.355) → expect 400:"
curl -s -o /dev/null -w "   HTTP %{http_code}\n" -b /tmp/cj.txt -H "$AUTH" -X PATCH $BASE/api/admin/commission/holidays/$HID -H 'Content-Type: application/json' -d '{"percent":8.355}'
echo "— [C2] API rejects float bps (500.5) → expect 400:"
curl -s -o /dev/null -w "   HTTP %{http_code}\n" -b /tmp/cj.txt -H "$AUTH" -X PATCH $BASE/api/admin/commission/holidays/$HID -H 'Content-Type: application/json' -d '{"bps":500.5}'
echo "— [C3] API rejects out-of-range bps (10001) → expect 400:"
curl -s -o /dev/null -w "   HTTP %{http_code}\n" -b /tmp/cj.txt -H "$AUTH" -X PATCH $BASE/api/admin/commission/holidays/$HID -H 'Content-Type: application/json' -d '{"bps":10001}'

NOW=$(python3 -c "import datetime;print(datetime.datetime.now(datetime.UTC).isoformat())")
END=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.UTC)+datetime.timedelta(days=3)).isoformat())")
PAST=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.UTC)-datetime.timedelta(days=2)).isoformat())")
TOM=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.UTC)+datetime.timedelta(days=1)).isoformat())")

echo "— [A4] overlap on Electronics: LATER holiday (300bps, starts now) + EARLIER holiday (100bps, started -2d) → earliest-starting wins:"
H1=$(curl -s -b /tmp/cj.txt -H "$AUTH" -X POST $BASE/api/admin/commission/holidays -H 'Content-Type: application/json' -d "{\"name\":\"E2E overlap LATER\",\"scope\":\"categories\",\"scopeIds\":[\"$EL\"],\"bps\":300,\"startsAt\":\"$NOW\",\"endsAt\":\"$END\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
H2=$(curl -s -b /tmp/cj.txt -H "$AUTH" -X POST $BASE/api/admin/commission/holidays -H 'Content-Type: application/json' -d "{\"name\":\"E2E overlap EARLIER\",\"scope\":\"categories\",\"scopeIds\":[\"$EL\"],\"bps\":100,\"startsAt\":\"$PAST\",\"endsAt\":\"$END\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
sim "$BODY_EL"
curl -s -b /tmp/cj.txt -H "$AUTH" -X DELETE $BASE/api/admin/commission/holidays/$H1 > /dev/null
curl -s -b /tmp/cj.txt -H "$AUTH" -X DELETE $BASE/api/admin/commission/holidays/$H2 > /dev/null
echo "   (temp overlap holidays deleted)"

echo "— [A5] scheduled holiday (starts tomorrow, 0bps) must NOT apply → Electronics normal 600 → 720 sen:"
H3=$(curl -s -b /tmp/cj.txt -H "$AUTH" -X POST $BASE/api/admin/commission/holidays -H 'Content-Type: application/json' -d "{\"name\":\"E2E scheduled\",\"scope\":\"categories\",\"scopeIds\":[\"$EL\"],\"bps\":0,\"startsAt\":\"$TOM\",\"endsAt\":\"$END\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
sim "$BODY_EL"
curl -s -b /tmp/cj.txt -H "$AUTH" -X DELETE $BASE/api/admin/commission/holidays/$H3 > /dev/null
echo "   (temp scheduled holiday deleted)"

echo "— [A6] restore Merdeka to original 0 bps and re-verify full holiday:"
curl -s -b /tmp/cj.txt -H "$AUTH" -X PATCH $BASE/api/admin/commission/holidays/$HID -H 'Content-Type: application/json' -d '{"bps":0}' > /dev/null
sim "$BODY_FB"

echo "— [B1] legacy export re-download is byte-stable (effective_rate_pct,7.3):"
curl -s -b /tmp/cj.txt -H "$AUTH" $BASE/api/admin/commission/exports/cmvc52axb0000rbz9m30ttran/download -o /tmp/legacy.csv
head -6 /tmp/legacy.csv

echo "— [B2] NEW export (v2 schema) → CSV renders bps canonically + snapshot stamped schemaVersion 2:"
EXP=$(curl -s -b /tmp/cj.txt -H "$AUTH" -X POST $BASE/api/admin/commission/exports -H 'Content-Type: application/json' -d '{"days":30}')
echo "$EXP" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
snap = d['snapshot']
csv = d['csv']
print('   snapshot.schemaVersion =', snap.get('schemaVersion'))
print('   summary.effectiveRateBps =', snap['summary']['effectiveRateBps'])
print('   CSV rate line =', [l for l in csv.splitlines() if 'effective_rate_pct' in l][0])
print('   CSV money line =', [l for l in csv.splitlines() if 'total_commission_myr' in l][0])
"
echo "— [B3] re-download the new export → byte-identical (stability):"
NEWID=$(echo "$EXP" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['export']['id'])")
curl -s -b /tmp/cj.txt -H "$AUTH" $BASE/api/admin/commission/exports/$NEWID/download -o /tmp/re1.csv
curl -s -b /tmp/cj.txt -H "$AUTH" $BASE/api/admin/commission/exports/$NEWID/download -o /tmp/re2.csv
cmp -s /tmp/re1.csv /tmp/re2.csv && echo "   ✓ byte-identical re-downloads" || echo "   ✗ DIFFER"

echo "— [A7] final holiday state (Merdeka must be bps=0, no E2E leftovers):"
curl -s -b /tmp/cj.txt -H "$AUTH" $BASE/api/admin/commission/holidays | python3 -c "
import sys, json
rows = json.load(sys.stdin)['data']
for r in rows: print('   ', r['name'], '| bps', r['bps'], '| active', r['isActive'])
"
echo "E2E DONE"
