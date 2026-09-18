#!/bin/bash
# phoenix_tree.sh [path] [depth]
# Использование: bash scripts/phoenix_tree.sh . 2
cd ~/phoenix
DIR="${1:-.}"
DEPTH="${2:-2}"
find "$DIR" -maxdepth "$DEPTH" -type d \
  -not -path "*/node_modules*" \
  -not -path "*/.git*" \
  -not -path "*/arena*" \
  -not -path "*/corpus*" \
  2>/dev/null | sort
