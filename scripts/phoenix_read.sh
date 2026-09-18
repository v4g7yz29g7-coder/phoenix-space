#!/bin/bash
# phoenix_read.sh <file> [lines_start] [lines_end]
# Использование: bash scripts/phoenix_read.sh race.js 1 100
cd ~/phoenix
FILE="$1"
if [ -z "$FILE" ]; then
  echo "Usage: $0 <file> [start_line] [end_line]"
  exit 1
fi
if [ ! -f "$FILE" ]; then
  echo "❌ Файл не найден: $FILE"
  exit 1
fi
START="${2:-1}"
END="${3:-}"
if [ -n "$END" ]; then
  sed -n "${START},${END}p" "$FILE"
else
  cat "$FILE"
fi
