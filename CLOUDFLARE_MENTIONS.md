# Упоминания Cloudflare в проекте (/home/ishidin/phoenix)

Дата сканирования: 2026-09-13
Метод: `grep -rIn -i "cloudflare"` по репозиторию.

## Сводка
- Всего совпадений (без logs/node_modules/.git/.venv): **750**
- Файлов с совпадениями: **155**
- Значимых (код/конфиг/доки проекта, без истории гонок и артефактов сканов): **~60**

## 1. Рабочий код и конфиги (главное)

| Файл | Строка | Упоминание |
|------|--------|-----------|
| `cloudflare_tunnel.sh` | 2 | `exec cloudflared tunnel run aeon-arena` |
| `get_tunnel_url.sh` | 4 | извлекает `https://...trycloudflare.com` из `pm2 logs aeon_tunnel` |
| `.tunnel_url` | 1 | `https://andreas-using-halifax-produce.trycloudflare.com` |
| `ROADMAP.md` | 57 | постоянный URL `arena.aeonlabs.ru` через **Cloudflare Tunnel** |
| `MEMORY.md` | 7 | Telegram-бот обходит блокировки через **Cloudflare Worker** |
| `memory/2026-09-10.md` | 13 | «Подключить **Cloudflare Worker** для Telegram» |
| `research/jwt.md` | 49 | jose работает в **Cloudflare Workers** |
| `research/nebula-rush/ROADMAP.md` | 29 | live deploy **Cloudflare Pages** + custom domain |
| `tasks_pool.json` | 31 | текст самой задачи «Найди все упоминания Cloudflare…» |

## 2. Внешние CDN-ссылки (cdnjs.cloudflare.com)
- `generated_projects/project_20260906_073703/tariffs.html` (font-awesome)
- `generated_projects/project_20260906_073703/contact.html`
- `generated_projects/project_20260906_073558/tariffs.html`
- `generated_projects/project_20260906_072055/index.html`
- `generated_projects/project_20260906_080620/tariffs.html`
- `generated_projects/project_20260906_080620/contact.html`
- `public/index_old.html` (font-awesome, ethers)
- `skills_hub/skills/algorithmic-art/templates/viewer.html` (p5.js)
- `skills_hub/skills/algorithmic-art/SKILL.md` (p5.js)

## 3. skills_hub (документация навыков)
- `skills_hub/CATALOG.md:621` — file-uploads: S3, **Cloudflare R2**
- `skills_hub/skills/file-uploads/SKILL.md:3` — то же
- `skills_hub/skills/lamindb/SKILL.md:143,175` — S3-совместимые (MinIO, Cloudflare R2)
- `skills_hub/skills/lamindb/references/setup-deployment.md:117,253,262,266` — Cloudflare R2 / r2.cloudflarestorage.com
- `skills_hub/skills/lamindb/references/integrations.md:42` — Cloudflare R2
- `skills_hub/skills/upstash-qstash/SKILL.md:68` — cloudflare-workers
- `skills_hub/skills/nodejs-best-practices/SKILL.md:31` — Edge/Serverless (Cloudflare, Vercel)
- `skills_hub/skills/cloud-architect/SKILL.md:42` — edge computing CloudFlare
- `skills_hub/skills/network-engineer/SKILL.md:81` — CDN CloudFlare
- `skills_hub/skills/performance-engineer/SKILL.md:72` — CDN CloudFlare
- `skills_hub/skills/backend-architect/SKILL.md:116` — DDoS CloudFlare
- `skills_hub/skills/deployment-procedures/SKILL.md:32` — Cloudflare Pages
- `skills_hub/skills/application-performance-performance-optimization/SKILL.md:93` — CloudFlare CDN
- `skills_hub/skills/threat-mitigation-mapping/resources/implementation-playbook.md:277,376` — Cloudflare WAF/DDoS
- `skills_hub/skills/writing-skills/references/tier-3-platform/README.md:4,9,18,20` — Cloudflare pattern
- `skills_hub/skills/app-builder/templates/astro-static/TEMPLATE.md:66` — Cloudflare Pages
- `skills_hub/skills_index.json:2590`, `skills_hub/data/catalog.json:7052,7066`, `skills_hub/data/skills_index.json:1879`

## 4. Шум / не относится к продукту
- `logs/race_50_v2.log`, `logs/nightly_train.log` — сотни строк с названием задачи гонки
- `.cf_scan.sh`, `.cf_scan_out.txt`, `.tmp_cf_files.txt`, `.tmp_cf_results.txt`, `.tmp_find_cf.sh` — артефакты прошлых сканов
- `memory/races/*.json`, `memory/patterns/*.json`, `memory/task_cache.json`, `snapshots/*` — история гонок
- `arena/sandboxes/sandbox_1|2/memory/...` — копии истории песочниц
- `everos/.venv/lib/python3.12/site-packages/rich/_export_format.py` — сторонняя библиотека (в venv)
