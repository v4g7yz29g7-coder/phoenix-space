#!/bin/bash
cd /home/ishidin/phoenix

TASKS=(
  "Найди все файлы в корне проекта, содержащие слово 'arena'. Ничего не меняй."
  "Посчитай количество строк в dashboard_server.js. Ничего не меняй."
  "Прочитай WHITEPAPER и скажи, сколько разделов. Ничего не меняй."
  "Покажи список всех .md файлов в skills/. Ничего не меняй."
  "Найди все упоминания 'Prophet' в проекте. Верни файлы и строки."
)

LOG="logs/quick_races.log"
echo "=== Quick Races: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

for i in "${!TASKS[@]}"; do
  echo "" | tee -a "$LOG"
  echo "🏁 Race $((i+1))/5: ${TASKS[$i]}" | tee -a "$LOG"
  RACE_BOXES="agent_1,agent_3,agent_7" RACE_TASK="${TASKS[$i]}" timeout 600 node race.js 2>&1 | tee -a "$LOG"
  sleep 10
done

echo "" | tee -a "$LOG"
echo "=== Done ===" | tee -a "$LOG"
