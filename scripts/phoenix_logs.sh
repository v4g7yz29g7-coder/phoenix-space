#!/bin/bash
# phoenix_logs.sh <module> [lines]
# Использование: bash scripts/phoenix_logs.sh benchmark 20
cd ~/phoenix
MODULE="$1"
LINES="${2:-20}"
case "$MODULE" in
  benchmark|loop) tail -"$LINES" /tmp/benchmark_loop.log 2>/dev/null || tail -"$LINES" memory/benchmark_loop.log 2>/dev/null ;;
  night|evolution) tail -"$LINES" /tmp/night_evolution.log 2>/dev/null ;;
  architect) tail -"$LINES" /tmp/architect_worker.log 2>/dev/null ;;
  bot|telegram) tail -"$LINES" ~/.pm2/logs/ivashi-agent-bot-out.log 2>/dev/null ;;
  *) echo "Модули: benchmark, night, architect, bot" ;;
esac
