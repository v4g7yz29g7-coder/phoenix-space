#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/race_12_test.log"
> "$LOG"
echo "=== 12 APOSTLES TEST (3 races): $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

ALL_BOXES="agent_1,agent_2,agent_3,agent_4,agent_5,agent_6,agent_7,agent_8,agent_9,agent_10,agent_11,agent_12"

TASKS=(
  "Прочитай README.md и перечисли разделы. Ничего не меняй."
  "Посчитай количество .md файлов в skills/. Ничего не меняй."
  "Покажи последние 3 коммита через git log."
)

for i in "${!TASKS[@]}"; do
  TASK="${TASKS[$i]}"
  echo "" | tee -a "$LOG"
  echo "🏁 APOSTLE RACE #$((i+1))/3: $TASK" | tee -a "$LOG"

  EARLY_STOP=false RACE_BOXES="$ALL_BOXES" RACE_TASK="$TASK" \
    timeout 1800 node race.js 2>&1 | tee -a "$LOG"

  sleep 10
done

echo "" | tee -a "$LOG"
echo "=== DONE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
