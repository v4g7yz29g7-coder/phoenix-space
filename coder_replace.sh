#!/bin/bash
# Заменяем "Изумрудное Сердце" на "Феникс" в Phoenix-приложении
cd ~/phoenix_app
find . -type f \( -name "*.heex" -o -name "*.ex" -o -name "*.html" -o -name "*.eex" \) -exec sed -i 's/Изумрудное Сердце/Феникс/g; s/Изумрудное сердце/Феникс/g' {} +
echo "Замена выполнена"
