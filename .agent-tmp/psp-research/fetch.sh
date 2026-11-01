#!/bin/bash
# usage: fetch.sh <name> <url>
D=/home/z/my-project/.agent-tmp/psp-research
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
curl -sSL --max-time 25 -A "$UA" -H "Accept-Language: en-US,en;q=0.9" "$2" -o "$D/$1.html" 2>"$D/$1.err"
code=$?
if [ $code -eq 0 ]; then
  pandoc -f html -t plain --wrap=none "$D/$1.html" > "$D/$1.txt" 2>/dev/null
  echo "OK $1 $(wc -c < "$D/$1.html") bytes -> $(wc -l < "$D/$1.txt") lines txt"
else
  echo "FAIL $1 curl exit $code: $(tail -c 120 "$D/$1.err")"
fi
