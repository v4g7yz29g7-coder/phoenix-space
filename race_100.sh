#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/race_100.log"
> "$LOG"
echo "=== RACE 100 (4 boxes: agent_1,3,7,8): $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

for i in $(seq 1 100); do
  TASK=$(python3 -c "
import json, random
with open('tasks_pool.json') as f:
    d = json.load(f)
print(random.choice(d['read_only']))
")

  echo "" | tee -a "$LOG"
  echo "🏁 RACE #$i/100: $TASK" | tee -a "$LOG"

  # Training mode — все 4 бокса бегут
  EARLY_STOP=false RACE_BOXES="agent_1,agent_3,agent_7,agent_8" RACE_TASK="$TASK" \
    timeout 600 node race.js 2>&1 | tee -a "$LOG"

  sleep 5
done

echo "" | tee -a "$LOG"
echo "=== DONE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

# Prophet анализ
timeout 300 curl -s -X POST http://localhost:3001/agent/evolve \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)\",\"goal\":\"Проанализировать 100 гонок с 4 агентами (включая agent_8)\",\"dryRun\":true}" \
  >> "$LOG" 2>&1

# Обновляем champion tracker
node -e "
const ct = require('./champion_tracker');
const champ = ct.getChampion();
console.log('🏆 CHAMPION: ' + JSON.stringify(champ));
" >> "$LOG" 2>&1
