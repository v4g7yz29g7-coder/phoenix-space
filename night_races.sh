#!/bin/bash
cd /home/ishidin/phoenix

TASKS=(
  "Прочитай KNOWLEDGE.md и перечисли цели по номерам. Ничего не меняй."
  "Посчитай строки в agent_responses.js. Ничего не меняй."
  "Покажи последние 5 коммитов через git log. Ничего не меняй."
)

LOG="logs/night_races.log"
mkdir -p logs

echo "=== Упрощённый ночной цикл: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

for i in "${!TASKS[@]}"; do
  TASK="${TASKS[$i]}"
  echo "" | tee -a "$LOG"
  echo "🌙 Гонка $((i+1))/3: $TASK" | tee -a "$LOG"
  echo "---" | tee -a "$LOG"

  RACE_BOXES="agent_1,agent_3,agent_7" \
  RACE_TASK="$TASK" \
  timeout 900 node race.js 2>&1 | tee -a "$LOG"

  echo "" | tee -a "$LOG"
  echo "Пауза 30 сек..." | tee -a "$LOG"
  sleep 30
done

echo "" | tee -a "$LOG"
echo "=== Цикл завершён: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
