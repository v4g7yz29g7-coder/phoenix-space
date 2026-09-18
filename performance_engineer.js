// performance_engineer.js — Performance Engineer: per-task LLM parameter tuning.
//
// Public API:
//   pickModel(task, type)      -> 'deepseek-flash' | 'deepseek-pro'
//   pickTemperature(task)      -> 0.2 (code) | 0.7 (text)
//   pickSkills(task)           -> string[] (skill ids from skills/, max 3)
//   tuneParams(task, type)     -> { model, temperature, topSkills }
//
// Design notes / evidence (read-only inventory, 2026-09-12):
//   - Signature style (task, type) and the pure-module contract are copied from
//     race_engineer.js (buildPrompt(task, type), 'use strict', single export map).
//   - Model ids follow the existing repo convention: 'deepseek-flash' appears in
//     agent_critic.js / agent_responses.js / deepseek_responses.js / agent_*.js.
//   - Skill ids below were inventoried from the real skills/ directory:
//     atomic_task_decomposition, debug_error, skill_decompose_codegen, self_modify,
//     canonical_path_resolution, night_race_analysis_apply, context-optimization,
//     context-compression, context-management-context-save, code-refactoring-context-restore,
//     context-degradation, c4-context, product-marketing-context.
//
// This module is pure: no fs, no network, no writes, no git. All decisions are
// explicit, testable heuristics — not statistically proven mappings.

'use strict';

const FLASH = 'deepseek-flash';
const PRO = 'deepseek-pro';

const MAX_SKILLS = 3;

// Task is "complex" when it is long (> 200 chars) or mentions architecture-level
// keywords. Long prompt = more constraints to hold at once; those keywords mark
// design work where a shallow model produces confident, wrong structure.
const COMPLEX_MARKERS = [
  'архитектура', 'архитектур', 'рефактор', 'спроектировать', 'спроектируй',
  'architecture', 'refactor', 'design the', 'спроект'
];

const COMPLEX_LENGTH = 200;

function pickModel(task, type) {
  const t = String(task || '');
  const lower = t.toLowerCase();

  // 1) Length rule: more than 200 characters of task text.
  if (t.length > COMPLEX_LENGTH) return PRO;

  // 2) Keyword rule: architecture / refactor / design-the-system work.
  for (const m of COMPLEX_MARKERS) {
    if (lower.includes(m)) return PRO;
  }

  // 3) Default: everything else is a simple lookup/one-file change.
  // `type` is accepted for API symmetry with race_engineer.js(task, type) and is
  // intentionally NOT used to escalate: the task defines complexity by length and
  // keywords only, so a 'write' task stays flash unless it trips rule 1 or 2.
  return FLASH;
}

// Code wants determinism: 0.2. Prose wants variation: 0.7.
const TEMP_CODE = 0.2;
const TEMP_TEXT = 0.7;

// Markers of a task whose deliverable is code (or a code-shaped artifact),
// rather than prose/creative text.
const CODE_MARKERS = [
  'код', 'code', 'функци', 'function', 'скрипт', 'script', 'файл', '.js', 'javascript',
  'баг', 'bug', 'debug', 'debugger', 'error', 'ошибк', 'стектрейс', 'stack trace',
  'рефактор', 'refactor', 'тест', 'test', 'api', 'sql', 'regex', 'регулярн',
  'commit', 'коммит', 'git', 'npm', 'node', 'json', 'класс', 'class', 'метод', 'method',
  'переменн', 'variable', 'синтаксис', 'syntax', 'импорт', 'import', 'экспорт', 'export',
  'парсер', 'parser', 'оптимизац', 'optimiz', 'производительн', 'performance'
];

// Markers of prose/creative deliverables — checked only if no code marker matched,
// and a hard "write text" instruction wins outright.
const TEXT_MARKERS = [
  // Roots, not full words — Russian morphology-safe.
  'текст', 'стать', 'article', 'пост', 'post', 'сочин', 'эссе', 'essay',
  'письм', 'letter', 'описа', 'опиши', 'describe', 'объясн', 'explain',
  'перевед', 'translate', 'слоган', 'slogan', 'маркетинг', 'marketing',
  'документац', 'docstring', 'комментар', 'ответ', 'reply', 'поздрав',
  'стори', 'story', 'расскаж', 'раскрой', 'изложи', 'сформулир'
];

function pickTemperature(task) {
  const t = String(task || '').toLowerCase();

  // Prose deliverables FIRST — "напиши статью" wins even if "javascript" appears.
  for (const m of TEXT_MARKERS) {
    if (t.includes(m)) return TEMP_TEXT;
  }

  // Code markers second.
  for (const m of CODE_MARKERS) {
    if (t.includes(m)) return TEMP_CODE;
  }

  // Unknown/ambiguous task: deterministic low temperature.
  return TEMP_CODE;
}

// Skill routing: ordered rules evaluated against the lowercased task text.
// Each rule contributes exactly one id; ids are collected in rule order,
// de-duplicated, then capped at MAX_SKILLS. Every id below exists under skills/
// (inventory 2026-09-12) so the output is always loadable.
const SKILL_RULES = [
  {
    id: 'debug_error',
    markers: ['баг', 'bug', 'debug', 'ошибк', 'error', 'стектрейс', 'stack trace', 'traceback', 'падает', 'failing', 'exception']
  },
  {
    id: 'skill_decompose_codegen',
    markers: ['создай файл', 'создать файл', 'напиши файл', 'сгенерир', 'generate', 'codegen', 'большой файл', 'large file', 'agent_box']
  },
  {
    id: 'atomic_task_decomposition',
    markers: ['декомпоз', 'разбей', 'разбить', 'decompose', 'многофункц', 'multi-function', 'шаг за шагом', 'step by step']
  },
  {
    id: 'self_modify',
    markers: ['self_modify', 'self-modif', 'самомодиф', 'свой код', 'own code', 'измени себя', 'модифицир свой']
  },
  {
    id: 'canonical_path_resolution',
    markers: ['путь', 'path', 'canonical', 'канон', 'где находится', 'file not found', 'не найден файл', 'директори', 'resolve']
  },
  {
    id: 'night_race_analysis_apply',
    markers: ['гонк', 'race', 'night_race', 'ночн']
  },
  {
    id: 'c4-context',
    markers: ['c4', 'архитектур', 'architecture', 'system context', 'системный контекст', 'диаграмм']
  },
  {
    id: 'context-compression',
    markers: ['компресс', 'compress', 'сжать контекст', 'сократи контекст', 'сжат', 'суммар', 'summariz']
  },
  {
    id: 'context-optimization',
    markers: ['контекст', 'context', 'токен', 'token', 'окно контекста', 'context window']
  },
  {
    id: 'context-management-context-save',
    markers: ['сохрани контекст', 'save context', 'context save', 'запомни', 'память', 'memory']
  },
  {
    id: 'code-refactoring-context-restore',
    markers: ['восстанов', 'restore', 'rehydrat', 'рехидрат', 'продолжи с']
  },
  {
    id: 'context-degradation',
    markers: ['деградац', 'degradation', 'забывает', 'forget', 'потеря контекста']
  },
  {
    id: 'product-marketing-context',
    markers: ['маркетинг', 'marketing', 'продукт', 'product', 'слоган', 'slogan', 'позиционирован']
  }
];

// Fallback for tasks with no recognizable markers: the generic decomposition
// skill is the cheapest safe default for any multi-step task.
const DEFAULT_SKILLS = ['atomic_task_decomposition'];

function pickSkills(task) {
  const t = String(task || '').toLowerCase();
  if (!t) return DEFAULT_SKILLS.slice();

  const picked = [];
  for (const rule of SKILL_RULES) {
    if (picked.length >= MAX_SKILLS) break;
    if (picked.includes(rule.id)) continue;
    for (const m of rule.markers) {
      if (t.includes(m)) {
        picked.push(rule.id);
        break;
      }
    }
  }

  return picked.length ? picked : DEFAULT_SKILLS.slice();
}

// Aggregate entry point: first argument is the task text, second is the task
// kind (mirrors race_engineer.js(task, type)). `type` is forwarded to
// pickModel only, since model choice is the one decision that may consult it.
function tuneParams(task, type) {
  return {
    model: pickModel(task, type),
    temperature: pickTemperature(task),
    topSkills: pickSkills(task)
  };
}

module.exports = { pickModel, pickTemperature, pickSkills, tuneParams };
