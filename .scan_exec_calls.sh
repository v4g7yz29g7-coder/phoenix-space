#!/bin/bash
# Scan all exec( calls in project, excluding noise
cd "$(dirname "$0")" || exit 1
OUT=/tmp/exec_all.txt
: > "$OUT"
PATTERN='exec('

# find relevant files only, skip heavy/noise dirs and huge tmp dumps
find . \
  -type d \( -name node_modules -o -name .git -o -name logs -o -name memory -o -name .aider.tags.cache.v4 -o -name .openhands \) -prune -o \
  -type f \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.jsx' -o -name '*.py' -o -name '*.sh' -o -name '*.md' -o -name '*.html' -o -name '*.json' \) -print 2>/dev/null \
  | grep -v '\.bak_' \
  | grep -v 'EXEC_CALLS_REPORT' \
  | grep -v 'COMMIT_CALLS_REPORT' \
  | while IFS= read -r f; do
      # skip gigantic files
      sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
      if [ "$sz" -gt 2000000 ]; then continue; fi
      grep -n -F "$PATTERN" "$f" 2>/dev/null | sed "s|^|$f:|"
    done > "$OUT"

echo "TOTAL: $(wc -l < "$OUT")"
