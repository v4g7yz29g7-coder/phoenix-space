# TODO Audit — только `agent_*.js` в корне проекта

Date: session by agent_6 (Documenter)
Scope: файлы `agent_*.js` в **корне** `/home/ishidin/phoenix` (28 файлов).
Out of scope: `node_modules/`, подпапки (`boxes/`, `skills/`, `skills_hub/` и т.д.).
Method: read-only `ls agent_*.js` + `grep -n -I -- "TODO" agent_*.js`.
Result: **25 вхождений `TODO` в 5 файлах**.

## Список: файл:строка

```
agent_9.js:98
agent_9.js:108
agent_9.js:118
agent_11.js:73
agent_11.js:84
agent_11.js:97
agent_11.js:108
agent_11.js:117
agent_11.js:129
agent_12.js:36
agent_12.js:45
agent_12.js:56
agent_12.js:66
agent_12.js:76
agent_13.js:89
agent_13.js:121
agent_13.js:136
agent_13.js:145
agent_13.js:154
agent_13.js:165
agent_13.js:218
agent_13.js:358
agent_13.js:402
agent_15.js:340
agent_15.js:351
```

## Агрегация

| File | TODO count |
|------|-----------|
| agent_9.js  | 3 |
| agent_11.js | 6 |
| agent_12.js | 5 |
| agent_13.js | 9 |
| agent_15.js | 2 |
| **Итого** | **25** |

## Замечания верификации

- Все совпадения имеют вид `  /* TODO */` — это заглушки-маркеры, а не текстовые TODO с описанием.
- Регистронезависимый поиск `-i todo` даёт 26 совпадений; лишнее — `agent_15.js:72`,
  где `'todo'` является испанским служебным словом в массиве стоп-слов (`es: [...]`).
  Это **не** TODO-маркер и в итоговый список не включено.
- Файлы без TODO в корне (23 из 28): agent_8, agent_10, agent_14, agent_16..agent_25,
  agent_architect, agent_box, agent_commentator, agent_critic, agent_loop_v3,
  agent_pilot, agent_prophet, agent_purpose, agent_responses, agent_tools.
- Изменений в коде нет — задача read-only.
