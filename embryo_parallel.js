// embryo_parallel.js — параллельное скрещивание неожиданных пар
require('dotenv').config({ path: __dirname + '/.env' });
const a17 = require('./agent_17');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

async function main() {
  console.log('=== ПАРАЛЛЕЛЬНОЕ ЭКО: неожиданные пары ===\n');

  const champions = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'champions.json'), 'utf8'));
  const list = Object.entries(champions.champions || {})
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => (b.wins_recent || 0) - (a.wins_recent || 0));

  console.log('Топ-6 хедлайнеров:');
  list.slice(0, 6).forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.name} (wins ${p.wins_recent}, score ${p.avg_score})`);
  });
  console.log('');

  const pairs = [];
  if (list.length >= 6) {
    pairs.push([list[0], list[3]], [list[1], list[4]], [list[2], list[5]]);
  } else if (list.length >= 4) {
    pairs.push([list[0], list[3]], [list[1], list[2]]);
  } else {
    console.log('⚠️  Мало агентов');
    return;
  }

  console.log('Неожиданные пары:');
  pairs.forEach((p, i) => console.log(`  ${i + 1}. ${p[0].name} + ${p[1].name}`));
  console.log('');

  const enrichedPairs = pairs.map(pair => pair.map(p => {
    let prompt = '';
    try {
      const pf = path.join(ROOT, 'boxes', p.name, 'prompts', p.name + '.md');
      if (fs.existsSync(pf)) prompt = fs.readFileSync(pf, 'utf8');
    } catch (e) {}
    return { name: p.name, wins: p.wins_recent, score: p.avg_score, prompt };
  }));

  console.log('Запуск параллельного скрещивания...\n');
  const startTime = Date.now();

  const results = await Promise.all(
    enrichedPairs.map((pair, i) =>
      a17.crossbreed(pair, { name: `agent_${20 + i}.js` })
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
      console.log(`   ${(r.strategy || '').slice(0, 200)}`);
    } else {
      console.log(`   ❌ ${r.error}`);
    }
    console.log('');
  });

  const protocol = {
    ts: new Date().toISOString(),
    type: 'parallel_embryo',
    duration_sec: parseFloat(duration),
    pairs: results.map(r => ({ parents: r.pair, ok: r.ok, newAgent: r.newAgent, strategy: r.strategy, error: r.error }))
  };
  fs.writeFileSync(path.join(ROOT, 'memory', 'embryo_parallel_protocol.json'), JSON.stringify(protocol, null, 2));
  console.log('📋 Протокол: memory/embryo_parallel_protocol.json');
}

main().catch(e => console.error('FATAL:', e.message));
