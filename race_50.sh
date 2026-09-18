#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/race_50.log"
echo "=== RACE 50 STARTED: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

for i in $(seq 1 50); do
  TASK=$(python3 -c "
import json, random
with open('tasks_pool.json') as f:
    d = json.load(f)
print(random.choice(d['read_only']))
")

  echo "" | tee -a "$LOG"
  echo "🏁 RACE #$i/50: $TASK" | tee -a "$LOG"

  RACE_BOXES="agent_1,agent_3,agent_7" RACE_TASK="$TASK" timeout 300 node race.js 2>&1 | tee -a "$LOG"

  sleep 5
done

echo "" | tee -a "$LOG"
echo "=== 50 RACES DONE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

timeout 300 curl -s -X POST http://localhost:3001/agent/evolve \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)\",\"goal\":\"Проанализировать 50 гонок\",\"dryRun\":true}" \
  >> "$LOG" 2>&1
