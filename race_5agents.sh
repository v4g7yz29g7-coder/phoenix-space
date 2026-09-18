#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/race_5agents.log"
> "$LOG"
echo "=== RACE 5-AGENTS (1,3,7,8,9): $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

for i in $(seq 1 50); do
  TASK=$(python3 -c "
import json, random
with open('tasks_pool.json') as f:
    d = json.load(f)
print(random.choice(d['read_only']))
")

  echo "" | tee -a "$LOG"
  echo "🏁 RACE #$i/50: $TASK" | tee -a "$LOG"

  EARLY_STOP=false RACE_BOXES="agent_1,agent_3,agent_7,agent_8,agent_9" RACE_TASK="$TASK" \
    timeout 600 node race.js 2>&1 | tee -a "$LOG"

  sleep 5
done

echo "" | tee -a "$LOG"
echo "=== DONE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

# Prophet
timeout 300 curl -s -X POST http://localhost:3001/agent/evolve \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)\",\"goal\":\"Проанализировать 50 гонок с 5 агентами (включая agent_8 и agent_9)\",\"dryRun\":true}" \
  >> "$LOG" 2>&1
