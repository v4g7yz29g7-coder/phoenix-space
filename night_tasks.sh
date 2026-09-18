#!/bin/bash
cd /home/ishidin/phoenix

LOG="logs/night_tasks.log"
> "$LOG"
echo "=== NIGHT TASKS START: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

PASSWORD=$(grep VPS_CONTROL_PASSWORD .env | cut -d= -f2)

# ============================================================
# ЗАДАЧА D: Фикс Prophet
# ============================================================
echo "" | tee -a "$LOG"
echo "=== D: Фикс Prophet (лимит + сжатие) ===" | tee -a "$LOG"

python3 << 'PYEOF' | tee -a "$LOG"
with open('agent_prophet.js', 'r') as f:
    content = f.read()

# Увеличиваем лимит и добавляем сжатие
old = "  const patterns = loadPatterns(20);"
new = """  const patterns = loadPatterns(40);
  
  // Сжимаем паттерны: только ключевые поля для экономии контекста
  const compressed = patterns.map(p => ({
    winner: p.winner || p.box || '?',
    score: p.winner_score || p.score || '?',
    task: (p.task || '').slice(0, 80),
    ts: p.ts || '',
    type: p.type || (p._file && p._file.startsWith('race_') ? 'race' : 'other')
  }));"""

if old in content:
    content = content.replace(old, new, 1)
    # Заменяем использование patterns на compressed
    content = content.replace("'PATTERNS (' + patterns.length + '):\\n' + JSON.stringify(patterns).slice(0, 8000);",
                               "'PATTERNS (' + compressed.length + '):\\n' + JSON.stringify(compressed).slice(0, 20000);")
    with open('agent_prophet.js', 'w') as f:
        f.write(content)
    print('✅ Prophet: лимит 40, сжатие, 20000 символов')
else:
    print('⚠️  Маркер не найден — пропускаем D')
PYEOF

node --check agent_prophet.js && echo "✅ SYNTAX OK" | tee -a "$LOG"

# ============================================================
# ЗАДАЧА B: Хронометрист в бою
# ============================================================
echo "" | tee -a "$LOG"
echo "=== B: Хронометрист getTrend + getSnapshot ===" | tee -a "$LOG"

node -e "
const a13 = require('./agent_13');
console.log('=== getSnapshot ===');
const snap = a13.getSnapshot();
console.log(JSON.stringify(snap, null, 2).slice(0, 1500));
console.log('');
console.log('=== getTrend (последние 7 дней) ===');
const trend = a13.getTrend(7);
console.log(JSON.stringify(trend, null, 2).slice(0, 1500));
" 2>&1 | tee -a "$LOG"

# ============================================================
# ЗАДАЧА C: ЭКО-архитектура (4 агента)
# ============================================================
echo "" | tee -a "$LOG"
echo "=== C: ЭКО-архитектура ===" | tee -a "$LOG"

# C1: Селекционер (agent_16)
echo "" | tee -a "$LOG"
echo "--- C1: Селекционер (agent_16) ---" | tee -a "$LOG"
timeout 900 curl -s -X POST http://localhost:3001/agent/think-v3 \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\",\"prompt\":\"Используй skill_decompose_codegen. Создай файл agent_16.js — 'Селекционер' (Selector). Стратегия: ОТБОР ЛУЧШИХ ГЕНОВ. 1) Читает memory/patterns/race_*.json; 2) Находит топ-3 агентов по wins и score; 3) Извлекает их лучшие скиллы и промпты; 4) Возвращает объект { parents: [agent_A, agent_B], genes: [...], rationale: '...' } для Эмбриолога. Экспорт { runAgent, STRATEGY, selectParents }. После создания — node --check, потом commit. Верни done.\"}" \
  | tee -a "$LOG"

sleep 10

# C2: Эмбриолог (agent_17)
echo "" | tee -a "$LOG"
echo "--- C2: Эмбриолог (agent_17) ---" | tee -a "$LOG"
timeout 900 curl -s -X POST http://localhost:3001/agent/think-v3 \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\",\"prompt\":\"Используй skill_decompose_codegen. Создай файл agent_17.js — 'Эмбриолог' (Embryologist). Стратегия: СКРЕЩИВАНИЕ ГЕНОВ. 1) Принимает двух родителей (agent_A, agent_B) и их гены; 2) Через askDeepSeekChat синтезирует нового агента 'agent_child.js'; 3) Ребёнок должен объединять лучшие черты родителей; 4) Экспорт { runAgent, STRATEGY, crossbreed }. После создания — node --check, потом commit. Верни done.\"}" \
  | tee -a "$LOG"

sleep 10

# C3: Генетик (agent_18)
echo "" | tee -a "$LOG"
echo "--- C3: Генетик (agent_18) ---" | tee -a "$LOG"
timeout 900 curl -s -X POST http://localhost:3001/agent/think-v3 \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\",\"prompt\":\"Используй skill_decompose_codegen. Создай файл agent_18.js — 'Генетик' (Geneticist). Стратегия: ДОВОДКА ДО ИДЕАЛА. 1) Принимает нового агента; 2) Прогоняет 3 тестовые задачи через agent_loop_v3; 3) Находит слабые места (score < 9, время > 30s); 4) Через edit_file усиливает сильные стороны и убирает слабые; 5) Возвращает обновлённого агента. Экспорт { runAgent, STRATEGY, optimize }. После создания — node --check, потом commit. Верни done.\"}" \
  | tee -a "$LOG"

sleep 10

# C4: Академия (agent_19)
echo "" | tee -a "$LOG"
echo "--- C4: Академия (agent_19) ---" | tee -a "$LOG"
timeout 900 curl -s -X POST http://localhost:3001/agent/think-v3 \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\",\"prompt\":\"Используй skill_decompose_codegen. Создай файл agent_19.js — 'Академия' (Academy). Стратегия: ТЕСТИРОВАНИЕ НОВЫХ АГЕНТОВ. 1) Создаёт изолированный бокс в arena/academy/candidate_N/; 2) Копирует туда нового агента; 3) Прогоняет 5 тестовых задач; 4) Если средний score >= 9 — переводит в boxes/agent_N/ и коммитит; 5) Если < 9 — возвращает Эмбриологу. Экспорт { runAgent, STRATEGY, evaluate }. После создания — node --check, потом commit. Верни done.\"}" \
  | tee -a "$LOG"

# ============================================================
# ФИНАЛ
# ============================================================
echo "" | tee -a "$LOG"
echo "=== NIGHT TASKS DONE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

# Финальный Prophet-анализ
echo "" | tee -a "$LOG"
echo "=== Финальный Prophet анализ ===" | tee -a "$LOG"
timeout 300 curl -s -X POST http://localhost:3001/agent/evolve \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\",\"goal\":\"Проанализировать 15 агентов и ЭКО-архитектуру\",\"dryRun\":true}" \
  >> "$LOG" 2>&1

