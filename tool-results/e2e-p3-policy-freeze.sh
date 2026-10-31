#!/bin/bash
# P3 FREEZE VERIFICATION — "Policy setting changed between checkout and payment"
# (post-implementation audit, mandated test #8).
#
# Scenario: sponsor override is ON at checkout (snapshot frozen true on the
# OrderItem), then an admin flips affiliate.sponsor_enabled OFF before the
# payment webhook lands. The commission MUST still post with the frozen 90/10
# split (OrderItem.affiliateSponsorEnabled=true ⇒ sponsor entry created);
# the live setting only governs NEW checkouts.
B=http://localhost:3000
rm -f /tmp/jar-p3b /tmp/jar-p3v /tmp/jar-p3v2
CT='Content-Type: application/json'
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✔ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ✘ $1"; }
j(){ python3 -c "import json,sys
d=json.load(sys.stdin)
try: print(eval(sys.argv[1]))
except Exception: print('')" "$1" 2>/dev/null; }
req(){ local m=$1 u=$2 t=$3 d=$4 jar=$5
  local args=(-s -X "$m" "$B$u" -H "$CT" -H "X-SM-Client: web")
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "$d" ] && args+=(-d "$d")
  if [ -n "$jar" ]; then
    [ -f "$jar" ] && sed -i 's/\tTRUE\t/\tFALSE\t/' "$jar"
    args+=(-c "$jar" -b "$jar")
  fi
  curl "${args[@]}"
}
setj(){ bun -e "import { db } from './src/lib/db'; await db.setting.upsert({ where:{key:'$1'}, create:{key:'$1',valueJson:'$2',description:'p3-freeze-e2e'}, update:{valueJson:'$2'} });" > /dev/null; }

echo "════ P3-0. Ensure sponsor override ON at checkout ════"
setj affiliate.sponsor_enabled true
CUR=$(bun -e "import { db } from './src/lib/db'; const s=await db.setting.findUnique({where:{key:'affiliate.sponsor_enabled'}}); console.log(s?.valueJson ?? 'absent');")
[ "$CUR" = "true" ] && ok "affiliate.sponsor_enabled=true" || bad "setting: $CUR"

echo "════ P3-1. Fresh sponsor chain (A → B) + buyer with attribution ════"
STAMP=$(date +%H%M%S)
EA="p3-alpha-$STAMP@verify.nomofee.io"; EB="p3-beta-$STAMP@verify.nomofee.io"; EV="p3-buyer-$STAMP@verify.nomofee.io"
TA=$(req POST /api/auth/shopper/register "" "{\"fullName\":\"P3 Alpha\",\"email\":\"$EA\",\"password\":\"Verify123!\"}" "" | j "d['data']['token']")
AA=$(req POST /api/affiliate/activate "$TA" '{"termsAccepted":true,"displayName":"P3 Alpha"}')
CODE_A=$(echo "$AA" | j "d['data']['profile']['code']")
[ -n "$CODE_A" ] && ok "alpha activated" || bad "activate A: $AA"

TB=$(req POST /api/auth/shopper/register "" "{\"fullName\":\"P3 Beta\",\"email\":\"$EB\",\"password\":\"Verify123!\"}" "" | j "d['data']['token']")
req POST /api/affiliate/track-referral "$TB" "{\"code\":\"$CODE_A\"}" /tmp/jar-p3b > /dev/null
AB=$(req POST /api/affiliate/activate "$TB" '{"termsAccepted":true,"displayName":"P3 Beta"}' /tmp/jar-p3b)
CODE_B=$(echo "$AB" | j "d['data']['profile']['code']")
[ "$(echo "$AB" | j "d['data']['sponsor']['displayName']")" = "P3 Alpha" ] && ok "beta sponsored by alpha" || bad "sponsor: $AB"

TV=$(req POST /api/auth/shopper/register "" "{\"fullName\":\"P3 Buyer\",\"email\":\"$EV\",\"password\":\"Verify123!\"}" "" | j "d['data']['token']")
PROD=$(bun -e "
import { db } from './src/lib/db';
const ps = await db.product.findMany({ where:{ status:'active', priceMinor:{ gt: 2000 } }, include:{ store:{ select:{ slug:true }}, variants:{ where:{ stock:{ gt: 0 } }, take:1, select:{ id:true } } }, take: 60 });
const byStore = new Map();
for (const p of ps){ if(!p.variants[0]) continue; if(!byStore.has(p.store.slug)) byStore.set(p.store.slug, p); }
const a = [...byStore.values()][0];
console.log(JSON.stringify({ id:a.id, variant:a.variants[0].id, store:a.store.slug, price:a.priceMinor, storeId: a.store.slug }));")
P=$(echo "$PROD" | j "d['id']"); V=$(echo "$PROD" | j "d['variant']"); STORE=$(echo "$PROD" | j "d['store']")
# enroll the product for the store owner
SELLER=$(bun -e "
import { db } from './src/lib/db';
const s = await db.store.findUnique({ where:{ slug:'$STORE' }, select:{ seller:{ select:{ email:true } } } });
console.log(s.seller.email);")
TS=$(req POST /api/auth/login "" "{\"email\":\"$SELLER\",\"password\":\"Seller123!\",\"portal\":\"seller\"}" | j "d['data']['token']")
req PATCH "/api/store/affiliate" "$TS" '{"affiliateOptIn":true,"affiliateDefaultRateBps":1000}' > /dev/null
req PATCH "/api/store/affiliate/products/$P" "$TS" '{"affiliateEnabled":true,"affiliateRateBps":1000}' > /dev/null
ok "product enrolled @10% ($STORE)"

LB=$(req POST /api/affiliate/links "$TB" "{\"type\":\"product\",\"productId\":\"$P\",\"channel\":\"tiktok\"}" | j "d['data']['link']['code']")
[ -n "$LB" ] && ok "beta product link $LB" || bad "link: $LB"
req POST /api/affiliate/track "$TV" "{\"code\":\"$LB\"}" /tmp/jar-p3v > /dev/null
ok "buyer clicked beta's link (attribution touch)"

echo "════ P3-2. CHECKOUT with override ON (snapshot must freeze true) ════"
req POST /api/cart/items "$TV" "{\"variantId\":\"$V\",\"qty\":1}" /tmp/jar-p3v > /dev/null
IDEM="p3-freeze-$(date +%s)"
CO=$(curl -s -X POST "$B/api/checkout/create" -H "$CT" -H "Authorization: Bearer $TV" -H "X-SM-Client: web" -H "Idempotency-Key: $IDEM" -b /tmp/jar-p3v -c /tmp/jar-p3v -d '{"items":[{"variantId":"'"$V"'","qty":1}],"shippingAddress":{"line1":"9 Freeze Avenue","city":"Kuala Lumpur","state":"Selangor","postcode":"50000"},"provider":"fpx_toyyibpay"}')
PAYREF=$(echo "$CO" | j "d['data']['paymentRef']"); [ -z "$PAYREF" ] && PAYREF=$(echo "$CO" | j "d['data']['ref']")
[ -n "$PAYREF" ] && ok "checkout created (ref $PAYREF)" || { bad "checkout: $CO"; exit 1; }

ONUM=$(echo "$CO" | j "d['data']['orderNumber']")
SNAP=$(bun -e "
import { db } from './src/lib/db';
const o = await db.order.findUnique({ where:{ orderNumber:'$ONUM' }, include:{ items:true } });
const it = o.items[0];
console.log(JSON.stringify({ orderNumber:o.orderNumber, sponsorId: it.affiliateSponsorId!=null, directId: it.affiliateDirectId!=null, sponsorEnabled: it.affiliateSponsorEnabled, pool: it.affiliatePoolMinor }));")
echo "  snapshot: $SNAP"
SE=$(echo "$SNAP" | j "d['sponsorEnabled']")
SP=$(echo "$SNAP" | j "d['sponsorId']")
[ "$SE" = "True" ] && [ "$SP" = "True" ] && ok "OrderItem snapshot: sponsorId + affiliateSponsorEnabled=true frozen at checkout" || bad "snapshot not frozen: $SNAP"

echo "════ P3-3. ADMIN FLIPS sponsor override OFF (before payment) ════"
setj affiliate.sponsor_enabled false
CUR2=$(bun -e "import { db } from './src/lib/db'; const s=await db.setting.findUnique({where:{key:'affiliate.sponsor_enabled'}}); console.log(s?.valueJson);")
[ "$CUR2" = "false" ] && ok "affiliate.sponsor_enabled=false BEFORE payment" || bad "flip: $CUR2"

echo "════ P3-4. PAYMENT lands → commission must keep frozen 90/10 ════"
SIM=$(req POST "/api/checkout/payments/$PAYREF/simulate" "" '{"result":"succeeded"}')
[ "$(echo "$SIM" | j "d['data']['status']")" = "succeeded" ] && ok "payment succeeded" || bad "simulate: $SIM"

POSTED=$(bun -e "
import { db } from './src/lib/db';
const o = await db.order.findUnique({ where:{ orderNumber:'$ONUM' }, include:{ items:true } });
const c = await db.affiliateCommission.findUnique({ where:{ orderItemId: o.items[0].id }, include:{ entries:true } });
if (!c) { console.log('{}'); process.exit(0); }
const d = c.entries.find(e=>e.role==='direct'), s = c.entries.find(e=>e.role==='sponsor');
console.log(JSON.stringify({ pool:c.poolMinor, direct:d?.amountMinor, sponsor:s?.amountMinor ?? 0, sponsorEntry: !!s, statuses: c.entries.map(e=>e.status) }));")
echo "  posted: $POSTED"
DIR=$(echo "$POSTED" | j "d['direct']"); SPO=$(echo "$POSTED" | j "d['sponsor']"); POOL=$(echo "$POSTED" | j "d['pool']"); HAS=$(echo "$POSTED" | j "d['sponsorEntry']")
SPOEXP=$(python3 -c "print($POOL//10)")
[ "$HAS" = "True" ] && [ "$SPO" = "$SPOEXP" ] && ok "FROZEN 90/10 retained despite live setting=false (direct=$DIR sponsor=$SPO pool=$POOL, S=floor(P/10))" || bad "freeze violated: $POSTED"
SUM=$(python3 -c "print($DIR+$SPO)")
[ "$SUM" = "$POOL" ] && ok "D+S=P invariant ($DIR+$SPO=$POOL)" || bad "sum: $SUM != $POOL"

echo "════ P3-5. NEW checkout AFTER flip → snapshot false, D=P on payment ════"
# fresh buyer click on beta's same link (still valid), new checkout
TV2=$(req POST /api/auth/shopper/register "" "{\"fullName\":\"P3 Buyer2\",\"email\":\"p3-buyer2-$STAMP@verify.nomofee.io\",\"password\":\"Verify123!\"}" "" | j "d['data']['token']")
req POST /api/affiliate/track "$TV2" "{\"code\":\"$LB\"}" /tmp/jar-p3v2 > /dev/null
req POST /api/cart/items "$TV2" "{\"variantId\":\"$V\",\"qty\":1}" /tmp/jar-p3v2 > /dev/null
IDEM2="p3-post-$(date +%s)"
CO2=$(curl -s -X POST "$B/api/checkout/create" -H "$CT" -H "Authorization: Bearer $TV2" -H "X-SM-Client: web" -H "Idempotency-Key: $IDEM2" -b /tmp/jar-p3v2 -c /tmp/jar-p3v2 -d '{"items":[{"variantId":"'"$V"'","qty":1}],"shippingAddress":{"line1":"10 Post Avenue","city":"Kuala Lumpur","state":"Selangor","postcode":"50000"},"provider":"fpx_toyyibpay"}')
PAYREF2=$(echo "$CO2" | j "d['data']['paymentRef']"); [ -z "$PAYREF2" ] && PAYREF2=$(echo "$CO2" | j "d['data']['ref']")
[ -n "$PAYREF2" ] && ok "second checkout created" || bad "checkout2: $CO2"
ONUM2=$(echo "$CO2" | j "d['data']['orderNumber']")
SNAP2=$(bun -e "
import { db } from './src/lib/db';
const o = await db.order.findUnique({ where:{ orderNumber:'$ONUM2' }, include:{ items:true } });
if (!o) { console.log('{}'); process.exit(0); }
console.log(JSON.stringify({ orderNumber:o.orderNumber, sponsorEnabled: o.items[0].affiliateSponsorEnabled }));")
echo "  snapshot2: $SNAP2"
SE2=$(echo "$SNAP2" | j "d['sponsorEnabled']"); ONUM2=$(echo "$SNAP2" | j "d['orderNumber']")
[ "$SE2" = "False" ] && ok "new OrderItem snapshot: affiliateSponsorEnabled=false (policy affects new orders only)" || bad "snapshot2: $SNAP2"
SIM2=$(req POST "/api/checkout/payments/$PAYREF2/simulate" "" '{"result":"succeeded"}')
POSTED2=$(bun -e "
import { db } from './src/lib/db';
const o = await db.order.findUnique({ where:{ orderNumber:'$ONUM2' }, include:{ items:true } });
const c = await db.affiliateCommission.findUnique({ where:{ orderItemId: o.items[0].id }, include:{ entries:true } });
const d = c.entries.find(e=>e.role==='direct'), s = c.entries.find(e=>e.role==='sponsor');
console.log(JSON.stringify({ pool:c.poolMinor, direct:d?.amountMinor, sponsorEntry: !!s }));")
echo "  posted2: $POSTED2"
D2=$(echo "$POSTED2" | j "d['direct']"); P2=$(echo "$POSTED2" | j "d['pool']"); H2=$(echo "$POSTED2" | j "d['sponsorEntry']")
[ "$H2" = "False" ] && [ "$D2" = "$P2" ] && ok "post-flip payment: direct receives 100% (D=P=$D2, no sponsor entry)" || bad "post-flip: $POSTED2"

echo "════ P3-6. Restore sandbox setting ════"
setj affiliate.sponsor_enabled true
ok "affiliate.sponsor_enabled restored to true (sandbox demo posture)"
echo "P3-FREEZE-DONE P=$PASS F=$FAIL"
