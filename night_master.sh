#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/night_master.log"
> "$LOG"
echo "=== NIGHT MASTER: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

TASKS=(
  "Прочитай README.md и перечисли разделы. Ничего не меняй."
  "Найди все упоминания EverOS в проекте. Ничего не меняй."
  "Посчитай количество .md файлов в skills/. Ничего не меняй."
  "Покажи размер папки boxes/agent_3 через du. Ничего не меняй."
  "Прочитай agent_manifest.json и перечисли ключи верхнего уровня."
  "Найди в проекте все вызовы exec( через search_code."
  "Покажи последние 3 коммита через git log."
  "Посчитай строки в skills_loader.js. Ничего не меняй."
  "Найди все TODO в коде через search_code."
  "Покажи список файлов в memory/races/."
  "Прочитай agent_tools.js и перечисли экспортируемые функции."
  "Найди все файлы с расширением .json в корне проекта."
  "Посчитай количество строк в agent_responses.js."
  "Покажи содержимое .gitignore. Ничего не меняй."
  "Найди все упоминания DeepSeek в проекте."
  "Посчитай количество скиллов в skills_hub через find."
  "Прочитай MEMORY.md и перечисли разделы."
  "Покажи содержимое BOX_META.json первого бокса."
  "Найди все вызовы require в проекте."
  "Покажи список всех процессов pm2 через exec."
)

BOXES="agent_1,agent_3,agent_7"
RACE_COUNT=0

for i in "${!TASKS[@]}"; do
  TASK="${TASKS[$i]}"
  RACE_COUNT=$((RACE_COUNT + 1))
  echo "" | tee -a "$LOG"
  echo "RACE $RACE_COUNT/20: $TASK" | tee -a "$LOG"

  RACE_BOXES="$BOXES" RACE_TASK="$TASK" timeout 600 node race.js 2>&1 | tee -a "$LOG"

  if [ $((RACE_COUNT % 5)) -eq 0 ]; then
    echo "" | tee -a "$LOG"
    echo "P2P: winner shares skills..." | tee -a "$LOG"
    LAST_WINNER=$(ls -t memory/patterns/race_*.json | head -1 | xargs python3 -c "import sys,json; print(json.load(open(sys.argv[1]))['winner'])" 2>/dev/null)
    if [ -n "$LAST_WINNER" ]; then
      node p2p_share.js "$LAST_WINNER" "$BOXES" 2>&1 | tee -a "$LOG"
    fi
  fi

  sleep 15
done

echo "" | tee -a "$LOG"
echo "=== 20 RACES COMPLETE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "TEST decompose_codegen..." | tee -a "$LOG"
timeout 900 curl -s -X POST http://localhost:3001/agent/think-v3 \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)\",\"prompt\":\"Создай файл test_complex_module.js с тремя функциями: add(a,b), multiply(a,b), factorial(n). Следуй skill_decompose_codegen: inventory, skeleton, функции по одной, node --check после каждой, commit. Верни done.\"}" \
  >> "$LOG" 2>&1

echo "" | tee -a "$LOG"
echo "=== NIGHT MASTER COMPLETE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
