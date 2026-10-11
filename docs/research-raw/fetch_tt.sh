#!/bin/bash
# $1 = slug, $2 = url
agent-browser open "$2" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
agent-browser wait 2500 >/dev/null 2>&1
echo "URL: $(agent-browser get url 2>/dev/null | tail -1)"
echo "TITLE: $(agent-browser get title 2>/dev/null | tail -1)"
agent-browser eval "document.body.innerText" > "$1.raw" 2>/dev/null
python3 - "$1" <<'PYEOF'
import json, sys
name = sys.argv[1]
raw = open(name + '.raw', encoding='utf-8').read().strip()
try:
    text = json.loads(raw)
except Exception:
    text = raw
open(name + '.txt', 'w', encoding='utf-8').write(text)
print(name, 'chars:', len(text))
PYEOF
