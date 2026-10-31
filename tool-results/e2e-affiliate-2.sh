#!/bin/bash
# AFFILIATE E2E — stage 2: money verification, idempotency, lifecycle
B=http://localhost:3000
CT='Content-Type: application/json'
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✔ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ✘ $1"; }
req(){ local m=$1 u=$2 t=$3 d=$4
  if [ -n "$t" ]; then curl -s -X "$m" "$B$u" -H "$CT" ${d:+-d "$d"} -H "Authorization: Bearer $t" -H "X-SM-Client: web"
  else curl -s -X "$m" "$B$u" -H "$CT" ${d:+-d "$d"} -H "X-SM-Client: web"; fi; }

echo "════ M1. Commission rows: exact 90/10 math ════"
bun -e "
import { db } from './src/lib/db';
const cs = await db.affiliateCommission.findMany({ include: { entries: true }, orderBy: { createdAt: 'desc' }, take: 2 });
const out = [];
for (const c of cs) {
  const d = c.entries.find(e=>e.role==='direct'), s = c.entries.find(e=>e.role==='sponsor');
  out.push({ order: c.orderNumber.slice(-6), base: c.commissionableBaseMinor, rate: c.rateBps, pool: c.poolMinor, direct: d?.amountMinor, sponsor: s?.amountMinor ?? 0, sponsorId: c.sponsorId, linkType: c.linkType, channel: c.channel, productId: !!c.productId, status: c.status });
}
console.log(JSON.stringify(out));
" > /tmp/aff-money.json
cat /tmp/aff-money.json | python3 -c "
import json,sys
rows=json.load(sys.stdin)
assert len(rows)==2, f'expected 2 commission rows, got {len(rows)}'
for r in rows:
    expected_pool = (r['base']*r['rate'])//10000
    assert r['pool']==expected_pool, f'pool {r[\"pool\"]} != B*R {expected_pool}'
    assert r['direct']+r['sponsor']==r['pool'], f'D+S {r[\"direct\"]+r[\"sponsor\"]} != P {r[\"pool\"]}'
    if r['sponsor']>0: assert r['sponsor']==r['pool']//10, f'sponsor != 10% pool'
    assert r['productId'] and r['linkType']=='product' and r['channel'] in ('tiktok','whatsapp'), 'snapshot fields missing'
print('MATH-OK', json.dumps(rows))" && ok "pool = B×R, D+S=P, sponsor=10% of pool, snapshot fields populated"
ASPLIT=$(cat /tmp/aff-money.json | python3 -c "import json,sys; rows=json.load(sys.stdin); noS=[r for r in rows if r['sponsor']==0]; withS=[r for r in rows if r['sponsor']>0]; print('OK' if len(noS)==1 and len(withS)==1 and noS[0]['direct']==noS[0]['pool'] else 'BAD')")
[ "$ASPLIT" = "OK" ] && ok "no-sponsor case: direct affiliate received 100% of pool" || bad "no-sponsor split: $ASPLIT"

echo "════ M2. Ledger: PLATFORM:AFFILIATE_LIABILITY credited, invariant ════"
bun -e "
import { db } from './src/lib/db';
const acct = await db.ledgerAccount.findUnique({ where: { code: 'PLATFORM:AFFILIATE_LIABILITY' } });
if (!acct) { console.log('NO-ACCOUNT'); process.exit(0); }
const lines = await db.ledgerLine.findMany({ where: { accountId: acct.id }, orderBy: { createdAt: 'desc' }, take: 5 });
const bal = lines.reduce((s,l)=>s+l.amountMinor-l.debitMinor, 0);
console.log(JSON.stringify({ balance: bal, lines: lines.map(l=>({ d: l.debitMinor, c: l.amountMinor - (l.debitMinor ?? 0), txn: l.transactionId.slice(-4) })) }));" > /tmp/aff-ledger.json
cat /tmp/aff-ledger.json && cat /tmp/aff-ledger.json | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert d!='NO-ACCOUNT', 'AFFILIATE_LIABILITY account missing'
assert d['balance']>0, f'liability balance {d[\"balance\"]} not positive'
print('LEDGER-OK')" && ok "affiliate liability ledger balance = $(cat /tmp/aff-ledger.json | j d.balance 2>/dev/null || python3 -c "import json;print(json.load(open('/tmp/aff-ledger.json'))['balance'])") sen"

echo "════ M3. Idempotency: duplicate webhook posts nothing ════"
REF=$(python3 -c "import json;print(json.load(open('/tmp/aff-pay.json'))['data']['orderNumbers'][0] if json.load(open('/tmp/aff-pay.json'))['data'].get('orderNumbers') else json.load(open('/tmp/aff-pay.json'))['data']['orderNumber'])" 2>/dev/null)
SIM2=$(req POST "/api/checkout/payments/$(python3 -c "import json;print(json.load(open('/tmp/aff-pay.json')) and open('/tmp/aff-pay.json').read() and __import__('re').search(r'ref_[a-f0-9]+', json.dumps(json.load(open('/tmp/aff-checkout.json')))).group(0))")/simulate" "" '{"result":"succeeded"}')
CNT=$(bun -e "
import { db } from './src/lib/db';
console.log(await db.affiliateCommission.count());")
echo "  duplicate simulate → commissions still = $CNT"
[ "$CNT" = "2" ] && ok "exactly-once posting (duplicate webhook no-op)" || bad "commission count $CNT != 2"

echo "════ L1. Lifecycle: ship → deliver → approve → tick matures → available ════"
shipdeliv(){ local email=$1 onum=$2
  local t=$(req POST /api/auth/login "" "{\"email\":\"$email\",\"password\":\"Seller123!\",\"portal\":\"seller\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
  req POST "/api/store/orders/$onum/ship" "$t" '{"mode":"manual","provider":"manual","trackingNumber":"AFF-TEST-001"}' > /dev/null
  local d=$(req POST "/api/store/orders/$onum/deliver" "$t" '{"note":"e2e"}')
  [ "$(echo "$d" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['status'])")" = "delivered" ] && ok "$email order $onum delivered (deliver route WORKS post-fix)" || bad "$email deliver: $d"
}
shipdeliv lumina@nomofee.io "$REF"
ONUM2=$(python3 -c "import json;d=json.load(open('/tmp/aff-pay.json'))['data'];ns=d.get('orderNumbers') or [d.get('orderNumber')];print(ns[1] if len(ns)>1 else '')")
[ -n "$ONUM2" ] && shipdeliv byte@nomofee.io "$ONUM2"
TICK=$(req POST /api/cron/affiliate-tick "" "" )
[ -n "$(echo "$TICK" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['approved'])")" ] && ok "cron affiliate-tick ran: $(echo "$TICK" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(f\"approved={d['approved']} matured={d['matured']}\")")" || bad "tick: $TICK"
STATS=$(bun -e "
import { db } from './src/lib/db';
const es = await db.affiliateCommissionEntry.findMany({ select: { role:true, status:true } });
console.log(JSON.stringify(es.reduce((m,e)=>(m[e.status]=(m[e.status]??0)+1,m),{})));")
echo "  entry statuses: $STATS"
echo "$STATS" | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert d.get('available',0)+d.get('paid',0)>=2, f'expected matured entries, got {d}'
print('LIFECYCLE-OK')" && ok "entries matured to available (review_days=0)" || bad "lifecycle: $STATS"
echo "STAGE2-DONE P=$PASS F=$FAIL"
