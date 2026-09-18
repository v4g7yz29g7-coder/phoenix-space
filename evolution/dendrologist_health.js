'use strict';

/**
 * dendrologist_health.js — здоровье ветви (branch health) для агентов.
 *
 * Метафора: дендролог оценивает состояние ветви дерева по ряду признаков —
 * прирост, плотность листвы, кора, следы повреждений. Здесь те же принципы
 * применены к эволюционной "ветви" агента: набору патчей, признаков и
 * метрик, накопленных за поколения.
 *
 * API:
 *   health(agentId) -> {
 *     agentId,
 *     score,          // 0..100 итоговое здоровье
 *     status,         // 'thriving' | 'stable' | 'stressed' | 'wilting' | 'dead'
 *     vitals,         // сырые метрики
 *     indicators,     // разбор по каждому показателю
 *     branch,         // структура ветви (узлы/листья)
 *     recommendations // что делать дендрологу
 *   }
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_DIR = path.join(__dirname, '..', 'state', 'branches');

// ---------------------------------------------------------------------------
// Конфигурация весов показателей здоровья ветви.
// ---------------------------------------------------------------------------
const WEIGHTS = Object.freeze({
  growth: 0.22,      // прирост: появляются ли новые поколения
  foliage: 0.20,     // плотность полезной активности
  sap: 0.18,         // проводимость: пропускная способность задач
  bark: 0.15,        // устойчивость к повреждениям (ошибкам)
  roots: 0.15,       // укоренённость: стабильность истории
  damage: 0.10,      // обратный показатель: следы болезней/регрессий
});

const THRESHOLDS = Object.freeze([
  { min: 85, status: 'thriving' },
  { min: 65, status: 'stable' },
  { min: 45, status: 'stressed' },
  { min: 20, status: 'wilting' },
  { min: 0, status: 'dead' },
]);

// ---------------------------------------------------------------------------
// Вспомогательные утилиты.
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function tryLoadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function normalizeSeries(series, size = 8) {
  if (!Array.isArray(series)) return [];
  const tail = series.slice(-size);
  return tail.map((x) => safeNumber(x));
}

// ---------------------------------------------------------------------------
// Загрузка сырых данных о ветви агента.
// В реальной системе данные приходят из EverOS-памяти; здесь — из state-файла
// с безопасным фолбэком на синтетический профиль, чтобы модуль работал
// автономно и не падал при отсутствии состояния.
// ---------------------------------------------------------------------------
function loadRawBranch(agentId) {
  const safeId = String(agentId || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const file = path.join(DEFAULT_STATE_DIR, `${safeId}.json`);
  const loaded = tryLoadJson(file);
  if (loaded && typeof loaded === 'object') {
    return loaded;
  }
  return synthesizeBranch(safeId);
}

function synthesizeBranch(agentId) {
  // Детерминированная псевдо-ветвь по хэшу идентификатора: одна и та же
  // ветвь всегда даёт одинаковый профиль (важно для воспроизводимости).
  let h = 2166136261;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rnd = (salt) => {
    let x = (h ^ (salt * 2654435761)) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
    return ((x >>> 8) & 0xffff) / 0xffff;
  };
  return {
    generations: Math.round(3 + rnd(1) * 40),
    growthSeries: Array.from({ length: 8 }, () => rnd(2) * 10),
    taskSeries: Array.from({ length: 8 }, () => rnd(3) * 20),
    foliageSeries: Array.from({ length: 8 }, () => rnd(4)),
    errors: Math.round(rnd(5) * 25),
    recoveries: Math.round(rnd(6) * 25),
    ageDays: Math.round(1 + rnd(7) * 365),
    depth: Math.round(1 + rnd(8) * 6),
    leaves: Math.round(5 + rnd(9) * 95),
    regressions: Math.round(rnd(10) * 10),
  };
}

// ---------------------------------------------------------------------------
// Показатели (indicators). Каждый возвращает { name, raw, score, note }.
// ---------------------------------------------------------------------------
function indicatorGrowth(raw) {
  const series = normalizeSeries(raw.growthSeries);
  if (series.length < 2) {
    return { name: 'growth', raw: 0, score: 40, note: 'недостаточно данных о приросте' };
  }
  const first = series[0];
  const last = series[series.length - 1];
  const delta = last - first;
  const slope = delta / Math.max(1, series.length - 1);
  const score = clamp(50 + slope * 12, 0, 100);
  const note =
    slope > 0.3 ? 'устойчивый прирост новых поколений'
      : slope < -0.3 ? 'ветвь замедляет рост'
        : 'прирост стабилен';
  return { name: 'growth', raw: Number(slope.toFixed(3)), score: Math.round(score), note };
}

function indicatorFoliage(raw) {
  const series = normalizeSeries(raw.foliageSeries);
  const density = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0;
  const score = clamp(density * 100, 0, 100);
  const note =
    density > 0.7 ? 'густая листва полезной активности'
      : density < 0.3 ? 'листва редка, активность низка'
        : 'умеренная плотность листвы';
  return { name: 'foliage', raw: Number(density.toFixed(3)), score: Math.round(score), note };
}

function indicatorSap(raw) {
  const series = normalizeSeries(raw.taskSeries);
  if (!series.length) {
    return { name: 'sap', raw: 0, score: 30, note: 'нет данных о проводимости' };
  }
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const max = Math.max(...series);
  const ratio = max > 0 ? mean / max : 0;
  const score = clamp(ratio * 100, 0, 100);
  const note =
    ratio > 0.8 ? 'сок движется равномерно, устойчивый поток задач'
      : ratio < 0.4 ? 'поток задач нестабилен, сок прерывается'
        : 'проводимость частично затруднена';
  return { name: 'sap', raw: Number(ratio.toFixed(3)), score: Math.round(score), note };
}

function indicatorBark(raw) {
  const errors = safeNumber(raw.errors, 0);
  const recoveries = safeNumber(raw.recoveries, 0);
  const resilience = errors > 0 ? clamp(recoveries / errors, 0, 1) : 1;
  const score = clamp(resilience * 100, 0, 100);
  const note =
    resilience > 0.75 ? 'кора крепкая, повреждения заживают'
      : resilience < 0.35 ? 'кора слабая, ошибки накапливаются'
        : 'кора умеренно устойчива';
  return { name: 'bark', raw: Number(resilience.toFixed(3)), score: Math.round(score), note };
}

function indicatorRoots(raw) {
  const ageDays = safeNumber(raw.ageDays, 0);
  const depth = safeNumber(raw.depth, 0);
  const ageScore = clamp((ageDays / 365) * 100, 0, 100);
  const depthScore = clamp((depth / 6) * 100, 0, 100);
  const score = Math.round(ageScore * 0.5 + depthScore * 0.5);
  const note =
    score > 75 ? 'глубокая укоренённая история'
      : score < 35 ? 'ветвь молода и слабо укоренена'
        : 'корневая система достаточна';
  return { name: 'roots', raw: { ageDays, depth }, score, note };
}

function indicatorDamage(raw) {
  const regressions = safeNumber(raw.regressions, 0);
  const generations = Math.max(1, safeNumber(raw.generations, 1));
  const damageRatio = clamp(regressions / generations, 0, 1);
  // damage — обратный показатель: чем больше повреждений, тем ниже score.
  const score = clamp(100 - damageRatio * 100, 0, 100);
  const note =
    damageRatio < 0.1 ? 'следов регрессий почти нет'
      : damageRatio > 0.5 ? 'многочисленные регрессии ослабляют ветвь'
        : 'единичные следы повреждений';
  return { name: 'damage', raw: Number(damageRatio.toFixed(3)), score: Math.round(score), note };
}

// ---------------------------------------------------------------------------
// Агрегация: взвешенная сумма показателей.
// ---------------------------------------------------------------------------
function aggregate(indicators) {
  let total = 0;
  for (const ind of indicators) {
    const w = WEIGHTS[ind.name] != null ? WEIGHTS[ind.name] : 0;
    total += ind.score * w;
  }
  const wsum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  return Math.round(clamp(total / wsum, 0, 100));
}

function classify(score) {
  for (const t of THRESHOLDS) {
    if (score >= t.min) return t.status;
  }
  return 'dead';
}

// ---------------------------------------------------------------------------
// Рекомендации дендролога.
// ---------------------------------------------------------------------------
function recommend(status, indicators) {
  const recs = [];
  const byName = Object.fromEntries(indicators.map((i) => [i.name, i]));

  if (status === 'dead') {
    recs.push('Ветвь мертва: поместить в архив и вырастить новую из сильного предка.');
  }
  if (byName.growth && byName.growth.score < 50) {
    recs.push('Стимулировать прирост: запустить этап мутации/бридинга.');
  }
  if (byName.foliage && byName.foliage.score < 45) {
    recs.push('Повысить плотность активности: перераспределить задачи на ветвь.');
  }
  if (byName.sap && byName.sap.score < 50) {
    recs.push('Прочистить проводящие пути: снизить пиковые перегрузки планировщика.');
  }
  if (byName.bark && byName.bark.score < 50) {
    recs.push('Укрепить кору: включить автопочинку ошибок после регрессий.');
  }
  if (byName.roots && byName.roots.score < 40) {
    recs.push('Углубить корни: накопить стабильную историю успешных циклов.');
  }
  if (byName.damage && byName.damage.score < 60) {
    recs.push('Срезать повреждённые узлы: откатить регрессивные патчи.');
  }
  if (!recs.length) {
    recs.push('Ветвь здорова: поддерживать текущий режим и наблюдать.');
  }
  return recs;
}

// ---------------------------------------------------------------------------
// Построение структуры ветви для визуализации.
// ---------------------------------------------------------------------------
function buildBranch(raw) {
  const leaves = Math.max(0, safeNumber(raw.leaves, 0));
  const depth = Math.max(1, safeNumber(raw.depth, 1));
  const nodes = [];
  for (let d = 0; d < depth; d++) {
    const perLevel = Math.max(1, Math.round(leaves / depth));
    nodes.push({
      level: d,
      children: perLevel,
      load: Number(clamp(perLevel / Math.max(1, leaves), 0, 1).toFixed(3)),
    });
  }
  return { depth, leaves, nodes };
}

// ---------------------------------------------------------------------------
// Публичный API.
// ---------------------------------------------------------------------------
function health(agentId) {
  const raw = loadRawBranch(agentId);
  const indicators = [
    indicatorGrowth(raw),
    indicatorFoliage(raw),
    indicatorSap(raw),
    indicatorBark(raw),
    indicatorRoots(raw),
    indicatorDamage(raw),
  ];
  const score = aggregate(indicators);
  const status = classify(score);
  const recommendations = recommend(status, indicators);

  return {
    agentId: String(agentId || 'unknown'),
    score,
    status,
    vitals: {
      generations: safeNumber(raw.generations, 0),
      ageDays: safeNumber(raw.ageDays, 0),
      errors: safeNumber(raw.errors, 0),
      recoveries: safeNumber(raw.recoveries, 0),
      regressions: safeNumber(raw.regressions, 0),
    },
    indicators,
    branch: buildBranch(raw),
    recommendations,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Компактная сводка здоровья ветви для оркестратора эволюции
 * (registry entry: 'summary'). Возвращает только ключевые поля, чтобы
 * результат легко агрегировался в тактах.
 */
function summary(agentId) {
  const report = health(agentId);
  const worst = report.indicators
    .slice()
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map((i) => ({ name: i.name, score: i.score }));
  return {
    ok: report.status !== 'dead',
    agentId: report.agentId,
    score: report.score,
    status: report.status,
    weakest: worst,
    recommendations: report.recommendations,
    checkedAt: report.checkedAt,
  };
}

module.exports = { health, summary, WEIGHTS, THRESHOLDS };

// Быстрый CLI-запуск: node dendrologist_health.js <agentId>
if (require.main === module) {
  const id = process.argv[2] || 'default';
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(health(id), null, 2));
}
