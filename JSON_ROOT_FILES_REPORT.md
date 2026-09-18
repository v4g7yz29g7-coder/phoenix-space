# .json файлы в корне проекта

**Корень проекта:** `/home/ishidin/phoenix`
**Дата сканирования:** определяется в момент запуска
**Метод:** `find . -maxdepth 1 -name '*.json' -type f`

## Найдено: 11 файлов

| # | Файл | Размер (байт) | Валидный JSON |
|---|------|--------------:|:-------------:|
| 1 | agent_manifest.json | 1 188 | ✅ |
| 2 | arena_board.json | 7 977 | ✅ |
| 3 | arena_research.json | 3 428 | ✅ |
| 4 | arena_roadmap.json | 12 350 | ✅ |
| 5 | oracle_hints.json | 1 717 | ✅ |
| 6 | package-lock.json | 182 542 | ✅ |
| 7 | package.json | 1 006 | ✅ |
| 8 | race_control.json | 3 822 | ✅ |
| 9 | race_control_structure.json | 4 738 | ✅ |
| 10 | skills_marketplace.json | 1 475 | ✅ |
| 11 | tasks_pool.json | 2 181 | ✅ |

**Суммарный размер:** ~220 424 байт

## Команды для воспроизведения

```bash
cd /home/ishidin/phoenix

# только имена
find . -maxdepth 1 -name '*.json' -type f | sort

# с размерами
find . -maxdepth 1 -name '*.json' -type f -printf '%s\t%p\n' | sort -n

# проверка валидности
for f in $(find . -maxdepth 1 -name '*.json' -type f); do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" \
    && echo "OK  $f" || echo "BAD $f"
done
```

## Примечания
- Учитывались только файлы **в корне** проекта (`-maxdepth 1`).
- `.json`-файлы в подкаталогах (`node_modules/`, `boxes/`, `skills_hub/` и т.д.) в отчёт не входят.
- Все 11 файлов успешно прошли проверку синтаксиса JSON.
