#!/bin/bash
cd /home/ishidin/phoenix

TASKS=(
  "Прочитай README.md и перечисли разделы. Ничего не меняй."
  "Найди все упоминания 'EverOS' в проекте. Ничего не меняй."
  "Посчитай количество .md файлов в skills/. Ничего не меняй."
  "Покажи размер папки boxes/agent_3 через du. Ничего не меняй."
  "Прочитай agent_manifest.json и перечисли ключи верхнего уровня."
  "Найди в проекте все вызовы 'exec(' через search_code."
  "Покажи последние 3 коммита через git log."
  "Посчитай строки в skills_loader.js. Ничего не меняй."
  "Найди все TODO в коде через search_code."
  "Покажи список файлов в memory/races/."
)

LOG="logs/day_races.log"
echo "=== Дневной цикл: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

for i in "${!TASKS[@]}"; do
  TASK="${TASKS[$i]}"
  echo "" | tee -a "$LOG"
  echo "🏁 Гонка $((i+1))/10: $TASK" | tee -a "$LOG"

  RACE_BOXES="agent_1,agent_3,agent_7" \
  RACE_TASK="$TASK" \
  timeout 600 node race.js 2>&1 | tee -a "$LOG"

  sleep 15
done

echo "" | tee -a "$LOG"
echo "=== Цикл завершён: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

# Prophet анализ
timeout 300 curl -s -X POST http://localhost:3001/agent/evolve \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)\",\"goal\":\"Проанализировать 10 дневных гонок и выявить лучшую стратегию\",\"dryRun\":true}" \
  >> "$LOG" 2>&1
