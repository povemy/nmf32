#!/bin/bash
# $1 = document slug
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
curl -sL -A "$UA" "https://partner.tiktokshop.com/api/v1/document/detail?document_id=$1&workspace_id=3&aid=359713&locale=en-US" -o "dtt-$1.json"
python3 - "$1" <<'PYEOF'
import json, sys
name = sys.argv[1]
try:
    d = json.load(open(f'dtt-{name}.json'))
except Exception as e:
    print(name, 'PARSE FAIL', e); raise SystemExit
data = d.get('data') or {}
title = data.get('title')
content = data.get('content') or ''
open(f'dtt-{name}.md', 'w', encoding='utf-8').write(f"# {title}\n\n{content}")
print(f'{name}: title={title!r} content_chars={len(content)} code={d.get("code")}')
PYEOF
