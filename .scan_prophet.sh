#!/bin/bash
cd /home/ishidin/phoenix
grep -rIni --include='*.js' --include='*.sh' --include='*.json' --include='*.md' --include='*.ts' --include='*.tsx' --include='*.py' prophet . 2>/dev/null \
 | grep -vE '^\./(logs|memory|snapshots|arena/sandboxes|everos/\.venv|node_modules)/' \
 | grep -vE '\.bak' \
 | grep -v 'PROPHET_MENTIONS.md' \
 | awk -F: '{print $1}' | sort | uniq -c | sort -rn
echo "---TOTAL LINES---"
grep -rIni --include='*.js' --include='*.sh' --include='*.json' --include='*.md' --include='*.ts' --include='*.tsx' --include='*.py' prophet . 2>/dev/null \
 | grep -vE '^\./(logs|memory|snapshots|arena/sandboxes|everos/\.venv|node_modules)/' \
 | grep -vE '\.bak' \
 | grep -v 'PROPHET_MENTIONS.md' \
 | wc -l
echo "---FILES---"
grep -rIli --include='*.js' --include='*.sh' --include='*.json' --include='*.md' --include='*.ts' --include='*.tsx' --include='*.py' prophet . 2>/dev/null \
 | grep -vE '^\./(logs|memory|snapshots|arena/sandboxes|everos/\.venv|node_modules)/' \
 | grep -vE '\.bak' \
 | grep -v 'PROPHET_MENTIONS.md' \
 | wc -l
