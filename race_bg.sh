#!/bin/bash
BRIEF="${1:-sprint2_circular.md}"
BOXES="${2:-agent_1,agent_4,agent_7}"
if [ ! -f "$BRIEF" ]; then echo "❌ Нет брифа: $BRIEF"; exit 1; fi
TAG="race_bg_$(date +%s)"
LOG="logs/${TAG}.log"
mkdir -p logs
echo "🏎️ FORMULA I1 BACKGROUND RACE"
echo "   Brief: $BRIEF"
echo "   Log:   $LOG"
nohup env RACE_BOXES="$BOXES" RACE_TASK="$(cat $BRIEF)" node race_director.js > "$LOG" 2>&1 &
PID=$!
echo "✅ PID: $PID"
echo "races — статус | rtail — следить | rkill — убить"
