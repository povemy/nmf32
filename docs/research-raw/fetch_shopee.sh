#!/bin/bash
# $1 = api name (e.g. v2.product.get_item_base_info), $2 = module (optional)
MOD="${2:-}"
URL="https://open.shopee.com/documents/v2/$1?module=$MOD&type=1"
[ -z "$MOD" ] && URL="https://open.shopee.com/documents/v2/$1?type=1"
agent-browser open "$URL" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
agent-browser wait 3500 >/dev/null 2>&1
agent-browser eval "document.body.innerText" > "sp-$1.raw" 2>/dev/null
python3 - "$1" <<'PYEOF'
import json, sys
name = sys.argv[1]
raw = open(f'sp-{name}.raw', encoding='utf-8').read().strip()
try: text = json.loads(raw)
except Exception: text = raw
open(f'sp-{name}.txt', 'w', encoding='utf-8').write(text)
print(name, 'chars:', len(text))
PYEOF
