#!/bin/bash
cd /home/ishidin/phoenix
if [ -f /home/ishidin/agents/tasks.txt ]; then
  while IFS= read -r task; do
    [ -z "$task" ] && continue
    echo "=== $task ==="
    bash /home/ishidin/agents/agents/coder.sh "$task"
  done < /home/ishidin/agents/tasks.txt
else
  echo "Нет tasks.txt"
fi
