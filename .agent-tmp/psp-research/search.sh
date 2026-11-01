#!/bin/bash
# usage: search.sh "query" outfile
curl -sSL --max-time 20 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" "https://www.bing.com/search?q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1")" -o "$2"
python3 - <<PYEOF
import re,html as H
h=open("$2",encoding='utf-8',errors='ignore').read()
# extract result blocks: <li class="b_algo"> ... <h2><a href="url">title</a></h2> ... <p>snippet</p>
items=re.findall(r'<li class="b_algo".*?</li>', h, re.S)
for it in items[:8]:
    m=re.search(r'<h2><a href="([^"]+)"[^>]*>(.*?)</a></h2>', it, re.S)
    if not m: continue
    url,title=m.group(1),re.sub(r'<[^>]+>','',m.group(2))
    sn=re.search(r'<p[^>]*>(.*?)</p>', it, re.S)
    snippet=re.sub(r'<[^>]+>','',sn.group(1)) if sn else ''
    print('URL:', H.unescape(url))
    print('TITLE:', H.unescape(title))
    print('SNIP:', H.unescape(snippet)[:300])
    print('---')
PYEOF
