#!/bin/bash
echo "🏎️ FORMULA I1 STATUS"
echo "════════════════"
ACTIVE=$(pgrep -f "race_director.js" | wc -l)
echo "Активных гонок: $ACTIVE"
if [ "$ACTIVE" -gt 0 ]; then
  ps -eo pid,etime,cmd | grep "race_director.js" | grep -v grep
  LATEST=$(ls -t logs/race_bg_*.log 2>/dev/null | head -1)
  [ -n "$LATEST" ] && { echo "📄 $LATEST"; tail -10 "$LATEST"; }
else
  echo "Гонок нет. Последние логи:"
  ls -t logs/race_bg_*.log 2>/dev/null | head -5
fi
