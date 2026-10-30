#!/bin/bash
# AFFILIATE E2E — stage 2b: exact money assertions scoped to THIS run's orders
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✔ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ✘ $1"; }

ONUMS=$(python3 -c "
import json
d=json.load(open('/tmp/aff-pay.json'))['data']
ns=d.get('orderNumbers') or [d.get('orderNumber')]
print(' '.join(ns))")
echo "this run's orders: $ONUMS"

bun -e "
import { db } from './src/lib/db';
const nums = '$ONUMS'.split(' ');
const items = await db.orderItem.findMany({ where: { orderId: { in: (await db.order.findMany({ where: { orderNumber: { in: nums } }, select: { id: true } })).map(o=>o.id) } }, select: { id:true, productId:true, lineSubtotalMinor:true, affiliateDirectId:true, affiliateSponsorId:true, affiliateLinkId:true, affiliateRateBps:true, affiliatePoolMinor:true, breakdownJson:true } });
const cs = await db.affiliateCommission.findMany({ where: { orderItemId: { in: items.map(i=>i.id) } }, include: { entries: true } });
const out = items.map(it => {
  const c = cs.find(x=>x.orderItemId===it.id);
  return { item: it.id.slice(-5), base: c?.commissionableBaseMinor ?? null, pool: c?.poolMinor ?? null, rate: c?.rateBps ?? null,
    direct: c?.entries.find(e=>e.role==='direct')?.amountMinor ?? null, sponsor: c?.entries.find(e=>e.role==='sponsor')?.amountMinor ?? null,
    sponsorSet: !!c?.sponsorId, linkType: c?.linkType ?? null, channel: c?.channel ?? null, status: c?.status ?? null,
    itemSnapshot: { dir: !!it.affiliateDirectId, spo: !!it.affiliateSponsorId, rate: it.affiliateRateBps, pool: it.affiliatePoolMinor } };
});
console.log(JSON.stringify(out));" > /tmp/aff-money2.json
cat /tmp/aff-money2.json | python3 -c "
import json,sys
rows=json.load(sys.stdin)
assert len(rows)==2, f'expected 2, got {len(rows)}'
for r in rows:
    assert r['pool'] is not None and r['pool']>0, f'no commission for item {r[\"item\"]}'
    expected = (r['base']*r['rate'])//10000
    assert r['pool']==expected, f'pool {r[\"pool\"]} != floor(B×R) {expected}'
    assert r['direct']+ (r['sponsor'] or 0) == r['pool'], f'D+S != P for {r[\"item\"]}'
    if r['sponsor']: assert r['sponsor']==r['pool']//10
    assert r['linkType']=='product' and r['channel'] in ('tiktok','whatsapp'), f'snapshot fields {r[\"linkType\"]}/{r[\"channel\"]}'
    assert r['itemSnapshot']['dir'] and r['itemSnapshot']['rate'] is not None, 'OrderItem snapshot incomplete'
no_s = [r for r in rows if not r['sponsor']]; with_s = [r for r in rows if r['sponsor']]
assert len(no_s)==1 and len(with_s)==1, 'expected one no-sponsor + one with-sponsor item'
assert no_s[0]['direct']==no_s[0]['pool'], 'no-sponsor case must pay 100% to direct'
assert with_s[0]['sponsor']>=1, 'sponsor share must be ≥1 sen'
print(f'MATH-OK: item A(no sponsor): pool={no_s[0][\"pool\"]} direct={no_s[0][\"direct\"]} | item B(sponsor): pool={with_s[0][\"pool\"]} direct={with_s[0][\"direct\"]} sponsor={with_s[0][\"sponsor\"]}')" && ok "90/10 math exact on this run's orders" || bad "math assertion"

echo "──── M2b. Ledger liability ≥ total pools of this run ────"
bun -e "
import { db } from './src/lib/db';
const nums = '$ONUMS'.split(' ');
const cs = await db.affiliateCommission.findMany({ where: { orderNumber: { in: nums } } });
const expect = cs.reduce((s,c)=>s+c.poolMinor,0);
const acct = await db.ledgerAccount.findUnique({ where: { code: 'PLATFORM:AFFILIATE_LIABILITY' } });
const lines = acct ? await db.ledgerLine.findMany({ where: { accountId: acct.id } }) : [];
const bal = lines.reduce((s,l)=>s+(l.amountMinor ?? 0)-(l.debitMinor ?? 0),0);
console.log(JSON.stringify({ expect, bal, ok: bal>=expect }));" > /tmp/aff-ledger2.json
cat /tmp/aff-ledger2.json | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['ok'], f\"ledger {d['bal']} < expected {d['expect']}\"; print(f\"LEDGER-OK: liability balance {d['bal']} sen ≥ posted pools {d['expect']} sen\")" && ok "double-entry liability tracks posted pools" || bad "ledger"

echo "──── M4. Entry statuses for this run: direct+sponsor lifecycle ────"
bun -e "
import { db } from './src/lib/db';
const nums = '$ONUMS'.split(' ');
const cs = await db.affiliateCommission.findMany({ where: { orderNumber: { in: nums } }, include: { entries: true } });
console.log(JSON.stringify(cs.flatMap(c=>c.entries.map(e=>({role:e.role,status:e.status,amt:e.amountMinor,availAt:!!e.availableAt})))));"
echo "STAGE2B-DONE P=$PASS F=$FAIL"
