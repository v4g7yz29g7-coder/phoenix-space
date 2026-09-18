// Sentinel — страж. Проверяет pm2 каждые 60 сек, чинит упавшие процессы.
const { exec } = require('child_process');
const fs = require('fs');

const CHECK_INTERVAL = 60 * 1000;
const LOG_FILE = '/home/ishidin/phoenix/logs/sentinel.log';

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function pm2List() {
  return new Promise((resolve) => {
    exec('pm2 jlist', (err, stdout) => {
      if (err) return resolve([]);
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve([]); }
    });
  });
}

async function checkAndFix() {
  const processes = await pm2List();
  const errored = processes.filter(p => p.pm2_env && p.pm2_env.status !== 'online');

  if (errored.length === 0) {
    return { ok: true, status: 'all_online', count: processes.length };
  }

  log('WARN: ' + errored.length + ' down process(es)');
  for (const p of errored) {
    log('Restarting ' + p.name + '...');
    await new Promise(r => exec('pm2 restart ' + p.name, () => r()));
    await new Promise(r => setTimeout(r, 3000));
  }
  return { ok: true, fixed: errored.length };
}

async function loop() {
  log('Sentinel started. Interval: ' + (CHECK_INTERVAL / 1000) + 's');
  while (true) {
    try {
      const result = await checkAndFix();
      if (result.count) log('Check: ' + result.status + ' (' + result.count + ' processes)');
    } catch (e) {
      log('ERROR: ' + e.message);
    }
    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
}

if (require.main === module) {
  if (process.argv.includes('--once')) {
    checkAndFix().then(r => { console.log(JSON.stringify(r)); process.exit(0); });
  } else {
    loop();
  }
}

module.exports = { checkAndFix, pm2List };
