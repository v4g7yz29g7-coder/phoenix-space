// embryo_deep.js — ГЛУБОКОЕ ЭКО: скрещиваем победителей с проигравшими
// Идея: проигравший — не слабый, а нишевый. Его глубина может усилить чемпиона.
require('dotenv').config({ path: __dirname + '/.env' });
const a17 = require('./agent_17');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

async function main() {
  console.log('=== ГЛУБОКОЕ ЭКО: победители × проигравшие ===\n');

  const champions = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'champions.json'), 'utf8'));
  const all = Object.entries(champions.champions || {})
    .map(([name, data]) => ({ name, ...data }));

  // Сортируем по wins
  const sorted = all.sort((a, b) => (b.wins_recent || 0) - (a.wins_recent || 0));

  // Топ-3 победителя (много побед)
  const winners = sorted.slice(0, 3);

  // Топ-3 "глубоких" — высокий score, но мало побед (нишевые)
  const deep = all
    .filter(a => !winners.includes(a))
    .sort((a, b) => (b.avg_score || 0) - (a.avg_score || 0))
    .slice(0, 3);

  console.log('ПОБЕДИТЕЛИ (много побед):');
  winners.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (wins ${p.wins_recent}, score ${p.avg_score})`));
  console.log('');

  console.log('ГЛУБОКИЕ (высокий score, мало побед):');
  deep.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (wins ${p.wins_recent}, score ${p.avg_score})`));
  console.log('');

  // Формируем пары: победитель × глубокий
  const pairs = [];
  const maxPairs = Math.min(winners.length, deep.length);
  for (let i = 0; i < maxPairs; i++) {
    pairs.push([winners[i], deep[i]]);
  }

  console.log('ГИБРИДНЫЕ ПАРЫ:');
  pairs.forEach((p, i) => console.log(`  ${i + 1}. ${p[0].name} (победитель) + ${p[1].name} (глубокий)`));
  console.log('');

  // Читаем промпты
  const enriched = pairs.map(pair => pair.map(p => {
    let prompt = '';
    try {
      const pf = path.join(ROOT, 'boxes', p.name, 'prompts', p.name + '.md');
      if (fs.existsSync(pf)) prompt = fs.readFileSync(pf, 'utf8');
    } catch (e) {}
    return { name: p.name, wins: p.wins_recent, score: p.avg_score, prompt };
  }));

  // Параллельный crossbreed
  console.log('Запуск параллельного скрещивания...\n');
  const startTime = Date.now();

  const results = await Promise.all(
    enriched.map((pair, i) =>
      a17.crossbreed(pair, { name: `agent_${23 + i}.js` })
        .then(r => ({ pair: pair.map(p => p.name), ...r }))
        .catch(e => ({ pair: pair.map(p => p.name), ok: false, error: e.message }))
    )
  );

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`⏱️  Завершено за ${duration}s\n`);

  console.log('=== РЕЗУЛЬТАТЫ ===\n');
  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.pair.join(' + ')}`);
    if (r.ok) {
      console.log(`   ✅ ${r.newAgent}`);
      console.log(`   Стратегия: ${(r.strategy || '').slice(0, 200)}`);
    } else {
      console.log(`   ❌ ${r.error}`);
    }
    console.log('');
  });

  // Протокол
  const protocol = {
    ts: new Date().toISOString(),
    type: 'deep_embryo',
    duration_sec: parseFloat(duration),
    pairs: results.map(r => ({ parents: r.pair, ok: r.ok, newAgent: r.newAgent, strategy: r.strategy, error: r.error }))
  };
  fs.writeFileSync(path.join(ROOT, 'memory', 'embryo_deep_protocol.json'), JSON.stringify(protocol, null, 2));
  console.log('📋 Протокол: memory/embryo_deep_protocol.json');
}

main().catch(e => console.error('FATAL:', e.message));
