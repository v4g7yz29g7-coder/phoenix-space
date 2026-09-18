# TODO/FIXME/HACK/XXX Audit — Phoenix repo

Date: session by agent_6 (Documenter)
Method: `search_code` (limited to 50 matches) + full-repo `grep -rInE` with
exclusions (node_modules, .git, logs, .venv, site-packages, __pycache__,
skills_hub, generated_projects, package-lock.json).

## ✅ REAL TODOs in project-owned source

| # | File | Line | Text |
|---|------|------|------|
| 1 | race_engineer.js | 148 | `function buildRagSection(task) { /* TODO */ }` — stub |
| 2 | race_engineer.js | 149 | `function buildPromptParts(task, type) { /* TODO */ }` — stub |
| 3 | race_engineer.js | 150 | `function buildPrompt(task, type) { /* TODO */ }` — stub |
| 4 | everos/src/everos/infra/ome/_dispatch/_state.py | 10 | `TODO: sys._getframe walk for a Runner.run frame is leak-proof.` |
| 5 | everos/src/everos/memory/extract/pipeline/user_memory.py | 133 | `TODO: catch a typed ExtractionError once everalgo introduces one.` |
| 6 | everos/src/everos/memory/strategies/extract_user_profile.py | 256 | `TODO(profile-counter): reads LanceDB and therefore races the cascade daemon... (PR #361 M4)` |

Note: `race_engineer.js` exports only `buildPrompt`, and it is currently a stub —
the module is likely not wired in yet (no imports found). The `.bak_*` files
(`race_engineer.js.bak_1789195389948`, `.bak_1789195395952`) contain the same
stubs but are backups, not live code.

## 🗑️ False positives / noise (NOT code to fix)
- Task/label strings: `tasks_pool.json:11`, `day_races.sh:13`, `night_master.sh:17`
  ("Найди все TODO в коде") and corresponding `memory/races/*.json`, `memory/patterns/*.json`.
- `logs/*.log` — task labels echoed during races.
- `skills/skill_decompose_codegen.md:24` — documentation *example* of a stub.
- `skills_hub/.../swebench-*.json` — benchmark dumps containing `# TODO` from seaborn patches.
- `.venv/**/site-packages/**` — vendor libs (IPython, PIL, pytest, alembic, fastapi, ...).
- `everos/.git/hooks/*.sample` — git sample hooks.
- `everos/data/team_chat_{en,zh}.json` — chat content mentioning the word TODO.
- `everos/tests/fixtures/...` — captured agent trajectories containing TODO text.
- `generated_projects/**/package-lock.json` — `XXX` inside base64 integrity hashes (not markers).

## Summary
6 genuine TODO markers: 3 JS stubs in `race_engineer.js`, 3 Python notes in
`everos/src/`. Everything else is vendored, generated, logs, or task text.
