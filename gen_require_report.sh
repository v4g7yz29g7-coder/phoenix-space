#!/bin/bash
# gen_require_report.sh — inventory of all require(...) calls in the project.
# Scope  : *.js *.cjs *.mjs *.ts (module requires) + *.sol (Solidity assertions)
# Excludes: node_modules/, .git/, __pycache__/  and backups
#           (*.bak*, *.backup, *.broken_*, *.save, *.min.js)
# Usage  : ./gen_require_report.sh
#
# NOTE: exclusions are done by PATH (grep --exclude-dir / --exclude), NOT by
# filtering output lines. Filtering lines with `grep -v "/node_modules/"`
# used to drop legitimate calls such as:
#     require('/home/ishidin/phoenix/node_modules/axios')
# because the *content* of the line contained "/node_modules/".
cd "$(dirname "$0")" || exit 1

RAW=$(mktemp /tmp/req_scan.XXXXXX)
REP=./REQUIRE_CALLS_REPORT.txt
REPMD=./REQUIRE_CALLS_REPORT.md

grep -rn "require(" \
  --include="*.js" --include="*.cjs" --include="*.mjs" \
  --include="*.ts" --include="*.sol" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=__pycache__ \
  --exclude="*.bak*" --exclude="*.backup" --exclude="*.broken_*" \
  --exclude="*.save" --exclude="*.min.js" \
  . > "$RAW" 2>/dev/null

LINES=$(wc -l < "$RAW")
TOTAL=$(grep -o "require(" "$RAW" | wc -l)
FILES=$(cut -d: -f1 "$RAW" | sort -u | wc -l)
SOL=$(grep -cE "\.sol:" "$RAW")
JS=$(grep -vE "\.sol:" "$RAW" | grep -o "require(" | wc -l)
LOCAL=$(grep -oE "require\(['\"](\\.\\.?/|/)" "$RAW" | wc -l)
EXT=$((TOTAL - LOCAL - SOL))
MODS=$(grep -oE "require\(['\"][^'\"]+" "$RAW" | sed -E "s/^require\(['\"]//" | sort -u | wc -l)

{
echo "# Отчёт: все вызовы require(...) в проекте"
echo "# Дата: $(date -u +'%Y-%m-%d %H:%M UTC')"
echo "# Метод: grep -rn 'require(' --include=*.js/*.cjs/*.mjs/*.ts/*.sol"
echo "# Исключено (по пути): node_modules, .git, __pycache__, *.bak*, *.backup, *.broken_*, *.save, *.min.js"
echo
echo "## Сводка"
printf "#   Строк с require(...):      %s\n" "$LINES"
printf "#   Вхождений require(...):    %s\n" "$TOTAL"
printf "#   Файлов с require(...):     %s\n" "$FILES"
printf "#   JS/TS (module require):    %s\n" "$JS"
printf "#   Solidity require (assert): %s\n" "$SOL"
printf "#   Локальных (./ ../ /):      %s\n" "$LOCAL"
printf "#   Внешних (npm/core):        %s\n" "$EXT"
printf "#   Уникальных модулей:        %s\n" "$MODS"
echo
echo "## Разбивка по каталогам (вхождений)"
cut -d: -f1 "$RAW" | sed 's|^\./||' \
  | awk -F/ '{if(NF==1) print "(root)"; else print $1}' \
  | sort | uniq -c | sort -rn
echo
echo "## Топ подключаемых модулей"
grep -oE "require\(['\"][^'\"]+" "$RAW" \
  | sed -E "s/^require\(['\"]//" \
  | sort | uniq -c | sort -rn
echo
echo "## Динамические/особые require (аргумент не строковый литерал)"
grep -nE "require\([^'\")]" "$RAW" | grep -v "require()" | grep -vE "\.sol:"
echo
echo "## Solidity require (assert, не импорт)"
grep -nE "\.sol:.*require\(" "$RAW"
echo
echo "## Полный список (файл:строка: код)"
cat "$RAW"
} > "$REP"

{
echo "# Отчёт: все вызовы require(...) в проекте"
echo
echo "## Итоги"
printf -- "- Файлов с require: %s\n" "$FILES"
printf -- "- Строк с require(...): %s\n" "$LINES"
printf -- "- Вхождений require(...): %s\n" "$TOTAL"
printf -- "- Solidity require (assert): %s\n" "$SOL"
echo
echo "## Топ модулей"
grep -oE "require\(['\"][^'\"]+" "$RAW" \
  | sed -E "s/^require\(['\"]//" \
  | sort | uniq -c | sort -rn | awk '{print "- "$2" — "$1}'
echo
echo "## Топ файлов"
cut -d: -f1 "$RAW" | sort | uniq -c | sort -rn | awk '{print "- "$2" — "$1}'
echo
echo "## Полный список (файл:строка:код)"
cat "$RAW"
} > "$REPMD"

rm -f "$RAW"
echo "report written: $REP ($(wc -l < "$REP") lines)"
echo "report written: $REPMD ($(wc -l < "$REPMD") lines)"
echo "TOTAL=$TOTAL FILES=$FILES JS=$JS SOL=$SOL LOCAL=$LOCAL EXT=$EXT MODS=$MODS"
