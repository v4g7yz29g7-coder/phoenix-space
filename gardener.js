const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const router = express.Router();
const logsDir = path.join(os.homedir(), 'agents', 'logs');

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: os.homedir() }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: stderr || err.message });
      else resolve({ ok: true, out: stdout });
    });
  });
}

router.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>Садовник</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{background:#0a0a12;color:#e8e4f0;font-family:Inter,sans-serif;padding:20px;margin:0}
.panel{max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
h1{margin:0 0 8px}
select,textarea{width:100%;background:#12121f;color:#e8e4f0;border:1px solid #333;border-radius:8px;padding:10px;font-size:14px}
button{background:#a78bfa;color:#0a0a12;border:none;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer;margin-right:8px}
button.secondary{background:transparent;border:1px solid #555;color:#e8e4f0}
pre{background:#12121f;border:1px solid #333;border-radius:8px;padding:12px;white-space:pre-wrap;max-height:400px;overflow:auto;font-size:13px}
.status{color:#a09ab8;font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap}
</style></head><body><div class="panel">
<h1>🐦‍🔥 Садовник</h1>
<div>
<select id="agent"><option value="coder">Coder</option><option value="scout">Scout</option><option value="guardian">Guardian</option><option value="reporter">Reporter</option></select>
</div>
<textarea id="prompt" rows="3" placeholder="Опиши задачу для агента..."></textarea>
<input type="text" id="target_file" placeholder="Файл для сохранения (необязательно)" style="width:100%;background:#12121f;color:#e8e4f0;border:1px solid #333;border-radius:8px;padding:10px;font-size:14px;margin-top:8px">
<div class="row">
<button onclick="submitTask()">Отправить задачу</button>
<button class="secondary" onclick="runAllTasks()">Запустить задачи из tasks.txt</button>
<button class="secondary" onclick="loadLogs()">Обновить логи</button>
<button class="secondary" onclick="gitStatus()">Git status</button>
<button class="secondary" onclick="commitPush()">Commit & Push</button>
</div>
<div class="status" id="status">Готов к работе.</div>
<h3>Последние отчёты</h3>
<pre id="output">Здесь появятся результаты.</pre>
</div>
<script>
async function submitTask(){
 const agent=document.getElementById('agent').value;
 const prompt=document.getElementById('prompt').value.trim();
 if(!prompt){alert('Введите задачу');return;}
 setStatus('Выполняю задачу '+agent+'...');
 const res=await fetch('/gardener/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent,prompt,target_file:document.getElementById('target_file').value})});
 const data=await res.json();
 document.getElementById('output').textContent=data.result||'Готово';
 setStatus('Задача обработана');
 document.getElementById('prompt').value='';
}
async function runAllTasks(){
 setStatus('Запускаю все задачи из tasks.txt...');
 const res=await fetch('/gardener/run-all');
 const data=await res.json();
 document.getElementById('output').textContent=data.result||'Готово';
 setStatus('Пакет задач завершён');
}
async function loadLogs(){
 setStatus('Читаю логи...');
 const res=await fetch('/gardener/logs');
 const data=await res.json();
 document.getElementById('output').textContent=data.logs||'Логов нет';
 setStatus('Логи обновлены');
}
async function gitStatus(){
 setStatus('Проверяю git...');
 const res=await fetch('/gardener/git-status');
 const data=await res.json();
 document.getElementById('output').textContent=data.result;
 setStatus('Git status получен');
}
async function commitPush(){
 setStatus('Коммичу и пушу...');
 const res=await fetch('/gardener/commit-push');
 const data=await res.json();
 document.getElementById('output').textContent=data.result;
 setStatus('Commit & Push завершены');
}
function setStatus(t){document.getElementById('status').textContent=t;}
</script>
</body></html>`);
});

router.post('/submit', async (req, res) => {
  const { agent, prompt } = req.body;
  if (!agent || !prompt) return res.json({ result: 'Нет агента или задачи.' });
  const result = await runCmd(`bash ~/agents/agents/${agent}.sh "${prompt}"`);
  res.json({ result: result.out || 'Задача выполнена без вывода' });
});

router.get('/run-all', async (req, res) => {
  const result = await runCmd('bash ~/phoenix_app/run_autonomous.sh');
  res.json({ result: result.out || 'Пакет задач завершён' });
});

router.get('/logs', (req, res) => {
  const files = ['autonomous.log','coder.log','guardian.log','reporter.log','scout.log'];
  let combined = '';
  files.forEach(file => {
    const p = path.join(logsDir, file);
    if (fs.existsSync(p)) combined += `--- ${file} ---\n${fs.readFileSync(p,'utf8').slice(-1500)}\n\n`;
  });
  res.json({ logs: combined || 'Логов нет' });
});

router.get('/git-status', (req, res) => {
  runCmd('cd ~/phoenix && git status --short').then(r => res.json({ result: r.out || 'Нет изменений' }));
});

router.get('/commit-push', (req, res) => {
  runCmd('cd ~/phoenix && git add -A && git commit -m "auto: update from gardener" && git push origin main').then(r => res.json({ result: r.out || 'Изменения отправлены' }));
});

module.exports = router;
