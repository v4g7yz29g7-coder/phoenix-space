#!/bin/bash
# Скрипт резервного копирования базы данных Aeon Agents
BACKUP_DIR="/home/ishidin/backups"
DB_FILE="/home/ishidin/phoenix/gardener.db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/gardener_$TIMESTAMP.db"

if [ -f "$DB_FILE" ]; then
    cp "$DB_FILE" "$BACKUP_FILE"
    echo "Бэкап создан: $BACKUP_FILE"
    # Оставляем только последние 7 бэкапов
    ls -t $BACKUP_DIR/gardener_*.db | tail -n +8 | xargs -r rm
else
    echo "Файл базы данных не найден: $DB_FILE"
fi
