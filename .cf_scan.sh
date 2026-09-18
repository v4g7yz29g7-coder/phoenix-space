#!/bin/bash
cd /home/ishidin/phoenix || exit 1
OUT=/home/ishidin/phoenix/.cf_scan_out.txt
: > "$OUT"
find . \
  \( -path ./node_modules -o -path ./.git -o -path ./.aider.tags.cache.v4 \) -prune -o \
  -type f -size -3M -print 2>/dev/null \
  | grep -v -e '\.req_tmp' -e '\.exec_tmp' -e '\.cf_scan' -e '\.tmp_cf' \
  > /tmp/cf_list.txt
while IFS= read -r f; do
  if grep -Iilq cloudflare "$f" 2>/dev/null; then
    echo "FILE: $f" >> "$OUT"
    grep -Iin cloudflare "$f" 2>/dev/null >> "$OUT" | sed 's/^/    /'
  fi
done < /tmp/cf_list.txt
echo "SCANNED: $(wc -l < /tmp/cf_list.txt)" >> "$OUT"
echo "FILES_WITH_MATCH: $(grep -c '^FILE:' "$OUT")" >> "$OUT"
echo "DONE"
