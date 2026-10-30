#!/bin/bash
# AFFILIATE E2E — stage 3b: corrected assertions
B=http://localhost:3000
CT='Content-Type: application/json'
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✔ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ✘ $1"; }
req(){ local m=$1 u=$2 t=$3 d=$4
  if [ -n "$t" ]; then curl -s -X "$m" "$B$u" -H "$CT" ${d:+-d "$d"} -H "Authorization: Bearer $t" -H "X-SM-Client: web"
  else curl -s -X "$m" "$B$u" -H "$CT" ${d:+-d "$d"} -H "X-SM-Client: web"; fi; }

echo "════ P2b. Payout state (entries by payoutId, no include) ════"
PID=$(bun -e "import { db } from './src/lib/db'; const p=await db.affiliatePayout.findFirst({ orderBy:{ createdAt:'desc' } }); console.log(p.id);")
bun -e "
import { db } from './src/lib/db';
const p = await db.affiliatePayout.findUnique({ where: { id: '$PID' } });
const entries = await db.affiliateCommissionEntry.findMany({ where: { payoutId: '$PID' } });
const cids = [...new Set(entries.map(e=>e.commissionId))];
const cs = await db.affiliateCommission.findMany({ where: { id: { in: cids } } });
const roles = entries.map(e=>e.role);
console.log(JSON.stringify({ payout: p.status, ref: p.reference, amount: p.amountMinor, roles, entryStatuses: entries.map(e=>e.status), commissionStatuses: cs.map(c=>c.status), statementBuilt: p.statementJson !== '{}' }));
" > /tmp/aff-payout2.json
cat /tmp/aff-payout2.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['payout']=='paid' and d['ref']=='E2E-BANK-001', d['payout']
assert all(s=='paid' for s in d['entryStatuses']), d['entryStatuses']
assert all(s=='paid' for s in d['commissionStatuses']), d['commissionStatuses']
assert d['statementBuilt'], 'statementJson was never built'
assert 'direct' in d['roles'] and 'sponsor' in d['roles'], f'payout must cover both roles: {d[\"roles\"]}'
print(f\"PAYOUT-OK: RM {d['amount']/100:.2f} paid (direct+sponsor roles), entries+commissions paid, statement built\")" && ok "payout state machine + statement complete" || bad "payout: $(cat /tmp/aff-payout2.json)"

echo "════ R1b. Refund reversal — corrected assertions ════"
cat /tmp/aff-rev.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['direct']['rev']+d['sponsor']['rev']==995
assert d['direct']['rev']==896 and d['sponsor']['rev']==99
# sponsor entry was already PAID when the refund landed → stays paid, recovery offset
assert d['sponsor']['st']=='paid', f'paid entry must stay paid (recovery), got {d[\"sponsor\"][\"st\"]}'
assert d['direct']['st'] in ('available','approved'), d['direct']['st']
print('REVERSAL-OK: 896(direct, live)+99(sponsor, paid→recovery)=995 — spec §11 exact')" && ok "reversal split + late-refund-recovery semantics" || bad "reversal: $(cat /tmp/aff-rev.json)"

echo "════ K. Kill switch — no attribution touch while disabled ════"
TA=$(bun -e "import { db } from './src/lib/db'; const s=await db.shopperUser.findFirst({ where:{ email:{ contains:'aff-alpha' } }, orderBy:{ createdAt:'desc' } }); const t=await db.session.findFirst({ where:{ userId:s.id, expiresAt:{ gt:new Date() } }, orderBy:{ createdAt:'desc' } }); console.log(t.token);")
CODE=$(bun -e "import { db } from './src/lib/db'; const s=await db.shopperUser.findFirst({ where:{ email:{ contains:'aff-alpha' } }, orderBy:{ createdAt:'desc' } }); const p=await db.affiliateProfile.findUnique({ where:{ userId:s.id } }); const l=await db.affiliateLink.findFirst({ where:{ affiliateId:p.id } }); console.log(l.code);")
bun -e "import { db } from './src/lib/db'; await db.setting.upsert({ where:{key:'affiliate.enabled'}, create:{key:'affiliate.enabled',valueJson:'false',description:'e2e'}, update:{valueJson:'false'} });" > /dev/null
BEFORE=$(bun -e "import { db } from './src/lib/db'; console.log(await db.affiliateAttributionTouch.count());")
req POST /api/affiliate/track "$TA" "{\"code\":\"$CODE\"}" > /dev/null
AFTER=$(bun -e "import { db } from './src/lib/db'; console.log(await db.affiliateAttributionTouch.count());")
[ "$BEFORE" = "$AFTER" ] && ok "kill switch: link navigates but NO attribution touch recorded ($BEFORE → $AFTER)" || bad "touch count $BEFORE → $AFTER (leak while disabled)"
# re-enable + confirm touch recorded again
bun -e "import { db } from './src/lib/db'; await db.setting.upsert({ where:{key:'affiliate.enabled'}, create:{key:'affiliate.enabled',valueJson:'true',description:'e2e'}, update:{valueJson:'true'} });" > /dev/null
req POST /api/affiliate/track "$TA" "{\"code\":\"$CODE\"}" > /dev/null
AFTER2=$(bun -e "import { db } from './src/lib/db'; console.log(await db.affiliateAttributionTouch.count());")
[ "$AFTER2" = "$((AFTER+1))" ] && ok "re-enabled: attribution resumes ($AFTER → $AFTER2)" || bad "resume: $AFTER → $AFTER2"
echo "STAGE3B-DONE P=$PASS F=$FAIL"
