#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/race_12apostles.log"
> "$LOG"
echo "=== 12 APOSTLES RACE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

ALL_BOXES="agent_1,agent_2,agent_3,agent_4,agent_5,agent_6,agent_7,agent_8,agent_9,agent_10,agent_11,agent_12"

for i in $(seq 1 50); do
  TASK=$(python3 -c "
import json, random
with open('tasks_pool.json') as f:
    d = json.load(f)
print(random.choice(d['read_only']))
")

  echo "" | tee -a "$LOG"
  echo "🏁 APOSTLE RACE #$i/50: $TASK" | tee -a "$LOG"

  # Training mode — все 12 бегут
  EARLY_STOP=false RACE_BOXES="$ALL_BOXES" RACE_TASK="$TASK" \
    timeout 1200 node race.js 2>&1 | tee -a "$LOG"

  sleep 10
done

echo "" | tee -a "$LOG"
echo "=== DONE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

# Prophet анализ
timeout 600 curl -s -X POST http://localhost:3001/agent/evolve \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)\",\"goal\":\"Проанализировать 50 гонок с 12 апостолами\",\"dryRun\":true}" \
  >> "$LOG" 2>&1

# Champion
node -e "
const ct = require('./champion_tracker');
const champ = ct.getChampion();
console.log('🏆 CHAMPION after 12-apostle races: ' + JSON.stringify(champ));
" >> "$LOG" 2>&1
