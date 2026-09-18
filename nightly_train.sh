#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/nightly_train.log"
echo "=== NIGHTLY TRAIN: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

# 100 гонок в training mode
RACE_COUNT=0
for i in $(seq 1 100); do
  RACE_COUNT=$((RACE_COUNT + 1))
  TASK=$(python3 -c "
import json, random
with open('tasks_pool.json') as f:
    d = json.load(f)
print(random.choice(d['read_only']))
")

  export EARLY_STOP=false
  export RACE_BOXES="agent_1,agent_3,agent_7"
  export RACE_TASK="$TASK"

  echo "" | tee -a "$LOG"
  echo "🏁 NIGHT RACE #$RACE_COUNT/100: $TASK" | tee -a "$LOG"
  timeout 600 node race.js 2>&1 | tee -a "$LOG"
  sleep 5
done

# Prophet анализ
echo "" | tee -a "$LOG"
echo "🧠 Prophet analysis..." | tee -a "$LOG"
timeout 300 curl -s -X POST http://localhost:3001/agent/evolve \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)\",\"goal\":\"Проанализировать 100 ночных гонок\",\"dryRun\":true}" \
  >> "$LOG" 2>&1

# Обновляем champions
echo "" | tee -a "$LOG"
node -e "
const ct = require('./champion_tracker');
const champ = ct.getChampion();
console.log('🏆 CHAMPION: ' + JSON.stringify(champ));
" | tee -a "$LOG"

echo "=== DONE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
