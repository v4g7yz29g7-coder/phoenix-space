# JSON files in project root

Project root: `/home/ishidin/phoenix`

| # | File | Size (bytes) | Valid JSON |
|---|------|-------------:|:----------:|
| 1 | agent_manifest.json | 1188 | ✅ |
| 2 | arena_board.json | 7977 | ✅ |
| 3 | arena_research.json | 3428 | ✅ |
| 4 | arena_roadmap.json | 12460 | ✅ |
| 5 | oracle_hints.json | 1717 | ✅ |
| 6 | package-lock.json | 182542 | ✅ |
| 7 | package.json | 1006 | ✅ |
| 8 | race_control.json | 3822 | ✅ |
| 9 | race_control_structure.json | 4738 | ✅ |
| 10 | skills_marketplace.json | 1475 | ✅ |
| 11 | tasks_pool.json | 2181 | ✅ |

**Total: 11 JSON files** (all syntactically valid).

Reproduce:
```bash
find . -maxdepth 1 -name "*.json" -type f | sort
```
