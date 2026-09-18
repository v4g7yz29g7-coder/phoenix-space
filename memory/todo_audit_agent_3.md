# TODO/FIXME/HACK/XXX audit — Phoenix repo

Date: 2026-09-13 · Agent: agent_3 · Method: `search_code TODO` +
authoritative `grep -rnI -E '\b(TODO|FIXME|XXX|HACK)\b'` over the live tree
and `git grep -nI` over tracked files. node_modules / `.git` / `logs` / `memory`
/ `skills(_hub)` / `everos/.venv` / `terminal-bench` / `arena/sandboxes` /
`arena/results` / `*.bak_*` / `.exec_tmp.txt` / `package-lock.json` filtered out.

> Re-verified. Current live count: **25 `/* TODO */` stubs in 5 root agents**
> + **31 in `boxes/` mirrors**. `agent_18.js` is **CLOSED** (`grep -c TODO` = 0)
> and `race_engineer.js` is **CLOSED** (0).
>
> Last re-verification: 2026-09-13 @ HEAD `314d8e4` — counts unchanged
> (root `grep -rhoE '/\* TODO \*/' agent_*.js | wc -l` = **25**;
> `boxes/*/agent_*.js` = **31**; no `FIXME`/`HACK`/`XXX` in project JS).
> `agent_18.js` = 0, `race_engineer.js` = 0 (both CLOSED).
> `everos/src` still holds 3 Python TODOs (vendor submodule — do not touch).

## 1. Real TODOs in project-owned code

All matches are `/* TODO */` function bodies → **not implemented**.

### Root agents — 25 stubs in 5 files
| File | Lines | Count |
|------|-------|------:|
| `agent_9.js`  | 98, 108, 118 | 3 |
| `agent_11.js` | 73, 84, 97, 108, 117, 129 | 6 |
| `agent_12.js` | 36, 45, 56, 66, 76 | 5 |
| `agent_13.js` | 89, 121, 136, 145, 154, 165, 218, 358, 402 | 9 |
| `agent_15.js` | 340, 351 | 2 |
| **Total** | | **25** |

### `boxes/` mirrors — 31 stubs in 5 files
| File | Lines | Count |
|------|-------|------:|
| `boxes/agent_9/agent_9.js`   | 98, 108, 118 | 3 |
| `boxes/agent_11/agent_11.js` | 73, 84, 97, 108, 117, 129 | 6 |
| `boxes/agent_12/agent_12.js` | 36, 45, 56, 66, 76 | 5 |
| `boxes/agent_13/agent_13.js` | 89, 103, 113, 128, 137, 146, 157, 170, 178, 187, 201, 210, 219, 227, 243 | 15 |
| `boxes/agent_15/agent_15.js` | 340, 351 | 2 |
| **Total** | | **31** |

Notes:
- `boxes/agent_9|11|12|15` are identical to their root counterparts (same lines).
- `boxes/agent_13/agent_13.js` is an **older, diverged revision** (15 stubs vs 9
  in root). Root and box must be reconciled, not just mirrored.
- `boxes/agent_18/` contains only a `skills/` dir — there is **no** `agent_18.js`
  mirror (root `agent_18.js` is clean anyway).

## 2. TODOs in vendored / third-party code (do not touch)
`everos/src` (separate submodule):
- `everos/src/everos/infra/ome/_dispatch/_state.py:10` — `TODO: sys._getframe walk ...`
- `everos/src/everos/memory/extract/pipeline/user_memory.py:133` — `TODO: catch a typed ExtractionError`
- `everos/src/everos/memory/strategies/extract_user_profile.py:256` — `TODO(profile-counter)` LanceDB race (PR #361 M4)

Also excluded as vendor/generated/fixtures:
- `skills_hub/**` (~700+ vendored skills, template code with `# TODO`)
- `everos/tests/fixtures/**`, `everos/data/team_chat_*.json`
- `arena/sandboxes/**/tasks_pool.json`, `arena/results/*.json`
- `*.bak_*` snapshots (old `/* TODO */` bodies, not live code)
- `package-lock.json` / lockfiles — `XXX` inside base64 integrity hashes (false positives)

## 3. False positives (word TODO in prose / task text)
`day_races.sh:13`, `night_master.sh:17`, `tournament.js:20`,
`tournament_v2.js:19`, `tasks_pool.json:11` — the race task text itself.
`skills/skill_decompose_codegen.md:24` (and `boxes/agent_1[6-9]/skills/...`,
`arena/sandboxes/*/skills/...`) — documents `/* TODO */` as a stub pattern.
`memory/*` — prior audit reports and journals. `logs/*` — runtime logs.

## 4. Previously reported, now CLOSED
- `race_engineer.js` — `buildRagSection` / `buildPromptParts` / `buildPrompt`
  implemented; `grep -c TODO` = 0.
- `agent_18.js` — 14 stubs implemented; `grep -c TODO` = 0.

## Actionables
1. Implement 3 stubs in `agent_9.js` + mirror to `boxes/agent_9/`.
2. Implement 6 stubs in `agent_11.js` + mirror to `boxes/agent_11/`.
3. Implement 5 stubs in `agent_12.js` + mirror to `boxes/agent_12/`.
4. Implement 9 stubs in `agent_13.js`; reconcile diverged `boxes/agent_13/` (15).
5. Implement 2 stubs in `agent_15.js` + mirror to `boxes/agent_15/`.
6. Leave vendor / submodule / skills_hub / `.bak_*` / task-text TODOs alone.
