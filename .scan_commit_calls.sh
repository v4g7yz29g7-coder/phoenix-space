#!/bin/bash
cd /home/ishidin/phoenix
OUT=/home/ishidin/phoenix/.commit_scan_out.txt
: > "$OUT"
echo "=== PER-FILE COUNTS ===" >> "$OUT"
grep -rn 'commit(' . 2>/dev/null \
  | grep -v '/.git/' \
  | grep -v 'node_modules' \
  | grep -v 'COMMIT_CALLS_REPORT' \
  | grep -v '.bak_' \
  | grep -v '.req_' \
  | grep -v '.exec_tmp' \
  | grep -v '.commit_scan' \
  | grep -v 'REQUIRE_CALLS' \
  | cut -d: -f1 | sort | uniq -c | sort -rn >> "$OUT"
echo "=== FULL LIST ===" >> "$OUT"
grep -rn 'commit(' . 2>/dev/null \
  | grep -v '/.git/' \
  | grep -v 'node_modules' \
  | grep -v 'COMMIT_CALLS_REPORT' \
  | grep -v '.bak_' \
  | grep -v '.req_' \
  | grep -v '.exec_tmp' \
  | grep -v '.commit_scan' \
  | grep -v 'REQUIRE_CALLS' >> "$OUT"
echo DONE
