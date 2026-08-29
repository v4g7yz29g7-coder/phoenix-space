const express = require('express');
const { exec } = require('child_process');
const { coder, guardian, reporter } = require('./gardener_agents');

const router = express.Router();

router.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Садовник Феникса</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { background: #0a0a12; color: #e8e4f0; font-family: Inter, sans-serif; padding: 2rem; }
        h1 { font-size: 1.5rem; margin-bottom: 1rem; }
        button { background: #a78bfa; border: none; color: #0a0a12; padding: 0.8rem 1.5rem; border-radius: 8px; font-size: 1rem; cursor: pointer; margin: 0.25rem; }
        pre { background: #12121f; padding: 1rem; border-radius: 8px; overflow-x: auto; }
      </style>
    </head>
    <body>
      <h1>🐦‍🔥 Садовник</h1>
      <button onclick="runCoder()">Coder</button>
      <button onclick="runGuardian()">Guardian</button>
      <button onclick="runReporter()">Reporter</button>
      <button onclick="scan()">Scout</button>
      <button onclick="test()">Tester</button>
      <button onclick="gitStatus()">Git status</button>
      <button onclick="commitPush()">Commit & Push</button>
      <pre id="output">Нажми кнопку, чтобы начать.</pre>
      <script>
        async function runCoder() {
          document.getElementById('output').textContent = 'Coder работает...';
          const res = await fetch('/gardener/coder');
          const data = await res.json();
          document.getElementById('output').textContent = data.result;
        }
        async function runGuardian() {
          document.getElementById('output').textContent = 'Guardian проверяет...';
          const res = await fetch('/gardener/guardian');
          const data = await res.json();
          document.getElementById('output').textContent = data.result;
        }
        async function runReporter() {
          document.getElementById('output').textContent = 'Reporter пишет отчёт...';
          const res = await fetch('/gardener/reporter');
          const data = await res.json();
          document.getElementById('output').textContent = data.result;
        }
        async function scan() {
          document.getElementById('output').textContent = 'Сканирую...';
          const res = await fetch('/gardener/scan');
          const data = await res.json();
          document.getElementById('output').textContent = data.result;
        }
        async function test() {
          document.getElementById('output').textContent = 'Запускаю тесты...';
          const res = await fetch('/gardener/test');
          const data = await res.json();
          document.getElementById('output').textContent = data.result;
        }
        async function gitStatus() {
          document.getElementById('output').textContent = 'Проверяю Git...';
          const res = await fetch('/gardener/git-status');
          const data = await res.json();
          document.getElementById('output').textContent = data.result;
        }
        async function commitPush() {
          document.getElementById('output').textContent = 'Коммичу и пушу...';
          const res = await fetch('/gardener/commit-push');
          const data = await res.json();
          document.getElementById('output').textContent = data.result;
        }
      </script>
    </body>
    </html>
  `);
});

router.get('/coder', async (req, res) => {
  res.json({ result: await coder() });
});

router.get('/guardian', async (req, res) => {
  res.json({ result: await guardian() });
});

router.get('/reporter', async (req, res) => {
  res.json({ result: await reporter('Отчёт из панели Садовника') });
});

router.get('/scan', (req, res) => {
  exec('grep -R "IO.inspect" ~/phoenix --include="*.js" --include="*.ex" --include="*.exs" --exclude="gardener.js"', (error, stdout, stderr) => {
    if (stdout) res.json({ result: 'Найдены следы IO.inspect:\n' + stdout });
    else if (error) res.json({ result: 'Ошибка: ' + stderr });
    else res.json({ result: 'Чисто: IO.inspect не найден' });
  });
});

router.get('/test', (req, res) => {
  res.json({ result: 'Tester ждёт dev-контейнер. Проверка тестов будет доступна позже.' });
});

router.get('/git-status', (req, res) => {
  exec('cd ~/phoenix && git status --short', (error, stdout) => {
    if (stdout) res.json({ result: 'Изменённые файлы:\n' + stdout });
    else res.json({ result: 'Нет изменений в репозитории' });
  });
});

router.get('/commit-push', (req, res) => {
  exec('cd ~/phoenix && git add -A && git commit -m "auto: обновление из Садовника" && git push origin main', (error, stdout, stderr) => {
    if (stdout) res.json({ result: 'Результат:\n' + stdout });
    else if (error) res.json({ result: 'Ошибка: ' + (stderr || error.message) });
    else res.json({ result: 'Изменения отправлены' });
  });
});

module.exports = router;
