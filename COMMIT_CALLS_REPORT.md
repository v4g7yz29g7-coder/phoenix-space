# Отчёт: все вызовы `commit(` в коде проекта

- Проект: `/home/ishidin/phoenix`
- Дата сканирования: 2026-09-13 18:27 UTC
- Метод: точный `grep -rn "commit("` по исходникам + `search_code`
- Исключено: `.git/`, `node_modules/`, `.venv/`, `dist/`, `build/`, резервные копии `*.bak_*`, служебные скрипты сканирования (`.scan_commit*`, `.tmp_commit*`).
- Итог: **72 реальных вхождений** литерала `commit(` (включая 1 docstring в `session.py:31`).

## Сводка по каталогам

| Область | Кол-во |
|---|---|
| `everos/src/**` | 32 |
| `everos/tests/**` | 23 |
| `terminal-bench/**` | 11 |
| `arena_lab/**` | 3 |
| `agent_24.js`, `boxes/agent_24/agent_24.js` | 2 |
| `aeon_agents_server.js` | 1 |
| **Итого** | **72** |

## Полный список (файл:строка → вызов)

| # | Файл:строка | Вызов |
|---|---|---|
| 1 | `arena_lab/src/scene/VehicleFX.tsx:99` | `function commit(mesh: InstancedMesh, index: number): void {` |
| 2 | `arena_lab/src/scene/VehicleFX.tsx:182` | `commit(mesh, index.current);` |
| 3 | `arena_lab/src/scene/VehicleFX.tsx:272` | `commit(mesh, index.current);` |
| 4 | `aeon_agents_server.js:1378` | `const sys = 'You are Aeon. Tools: read(path), write(path,content), edit(path,old,new), exec(cmd), commit(message). Reply with ONE JSON object only: {"tool":"read","args":{"path":"..."},"reason":"..."} or {"tool":"done","answer":"final"}. After each result call next tool or return done.';` |
| 5 | `agent_24.js:40` | `await context.commit('Hybrid agent completed both passes');` |
| 6 | `terminal-bench/dashboard/db_init.py:41` | `conn.commit()` |
| 7 | `terminal-bench/dashboard/db_init.py:122` | `session.commit()` |
| 8 | `terminal-bench/terminal_bench/db.py:229` | `session.commit()` |
| 9 | `terminal-bench/terminal_bench/cli/tb/runs.py:642` | `session.commit()` |
| 10 | `terminal-bench/original-tasks/sql-injection-attack/services/master_service.py:61` | `conn.commit()` |
| 11 | `terminal-bench/original-tasks/sql-injection-attack/services/init_db.py:43` | `conn.commit()` |
| 12 | `terminal-bench/original-tasks/sanitize-git-repo/tests/test_outputs.py:65` | `commit = repo.commit("d6987af002b122fef54bc0be402062c76488a4d9")` |
| 13 | `terminal-bench/original-tasks/simple-sheets-put/api/app/main.py:93` | `db.commit()` |
| 14 | `terminal-bench/original-tasks/simple-sheets-put/api/app/main.py:156` | `db.commit()` |
| 15 | `terminal-bench/original-tasks/simple-sheets-put/api/app/main.py:221` | `db.commit()` |
| 16 | `terminal-bench/original-tasks/simple-sheets-put/api/app/main.py:317` | `db.commit()` |
| 17 | `boxes/agent_24/agent_24.js:40` | `await context.commit('Hybrid agent completed both passes');` |
| 18 | `everos/src/everos/core/persistence/sqlite/repository.py:89` | `await s.commit()` |
| 19 | `everos/src/everos/core/persistence/sqlite/repository.py:98` | `await s.commit()` |
| 20 | `everos/src/everos/core/persistence/sqlite/repository.py:145` | `await s.commit()` |
| 21 | `everos/src/everos/core/persistence/sqlite/repository.py:156` | `await s.commit()` |
| 22 | `everos/src/everos/core/persistence/sqlite/repository.py:165` | `await s.commit()` |
| 23 | `everos/src/everos/core/persistence/sqlite/session.py:31` | `then closed. Callers are responsible for calling ``await session.commit()``` |
| 24 | `everos/src/everos/core/persistence/sqlite/session.py:38` | `await session.commit()` |
| 25 | `everos/src/everos/infra/persistence/sqlite/repos/unprocessed_buffer.py:80` | `await s.commit()` |
| 26 | `everos/src/everos/infra/persistence/sqlite/repos/knowledge.py:105` | `await s.commit()` |
| 27 | `everos/src/everos/infra/persistence/sqlite/repos/knowledge.py:216` | `await s.commit()` |
| 28 | `everos/src/everos/infra/persistence/sqlite/repos/knowledge.py:265` | `await s.commit()` |
| 29 | `everos/src/everos/infra/persistence/sqlite/repos/knowledge.py:274` | `await s.commit()` |
| 30 | `everos/src/everos/infra/persistence/sqlite/repos/knowledge.py:312` | `await s.commit()` |
| 31 | `everos/src/everos/infra/persistence/sqlite/repos/conversation_status.py:87` | `await s.commit()` |
| 32 | `everos/src/everos/infra/persistence/sqlite/repos/reflection_report.py:34` | `await s.commit()` |
| 33 | `everos/src/everos/infra/persistence/sqlite/repos/memcell.py:42` | `await s.commit()` |
| 34 | `everos/src/everos/infra/persistence/sqlite/repos/md_change_state.py:169` | `await s.commit()` |
| 35 | `everos/src/everos/infra/persistence/sqlite/repos/md_change_state.py:204` | `await s.commit()` |
| 36 | `everos/src/everos/infra/persistence/sqlite/repos/md_change_state.py:260` | `await s.commit()` |
| 37 | `everos/src/everos/infra/persistence/sqlite/repos/md_change_state.py:303` | `await s.commit()` |
| 38 | `everos/src/everos/infra/persistence/sqlite/repos/md_change_state.py:350` | `await s.commit()` |
| 39 | `everos/src/everos/infra/persistence/sqlite/repos/md_change_state.py:369` | `await s.commit()` |
| 40 | `everos/src/everos/infra/persistence/sqlite/repos/md_change_state.py:418` | `await s.commit()` |
| 41 | `everos/src/everos/infra/persistence/sqlite/repos/md_change_state.py:436` | `await s.commit()` |
| 42 | `everos/src/everos/infra/persistence/sqlite/repos/cluster.py:174` | `await s.commit()` |
| 43 | `everos/src/everos/infra/persistence/sqlite/repos/cluster.py:195` | `await s.commit()` |
| 44 | `everos/src/everos/infra/persistence/sqlite/repos/cluster.py:226` | `await s.commit()` |
| 45 | `everos/src/everos/infra/persistence/sqlite/repos/cluster.py:379` | `await s.commit()` |
| 46 | `everos/src/everos/infra/ome/_stores/idle.py:35` | `await conn.commit()` |
| 47 | `everos/src/everos/infra/ome/_stores/run_record.py:108` | `await conn.commit()` |
| 48 | `everos/src/everos/infra/ome/_stores/storage.py:95` | `await conn.commit()` |
| 49 | `everos/src/everos/infra/ome/_stores/storage.py:132` | `await conn.commit()` |
| 50 | `everos/tests/unit/test_memory/test_cascade/test_backfill_engine_isolation.py:90` | `await conn.commit()` |
| 51 | `everos/tests/unit/test_core/test_persistence/test_sqlite/test_orm_crud.py:63` | `await s.commit()` |
| 52 | `everos/tests/unit/test_core/test_persistence/test_sqlite/test_orm_crud.py:86` | `await s.commit()` |
| 53 | `everos/tests/unit/test_core/test_persistence/test_sqlite/test_orm_crud.py:104` | `await s.commit()` |
| 54 | `everos/tests/unit/test_core/test_persistence/test_sqlite/test_orm_crud.py:117` | `await s.commit()` |
| 55 | `everos/tests/unit/test_core/test_persistence/test_sqlite/test_session.py:44` | `await s.commit()` |
| 56 | `everos/tests/unit/test_benchmark_last_seventeen.py:191` | `conn.commit()` |
| 57 | `everos/tests/unit/test_benchmark_harness_own.py:164` | `conn.commit()` |
| 58 | `everos/tests/unit/test_benchmark_harness_own.py:446` | `conn.commit()` |
| 59 | `everos/tests/unit/test_component/test_utils/test_datetime.py:729` | `await session.commit()` |
| 60 | `everos/tests/unit/test_component/test_utils/test_datetime.py:865` | `await session.commit()` |
| 61 | `everos/tests/unit/test_component/test_utils/test_datetime.py:978` | `await s.commit()` |
| 62 | `everos/tests/unit/test_component/test_utils/test_datetime.py:1017` | `await s.commit()` |
| 63 | `everos/tests/unit/test_component/test_utils/test_datetime.py:1058` | `await s.commit()` |
| 64 | `everos/tests/unit/test_component/test_utils/test_datetime.py:1066` | `await s.commit()` |
| 65 | `everos/tests/unit/test_component/test_utils/test_datetime.py:1102` | `await s.commit()` |
| 66 | `everos/tests/unit/test_component/test_utils/test_datetime.py:1154` | `await s.commit()` |
| 67 | `everos/tests/unit/test_component/test_utils/test_datetime.py:1194` | `await s.commit()` |
| 68 | `everos/tests/unit/test_component/test_utils/test_datetime.py:1246` | `await s.commit()` |
| 69 | `everos/tests/unit/test_component/test_utils/test_datetime.py:1311` | `await s.commit()` |
| 70 | `everos/tests/unit/test_infra/test_ome/test_crash_recovery.py:39` | `await conn.commit()` |
| 71 | `everos/tests/unit/test_infra/test_ome/test_crash_recovery.py:133` | `await conn.commit()` |
| 72 | `everos/tests/unit/test_infra/test_ome/test_storage_migration.py:45` | `await conn.commit()` |

## Примечания

- В `arena_lab/src/scene/VehicleFX.tsx:99` `commit(...)` — это определение локальной функции, а не вызов БД/git.
- В `everos/src/everos/core/persistence/sqlite/session.py:31` — docstring, не вызов.
- В `aeon_agents_server.js:1378` `commit(message)` находится внутри текстовой строки-инструкции (промпт), не вызов.
- В `boxes/**` буквального вызова git-коммита нет — там функция `gitCommit(message)` с заглавной `C`.
- В `terminal-bench/original-tasks/sanitize-git-repo/tests/test_outputs.py:65` используется `repo.commit(<hash>)` (pygit2/dulwich API).
