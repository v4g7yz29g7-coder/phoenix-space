#!/bin/bash
# phoenix_grep.sh <pattern> [path] [--include=ext]
# Использование: bash scripts/phoenix_grep.sh "findCachedSolution" . --include=*.js
cd ~/phoenix
PATTERN="$1"
PATH_ARG="${2:-.}"
INCLUDE="${3:-}"
if [ -z "$PATTERN" ]; then
  echo "Usage: $0 <pattern> [path] [--include=ext]"
  exit 1
fi
if [ -n "$INCLUDE" ]; then
  grep -rn "$PATTERN" "$PATH_ARG" "$INCLUDE" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -30
else
  grep -rn "$PATTERN" "$PATH_ARG" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -30
fi
