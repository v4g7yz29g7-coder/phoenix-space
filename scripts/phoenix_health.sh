#!/bin/bash
# phoenix_health.sh — диагностика AI-1 за 5 секунд
# Использование: bash scripts/phoenix_health.sh

cd ~/phoenix
echo "════════════════════════════════════════════════════"
echo "  🗼 PHOENIX HEALTH — $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════════════"
echo ""

echo "═══ 1. КОНВЕЙЕРЫ (PM2 + фоновые) ═══"
pm2 list 2>/dev/null | grep -E "aeon|ivashi|sentinel|online|stopped" | head -10
echo ""
echo "Фоновые node процессы (без PM2):"
ps aux | grep -E "[n]ight_evolution|[b]enchmark/loop|[a]rchitect_worker|[v]ps_bot" | awk '{printf "  %s  %s  %s\n", $2, $3, $11" "$12}' | head -5

echo ""
echo "═══ 2. D-STATE (I/O wait — должно быть 0) ═══"
D_COUNT=$(ps -eo stat | awk '$1 ~ /^D/ {n++} END {print n+0}')
if [ "$D_COUNT" -eq 0 ]; then
  echo "  ✅ 0 процессов в D-state"
else
  echo "  ⚠️  $D_COUNT процессов в D-state:"
  ps -eo pid,stat,etime,cmd | awk '$2 ~ /^D/ {print "    "$0}' | head -5
fi

echo ""
echo "═══ 3. LOAD AVERAGE ═══"
uptime | awk -F'load average:' '{print "  load:"$2}'

echo ""
echo "═══ 4. ДИСК + RAM ═══"
df -h / | tail -1 | awk '{print "  disk: "$3" / "$2" ("$5" used)"}'
free -h | grep Mem | awk '{print "  ram:  "$3" / "$2}'

echo ""
echo "═══ 5. ПУЛ ЗАДАЧ ═══"
if [ -f tasks_night_pool.json ]; then
  python3 -c "
import json
d = json.load(open('tasks_night_pool.json'))
tasks = d.get('tasks', [])
from collections import Counter
c = Counter(t.get('status') for t in tasks)
print(f'  всего: {len(tasks)}')
for k in ['completed', 'in_progress', 'pending', 'failed']:
    if k in c: print(f'  {k}: {c[k]}')
"
else
  echo "  нет tasks_night_pool.json"
fi

echo ""
echo "═══ 6. СВЕЖИЕ ГОНКИ (за час) ═══"
RACES=$(find memory/races -name "race_*.json" -mmin -60 2>/dev/null | wc -l)
echo "  гонок за час: $RACES"

echo ""
echo "═══ 7. FITNESS TOP-3 ═══"
if [ -f memory/fitness.json ]; then
  python3 -c "
import json
d = json.load(open('memory/fitness.json'))
agents = sorted(d['agents'].values(), key=lambda a: -a['fitness'])
for a in agents[:3]:
    print(f'  {a[\"box\"]:10} fitness={a[\"fitness\"]:6} runs={a[\"runs_total\"]:3} wins={a[\"wins_total\"]:3}')
"
else
  echo "  нет fitness.json"
fi

echo ""
echo "═══ 8. TELEGRAM BOT ═══"
if pm2 list 2>/dev/null | grep -q "ivashi.*online"; then
  echo "  ✅ ivashi_agent_bot online"
else
  echo "  ⚠️  ivashi_agent_bot не в PM2"
fi

echo ""
echo "════════════════════════════════════════════════════"
