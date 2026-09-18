const rag = require('./architect/rag_indexer');
(async () => {
  const r = await rag.index({ quiet: true });
  console.log('INDEX:', JSON.stringify({ ok: r.ok, backend: r.backend, files: r.files, chunks: r.chunks, dim: r.dim, table: r.table, ms: r.ms }));
  const hits = await rag.search('как ставить задачи и критерии готовности', { limit: 3 });
  console.log('SEARCH:', hits.length, 'hits');
  hits.forEach(h => console.log(' -', (h.docId || h.id), '| score=', Number(h.score).toFixed(4), '|', String(h.text || '').slice(0, 60).replace(/\n/g, ' ')));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
