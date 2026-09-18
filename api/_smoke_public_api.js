'use strict';
const api = require('./public_api');

(async function () {
  const info = await api.start({ port: 3188, host: '127.0.0.1' });
  const base = 'http://127.0.0.1:' + info.port;
  const j = (u, o) => fetch(base + u, o).then((r) => r.json());

  const created = await j('/api/records', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alpha', value: 42, tags: ['core'] }),
  });
  console.log('CREATE', created.ok, created.data && created.data.id);

  const list = await j('/api/records');
  console.log('LIST', list.ok, list.data.count);

  const got = await j('/api/records/1');
  console.log('GET', got.ok, got.data.name);

  const upd = await j('/api/records/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 99 }),
  });
  console.log('PATCH', upd.ok, upd.data.value);

  const search = await j('/api/records/search?tag=core');
  console.log('SEARCH', search.ok, search.data.count);

  const stats = await j('/stats');
  console.log('STATS', stats.ok, stats.data.requests);

  const del = await j('/api/records/1', { method: 'DELETE' });
  console.log('DELETE', del.ok, del.data.deleted);

  const miss = await j('/nope');
  console.log('404', miss.ok === false, miss.error.code);

  const stop = await api.stop();
  console.log('STOP', stop.stopped, 'running=', api.isRunning());
})().catch(function (e) {
  console.error('ERR', e);
  process.exit(1);
});
