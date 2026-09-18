#!/bin/bash
# exponential.sh — Экспоненциальный автономный цикл AI-1

cd ~/phoenix

echo "🔥 AI-1: ЭКСПОНЕНЦИАЛЬНЫЙ РЕЖИМ"
echo ""

# 1. Убить старое
pkill -f arena_worker 2>/dev/null
pkill -f oracle_loop 2>/dev/null
pkill -f arena_coordinator 2>/dev/null
sleep 2

# 2. Запустить Coordinator
nohup node arena_coordinator.js --loop > /tmp/coordinator.log 2>&1 &
echo "✅ Coordinator PID: $!"
sleep 1

# 3. Запустить Oracle Loop
nohup node oracle_loop.js > /tmp/oracle.log 2>&1 &
echo "✅ Oracle PID: $!"
sleep 1

# 4. Запустить Worker
nohup node arena_worker.js --loop > /tmp/worker.log 2>&1 &
echo "✅ Worker PID: $!"
sleep 2

echo ""
echo "🔥 Все три процесса запущены:"
echo "   - Coordinator: следит за roadmap"
echo "   - Oracle: даёт подсказки по stage"
echo "   - Worker: выполняет задачи + retry"
echo ""
echo "📊 Мониторинг:"
echo "   tail -f /tmp/worker.log"
echo "   tail -f /tmp/oracle.log"
echo ""
echo "🌐 Панели:"
echo "   https://aeonlabs.ru/tasks"
echo "   https://aeonlabs.ru/control"
echo "   https://aeonlabs.ru/3d/"
