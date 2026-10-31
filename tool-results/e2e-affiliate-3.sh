#!/bin/bash
# AFFILIATE E2E — stage 3: payout → refund reversal → reconciliation → kill switch → security
B=http://localhost:3000
CT='Content-Type: application/json'
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✔ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ✘ $1"; }
req(){ local m=$1 u=$2 t=$3 d=$4
  if [ -n "$t" ]; then curl -s -X "$m" "$B$u" -H "$CT" ${d:+-d "$d"} -H "Authorization: Bearer $t" -H "X-SM-Client: web"
  else curl -s -X "$m" "$B$u" -H "$CT" ${d:+-d "$d"} -H "X-SM-Client: web"; fi; }

echo "════ P1. Hub figures (A: personal + sponsor earnings) ════"
EA=$(bun -e "import { db } from './src/lib/db'; const s=await db.shopperUser.findFirst({ where:{ email:{ contains:'aff-alpha' } }, orderBy:{ createdAt:'desc' } }); console.log(s.email);")
TA=$(req POST /api/auth/shopper/login "" "{\"email\":\"$EA\",\"password\":\"Verify123!\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
OV=$(req GET "/api/affiliate/overview?days=30" "$TA")
echo "$OV" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
fin=d['finance']
assert fin['personalEarnedMinor']>0 and fin['sponsorEarnedMinor']>0, f'expected both earning kinds, got {fin}'
assert fin['personalEarnedMinor']!=fin['sponsorEarnedMinor'], 'sources must stay separate'
print(f\"HUB-OK: personal={fin['personalEarnedMinor']} sponsor={fin['sponsorEarnedMinor']} attributedOrders={d['commerce']['attributedOrders']}\")" && ok "Overview separates personal vs sponsor earnings" || bad "overview: $OV"
# Security: A's earnings list must NOT include B's rows
EBA=$(bun -e "import { db } from './src/lib/db'; const s=await db.shopperUser.findFirst({ where:{ email:{ contains:'aff-beta' } }, orderBy:{ createdAt:'desc' } }); const p=await db.affiliateProfile.findUnique({ where:{ userId:s.id } }); console.log(p.id);")
SCOPE=$(req GET "/api/affiliate/earnings?role=direct" "$TA" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['data'].get('rows',[])
bad=[r for r in rows if r.get('affiliateId')==\"$EBA\"]
print('LEAK' if bad else 'SCOPED')")
[ "$SCOPE" = "SCOPED" ] && ok "earnings scoped to own affiliate (no cross-affiliate leak)" || bad "scope: $SCOPE"

echo "════ P2. Payout: request → admin approve → mark-paid ════"
PR=$(req POST /api/affiliate/payouts "$TA" "")
PID=$(echo "$PR" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['payoutId'])")
AMT=$(echo "$PR" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['amountMinor'])")
[ -n "$PID" ] && ok "A requested payout $PID for $AMT sen" || { bad "payout request: $PR"; }
TA2=$(req POST /api/auth/login "" '{"email":"admin@nomofee.io","password":"Admin123!","portal":"admin"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
AP=$(req POST "/api/admin/affiliate/payouts/$PID/process" "$TA2" '{"action":"approve"}')
[ "$(echo "$AP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['status'])")" = "processing" ] && ok "admin approved → processing (T-A3)" || bad "approve: $AP"
MP=$(req POST "/api/admin/affiliate/payouts/$PID/process" "$TA2" '{"action":"mark-paid","reference":"E2E-BANK-001"}')
[ "$(echo "$MP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['status'])")" = "paid" ] && ok "admin marked paid w/ reference E2E-BANK-001 (T-A4)" || bad "mark-paid: $MP"
bun -e "
import { db } from './src/lib/db';
const p = await db.affiliatePayout.findUnique({ where: { id: '$PID' }, include: { entries: true } });
const cids = [...new Set(p.entries.map(e=>e.commissionId))];
const cs = await db.affiliateCommission.findMany({ where: { id: { in: cids } }, select: { id:true, status:true } });
const st = { payout: p.status, ref: p.reference, entryStatuses: p.entries.map(e=>e.status), commissionStatuses: cs.map(c=>c.status) };
console.log(JSON.stringify(st));
" > /tmp/aff-payout-state.json
cat /tmp/aff-payout-state.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['payout']=='paid' and d['ref']=='E2E-BANK-001'
assert all(s=='paid' for s in d['entryStatuses']), d['entryStatuses']
assert all(s=='paid' for s in d['commissionStatuses']), f'commission rows not advanced: {d[\"commissionStatuses\"]}'
print('PAYOUT-OK: entries + parent commissions both paid')" && ok "payout advanced entries AND parent commissions to paid" || bad "payout state: $(cat /tmp/aff-payout-state.json)"

echo "════ R1. 50% refund on the sponsor-chain order → proportional reversal ════"
ONUM_B=$(python3 -c "import json;d=json.load(open('/tmp/aff-pay.json'))['data'];ns=d.get('orderNumbers') or [d.get('orderNumber')];print(ns[1] if len(ns)>1 else ns[0])")
TS=$(req POST /api/auth/login "" '{"email":"byte@nomofee.io","password":"Seller123!","portal":"seller"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
RR=$(req POST "/api/store/orders/$ONUM_B/refund-request" "$TS" '{"amountMinor":9950,"reason":"e2e partial refund — 50% of RM199.00"}')
RID=$(echo "$RR" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
[ -n "$RID" ] && ok "seller requested RM99.50 refund (50%)" || { bad "refund-request: $RR"; }
req POST "/api/admin/refunds/$RID/approve" "$TA2" '{}' > /dev/null
RP=$(req POST "/api/admin/refunds/$RID/process" "$TA2" '{}')
REV=$(echo "$RP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data'].get('affiliateReversalMinor'))")
echo "$RP" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
rev=d.get('affiliateReversalMinor')
assert rev==995, f'expected 995 reversal (50% of 1990 pool), got {rev}'
print(f\"REVERSAL-OK: affiliate reversal {rev} sen = 50% of pool\")" && ok "proportional affiliate reversal booked (T5)" || bad "reversal: $RP"
bun -e "
import { db } from './src/lib/db';
const nums = '$ONUM_B'.split(' ');
const c = await db.affiliateCommission.findFirst({ where: { orderNumber: { in: nums } }, include: { entries: true } });
const dE = c.entries.find(e=>e.role==='direct'), sE = c.entries.find(e=>e.role==='sponsor');
console.log(JSON.stringify({ direct: { rev: dE.reversedMinor, amt: dE.amountMinor, st: dE.status }, sponsor: { rev: sE.reversedMinor, amt: sE.amountMinor, st: sE.status }, commission: c.status }));" > /tmp/aff-rev.json
cat /tmp/aff-rev.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['direct']['rev']+d['sponsor']['rev']==995, 'entry reversals must sum to item reversal'
assert d['direct']['rev']==896 and d['sponsor']['rev']==99, f'share split {d}'
assert d['direct']['st'] in ('available','approved') and d['sponsor']['st'] in ('available','approved'), 'partial reversal keeps live status'
print(f\"SPLIT-OK: direct -{d['direct']['rev']} (90% share), sponsor -{d['sponsor']['rev']} (10% share)\")" && ok "reversal split honors frozen 90/10 allocation" || bad "reversal split: $(cat /tmp/aff-rev.json)"

echo "════ RC. Reconciliation (7-point + ledger invariant) ════"
RC=$(req GET /api/admin/affiliate/reconciliation "$TA2")
echo "$RC" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
inv=d.get('invariantOk', d.get('ledger',{}).get('invariantOk'))
print('invariant:', inv)
assert inv is True, f'invariant not OK: {json.dumps(d)[:300]}'
print('RECON-OK')" && ok "reconciliation invariant OK" || bad "recon: $(echo "$RC" | head -c 300)"

echo "════ K. Kill switch ════"
bun -e "import { db } from './src/lib/db'; await db.setting.upsert({ where:{key:'affiliate.enabled'}, create:{key:'affiliate.enabled',valueJson:'false',description:'e2e'}, update:{valueJson:'false'} });"
OFF=$(req POST /api/affiliate/track "$TA" '{"code":"dd896bbd77"}')
echo "$OFF" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('error',{}).get('code')=='AFFILIATE_DISABLED' or d.get('data',{}).get('target') is None, d; print('KILL-OK:', d.get('error',{}).get('message') or 'no attribution')" && ok "kill switch blocks attribution" || bad "kill: $OFF"
bun -e "import { db } from './src/lib/db'; await db.setting.upsert({ where:{key:'affiliate.enabled'}, create:{key:'affiliate.enabled',valueJson:'true',description:'e2e'}, update:{valueJson:'true'} });"
echo "STAGE3-DONE P=$PASS F=$FAIL"
