#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/arena_24_7.log"
STATE_FILE="memory/arena_state.json"

echo "=== ARENA 24/7 STARTED: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

# Инициализация состояния
if [ ! -f "$STATE_FILE" ]; then
  echo '{"race_count": 0, "last_prophet": 0, "wins": {}}' > "$STATE_FILE"
fi

BOXES="agent_1,agent_2,agent_3,agent_4,agent_5,agent_6,agent_7"

while true; do
  # Загружаем состояние
  RACE_NUM=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['race_count'])")
  RACE_NUM=$((RACE_NUM + 1))

  # Выбираем случайную задачу
  TASK=$(python3 -c "
import json, random
with open('tasks_pool.json') as f:
    d = json.load(f)
print(random.choice(d['read_only']))
")

  echo "" | tee -a "$LOG"
  echo "🏁 RACE #$RACE_NUM: $TASK" | tee -a "$LOG"
  echo "   Boxes: $BOXES" | tee -a "$LOG"

  # Запускаем гонку на всех 7 боксах
  RACE_BOXES="$BOXES" RACE_TASK="$TASK" timeout 900 node race.js 2>&1 | tee -a "$LOG"

  # Обновляем состояние
  python3 -c "
import json
with open('$STATE_FILE') as f:
    s = json.load(f)
s['race_count'] = $RACE_NUM
with open('$STATE_FILE', 'w') as f:
    json.dump(s, f)
"

  # P2P каждые 5 гонок
  if [ $((RACE_NUM % 5)) -eq 0 ]; then
    echo "" | tee -a "$LOG"
    echo "🔗 P2P: победитель делится скиллами..." | tee -a "$LOG"
    LAST_WINNER=$(ls -t memory/patterns/race_*.json | head -1 | xargs python3 -c "import sys,json; print(json.load(open(sys.argv[1]))['winner'])" 2>/dev/null)
    if [ -n "$LAST_WINNER" ]; then
      node p2p_share.js "$LAST_WINNER" "$BOXES" 2>&1 | tee -a "$LOG"
    fi
  fi

  # Prophet каждые 20 гонок
  if [ $((RACE_NUM % 20)) -eq 0 ]; then
    echo "" | tee -a "$LOG"
    echo "🧠 Prophet анализ (каждые 20 гонок)..." | tee -a "$LOG"
    timeout 300 curl -s -X POST http://localhost:3001/agent/evolve \
      -H "Content-Type: application/json" \
      -d "{\"password\":\"$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)\",\"goal\":\"Проанализировать последние 20 гонок и выявить паттерны\",\"dryRun\":true}" \
      >> "$LOG" 2>&1
  fi

  # Пауза между гонками (30 сек)
  sleep 30
done
