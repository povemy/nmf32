#!/bin/bash
# AFFILIATE SYSTEM E2E — stage 1: setup → affiliates → enrol → links → attribution → checkout → payment
B=http://localhost:3000
CT='Content-Type: application/json'
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✔ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ✘ $1"; }
j(){ python3 -c "import json,sys
d=json.load(sys.stdin)
try: print(eval(sys.argv[1]))
except Exception: print('')" "$1" 2>/dev/null; }
req(){ # method url token data jar
  local m=$1 u=$2 t=$3 d=$4 jar=$5
  local args=(-s -X "$m" "$B$u" -H "$CT" -H "X-SM-Client: web")
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "$d" ] && args+=(-d "$d")
  if [ -n "$jar" ]; then
    # curl refuses to SEND Secure cookies over http (browsers exempt localhost);
    # the jar-secure-flag flip is a test-harness workaround, not an app change.
    [ -f "$jar" ] && sed -i 's/\tTRUE\t/\tFALSE\t/' "$jar"
    args+=(-c "$jar" -b "$jar")
  fi
  curl "${args[@]}"
}

rm -f /tmp/jar-b /tmp/jar-v

echo "════ S2. Pick two products (distinct stores) ════"
PRODS=$(bun -e "
import { db } from './src/lib/db';
const ps = await db.product.findMany({ where:{ status:'active', priceMinor:{ gt: 2000 } }, include:{ store:{ select:{ slug:true }}, variants:{ where:{ stock:{ gt: 0 } }, take:1, select:{ id:true } } }, take: 60 });
const byStore = new Map();
for (const p of ps){ if(!p.variants[0]) continue; if(!byStore.has(p.store.slug)) byStore.set(p.store.slug, p); }
const [a,b] = [...byStore.values()].slice(0,2);
console.log(JSON.stringify({ p1:{id:a.id, variant:a.variants[0].id, store:a.store.slug, price:a.priceMinor}, p2:{id:b.id, variant:b.variants[0].id, store:b.store.slug, price:b.priceMinor} }));")
P1=$(echo "$PRODS" | j "d['p1']['id']"); V1=$(echo "$PRODS" | j "d['p1']['variant']"); S1=$(echo "$PRODS" | j "d['p1']['store']"); PR1=$(echo "$PRODS" | j "d['p1']['price']")
P2=$(echo "$PRODS" | j "d['p2']['id']"); V2=$(echo "$PRODS" | j "d['p2']['variant']"); S2=$(echo "$PRODS" | j "d['p2']['store']"); PR2=$(echo "$PRODS" | j "d['p2']['price']")
echo "  product1: $P1 ($S1, $PR1 sen) | product2: $P2 ($S2, $PR2 sen)"
[ -n "$P1" ] && [ -n "$P2" ] && [ "$S1" != "$S2" ] && ok "two products, distinct stores" || bad "product selection"

echo "════ A. Affiliate chain (cookie-based first-touch) ════"
STAMP=$(date +%H%M%S)
EA="aff-alpha-$STAMP@verify.nomofee.io"; EB="aff-beta-$STAMP@verify.nomofee.io"; EV="buyer-$STAMP@verify.nomofee.io"
TA=$(req POST /api/auth/shopper/register "" "{\"fullName\":\"Affiliate Alpha\",\"email\":\"$EA\",\"password\":\"Verify123!\"}" "" | j "d['data']['token']")
[ -n "$TA" ] && ok "shopper A registered" || bad "register A"
AA=$(req POST /api/affiliate/activate "$TA" '{"termsAccepted":true,"displayName":"Alpha Promotes"}')
CODE_A=$(echo "$AA" | j "d['data']['profile']['code']")
[ -n "$CODE_A" ] && ok "A activated (code $CODE_A, no sponsor)" || bad "activate A: $AA"

TB=$(req POST /api/auth/shopper/register "" "{\"fullName\":\"Affiliate Beta\",\"email\":\"$EB\",\"password\":\"Verify123!\"}" "" | j "d['data']['token']")
# B visits A's referral link WITH COOKIES (first touch) → activates
TR=$(req POST /api/affiliate/track-referral "$TB" "{\"code\":\"$CODE_A\",\"channel\":\"tiktok\"}" /tmp/jar-b)
[ "$(echo "$TR" | j "d['data']['invitedBy']")" = "Alpha Promotes" ] && ok "referral touch recorded" || bad "track-referral: $TR"
AB=$(req POST /api/affiliate/activate "$TB" '{"termsAccepted":true,"displayName":"Beta Shares"}' /tmp/jar-b)
CODE_B=$(echo "$AB" | j "d['data']['profile']['code']")
SP=$(echo "$AB" | j "d['data']['sponsor']['displayName']")
[ "$SP" = "Alpha Promotes" ] && ok "B activated WITH sponsor = Alpha Promotes (90/10 chain)" || bad "activate B: $AB"
RE=$(req POST /api/affiliate/activate "$TB" '{"termsAccepted":true}')
[ "$(echo "$RE" | j "d['error']['code']")" = "ALREADY_AFFILIATE" ] && ok "sponsor relationship locked (re-activate 409)" || bad "re-activate: $RE"

echo "════ S3. Sellers enrol (10% launch ceiling) ════"
enrol(){ local email=$1 pid=$2
  local t=$(req POST /api/auth/login "" "{\"email\":\"$email\",\"password\":\"Seller123!\",\"portal\":\"seller\"}" "" | j "d['data']['token']")
  req PATCH /api/store/affiliate "$t" '{"optIn":true,"defaultRateBps":1000}' > /dev/null
  local r=$(req PATCH "/api/store/affiliate/products/$pid" "$t" '{"enabled":true}')
  [ "$(echo "$r" | j "d['data']['effectiveRateBps']")" = "1000" ] && ok "$email enrolled $pid @10%" || bad "$email enrol($pid): $r"
}
enrol lumina@nomofee.io "$P1"
enrol byte@nomofee.io "$P2"

echo "════ L. Promo links ════"
LA=$(req POST /api/affiliate/links "$TA" "{\"type\":\"product\",\"productId\":\"$P1\",\"channel\":\"tiktok\",\"label\":\"vase promo\"}")
LINK_A=$(echo "$LA" | j "d['data']['link']['code']")
[ -n "$LINK_A" ] && ok "A product link $LINK_A" || bad "link A: $LA"
LB=$(req POST /api/affiliate/links "$TB" "{\"type\":\"product\",\"productId\":\"$P2\",\"channel\":\"whatsapp\"}")
LINK_B=$(echo "$LB" | j "d['data']['link']['code']")
[ -n "$LINK_B" ] && ok "B product link $LINK_B" || bad "link B: $LB"

echo "════ V. Buyer + per-product attribution ════"
TV=$(req POST /api/auth/shopper/register "" "{\"fullName\":\"Vera Buyer\",\"email\":\"$EV\",\"password\":\"Verify123!\"}" "" | j "d['data']['token']")
T1=$(req POST /api/affiliate/track "$TV" "{\"code\":\"$LINK_A\"}" /tmp/jar-v)
[ "$(echo "$T1" | j "d['data']['linkType']")" = "product" ] && ok "click A link → $(echo "$T1" | j "d['data']['target']['title']")" || bad "track A: $T1"
T2=$(req POST /api/affiliate/track "$TV" "{\"code\":\"$LINK_B\"}" /tmp/jar-v)
[ -n "$(echo "$T2" | j "d['data']['target']")" ] && ok "click B link → $(echo "$T2" | j "d['data']['target']['title']")" || bad "track B: $T2"

echo "════ C. One checkout, two stores, two affiliates ════"
req POST /api/cart/items "$TV" "{\"variantId\":\"$V1\",\"qty\":1}" /tmp/jar-v > /dev/null
req POST /api/cart/items "$TV" "{\"variantId\":\"$V2\",\"qty\":1}" /tmp/jar-v > /dev/null
IDEM="e2e-aff-$(date +%s)"
CO=$(curl -s -X POST "$B/api/checkout/create" -H "$CT" -H "Authorization: Bearer $TV" -H "X-SM-Client: web" -H "Idempotency-Key: $IDEM" -b /tmp/jar-v -c /tmp/jar-v -d '{"items":[{"variantId":"'"$V1"'","qty":1},{"variantId":"'"$V2"'","qty":1}],"shippingAddress":{"line1":"88 Verification Street","city":"Kuala Lumpur","state":"Selangor","postcode":"50000"},"provider":"fpx_toyyibpay"}')
PAYREF=$(echo "$CO" | j "d['data']['paymentRef']"); [ -z "$PAYREF" ] && PAYREF=$(echo "$CO" | j "d['data']['ref']")
[ -n "$PAYREF" ] && ok "checkout created (ref $PAYREF)" || { bad "checkout: $CO"; }
SIM=$(req POST "/api/checkout/payments/$PAYREF/simulate" "" '{"result":"succeeded"}')
[ "$(echo "$SIM" | j "d['data']['status']")" = "succeeded" ] && ok "payment succeeded" || bad "simulate: $SIM"
echo "$CO" > /tmp/aff-checkout.json; echo "$SIM" > /tmp/aff-pay.json
echo "STAGE1-DONE P=$PASS F=$FAIL"
