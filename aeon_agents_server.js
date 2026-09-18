require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'sadovnik-secret-key-change-me';
const ADMIN_EMAIL = 'ishidin@ya.ru'; // замени на свой email


const TARIFF_LIMITS = {
  free: { projects: 1, tasks_per_day: 10 },
  pro: { projects: 5, tasks_per_day: 100 },
  business: { projects: Infinity, tasks_per_day: Infinity }
};

function getTariff(callback) {
  db.get('SELECT tariff FROM users ORDER BY id LIMIT 1', (err, row) => {
    if (err || !row) return callback('free'); // fallback
    callback(row.tariff);
  });
}


const app = express();
const PORT = 3001;
const logsDir = path.join(os.homedir(), 'agents', 'logs');
const projectsDir = path.join(os.homedir(), 'phoenix', 'generated_projects');
fs.mkdirSync(projectsDir, { recursive: true });

const db = new sqlite3.Database(path.join(os.homedir(), 'phoenix', 'gardener.db'));
// Счётчик посещений
db.run('CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');

db.serialize(() => {
  db.run('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, path TEXT, type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT "stopped", user_id INTEGER DEFAULT 0)');
  db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT, password_hash TEXT, tariff TEXT DEFAULT "free", created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  // Проверяем, есть ли колонка blocked, и добавляем только если её нет
  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) return;
    const hasBlocked = Array.isArray(columns) && columns.some(col => col.name === 'blocked');
    if (!hasBlocked) {
      db.run('ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0');
    }
  });
  db.run('INSERT INTO users (username, email, password_hash, tariff) SELECT "admin", "admin@example.com", "", "free" WHERE NOT EXISTS (SELECT 1 FROM users WHERE username="admin")');
  db.run('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, prompt TEXT, result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, user_id INTEGER DEFAULT 0)');
  db.run('CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, tariff TEXT, amount REAL, status TEXT DEFAULT "paid", created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// VPS Control auth
const VPS_CONTROL_PASSWORD = process.env.VPS_CONTROL_PASSWORD || 'change-me';
app.post('/vps-control/auth', (req,res)=>{
  const { password } = req.body;
  if (password === VPS_CONTROL_PASSWORD) res.json({ ok: true });
  else res.json({ ok: false });
});

app.post('/vps-control/process-text', async (req,res)=>{
  const { password, text } = req.body;
  if (password !== VPS_CONTROL_PASSWORD) return res.json({ error: 'Неверный пароль' });

  const allowed = [
  'pm2 status',
  'pm2 logs aeon_agents --lines 20 --nostream',
  'df -h',
  'free -h',
  'uptime',
  'pm2 restart aeon_agents',
  'pm2 restart vps_bot',
  'ls -la /home/ishidin/phoenix',
  'git -C /home/ishidin/phoenix status --short',
  'tail -n 20 /home/ishidin/phoenix/logs/error.log'
];
  // Сначала проверяем прямое совпадение
  if (allowed.includes(text)) {
    exec(text, (err, stdout, stderr)=>{
      res.json({ result: stdout || stderr || 'Готово' });
    });
    return;
  }

  // Иначе используем LLM для интерпретации
  try {
    const { askDeepSeek } = require('/home/ishidin/phoenix/llm_client');
    const systemPrompt = `Ты помощник управления VPS. Допустимые команды: ${allowed.join('; ')}. Преобразуй запрос пользователя в одну из этих команд. Если невозможно, ответь точно словом НЕВОЗМОЖНО.`;
    const userPrompt = text;
    const llmAnswer = await askDeepSeek(systemPrompt, userPrompt, 100);
    
    if (allowed.includes(llmAnswer)) {
      exec(llmAnswer, (err, stdout, stderr)=>{
        res.json({ result: stdout || stderr || 'Готово' });
      });
    } else {
      res.json({ result: 'Не удалось распознать команду. Попробуйте: ' + allowed.join(', ') });
    }
  } catch (e) {
    res.json({ error: 'Ошибка LLM: ' + e.message });
  }
});

app.post('/vps-control/exec', (req,res)=>{
  const { password, command } = req.body;
  if (password !== VPS_CONTROL_PASSWORD) return res.json({ error: 'Неверный пароль' });
  const allowed = [
  'pm2 status',
  'pm2 logs aeon_agents --lines 20 --nostream',
  'df -h',
  'free -h',
  'uptime',
  'pm2 restart aeon_agents',
  'pm2 restart vps_bot',
  'ls -la /home/ishidin/phoenix',
  'git -C /home/ishidin/phoenix status --short',
  'tail -n 20 /home/ishidin/phoenix/logs/error.log'
];
  if (!allowed.includes(command)) return res.json({ error: 'Команда не разрешена' });
  exec(command, (err, stdout, stderr)=>{
    res.json({ result: stdout || stderr || 'Готово' });
  });
});


// Логирование посещений
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/agents')) {
    db.run('INSERT INTO visits (path, user_agent) VALUES (?, ?)', [req.path, req.headers['user-agent'] || '']);
  }
  next();
});


function isAdmin(req, res, next) {
  db.get('SELECT email FROM users WHERE id = ?', [req.userId], (err, row) => {
    if (err || !row || row.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Доступ запрещён' });
    next();
  });
}


app.post('/agents/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.json({ error: 'Заполните все поля' });
  // Валидация email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.json({ error: 'Некорректный email' });
  // Валидация пароля (минимум 6 символов)
  if (password.length < 6) return res.json({ error: 'Пароль должен содержать минимум 6 символов' });

  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);
  db.run('INSERT INTO users (username, email, password_hash, tariff) VALUES (?, ?, ?, ?)', [username, email, hash, 'free'], function(err) {
    if (err) return res.json({ error: 'Пользователь уже существует или ошибка базы данных' });
    res.json({ ok: true, id: this.lastID });
  });
});

app.post('/agents/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ error: 'Введите email и пароль' });
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user) return res.json({ error: 'Неверный email или пароль' });
    if (!bcrypt.compareSync(password, user.password_hash || '')) return res.json({ error: 'Неверный email или пароль' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'lax' });
    res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email, tariff: user.tariff } });
  });
});


function authenticate(req, res, next) {
  const token = req.cookies ? req.cookies.token : null;
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Неверный токен' });
    req.userId = decoded.id;
    next();
  });
}

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.svg')));

app.use('/projects', express.static(projectsDir));

function upsertProject(name, projectPath, type, userId) {
  db.run('INSERT INTO projects (name, path, type, user_id) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET path=excluded.path, type=excluded.type, user_id=excluded.user_id', [name, projectPath, type, userId]);
}

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Aeon Agents — AI-агент для разработки</title>
<meta name="description" content="Aeon Agents — платформа AI-агентов для генерации, запуска и управления проектами.">
<meta property="og:title" content="Aeon Agents — AI-агент для разработки">
<meta property="og:description" content="Генерируйте сайты и приложения, управляйте задачами и агентами в одном месте.">
<meta property="og:type" content="website">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a12; color:#e8e4f0; font-family: 'Inter', sans-serif; }
.hero { max-width:900px; margin:0 auto; padding: 60px 20px; text-align:center; }
h1 { font-size: 42px; margin-bottom: 16px; }
.subtitle { font-size: 18px; color:#a09ab8; margin-bottom: 40px; }
.cta { display:flex; gap:16px; justify-content:center; flex-wrap:wrap; }
.btn { background:#a78bfa; color:#0a0a12; border:none; padding:14px 28px; border-radius:8px; font-size:16px; cursor:pointer; text-decoration:none; }
.btn.secondary { background:transparent; border:1px solid #555; color:#e8e4f0; }
.features { display:flex; gap:20px; flex-wrap:wrap; justify-content:center; margin-top:60px; }
.feature-card { background:#12121f; border:1px solid #333; border-radius:12px; padding:24px; max-width:260px; flex:1; min-width:200px; }
.feature-card h3 { margin-bottom:12px; }
.feature-card p { font-size:14px; color:#a09ab8; }
.pricing { margin-top:60px; display:flex; gap:16px; flex-wrap:wrap; justify-content:center; }
.price-card { background:#12121f; border:1px solid #333; border-radius:12px; padding:24px; width:220px; }
.price-card h4 { margin-bottom:8px; }
.price { font-size:28px; font-weight:bold; margin:8px 0; }
.price-card ul { list-style:none; padding:0; }
.price-card li { padding:6px 0; font-size:14px; color:#a09ab8; }
.footer { text-align:center; margin-top:60px; color:#555; font-size:13px; padding-bottom:40px; }

@media (max-width: 600px) {
  .panel { padding: 12px !important; }
  h1 { font-size: 28px !important; }
  select, textarea, input[type=text], input[type=email], input[type=password] { font-size: 16px !important; }
  button { padding: 8px 14px !important; font-size: 14px !important; }
  .row { flex-direction: column; gap: 8px !important; }
  .project-row { flex-direction: column; align-items: flex-start; gap: 6px; }
  .cards, .pricing { flex-direction: column; align-items: center; }
  .card, .price-card, .feature-card { width: 100% !important; max-width: 100% !important; }
  .hero { padding: 30px 15px !important; }
  h1 { font-size: 32px !important; }
  .subtitle { font-size: 16px !important; }
}

</style></head><body>
<div class="hero">
  <h1>🐦‍🔥 Aeon Agents</h1>
  <div class="subtitle">AI-агент, который генерирует, запускает и управляет вашими проектами.</div>
  <div class="cta">
    <a href="/agents" class="btn">Открыть панель</a>
    <a href="/agents/account" class="btn secondary">Личный кабинет</a>
  </div>

  <div class="features">
    <div class="feature-card">
      <h3>🧠 Генерация проектов</h3>
      <p>Создавайте сайты и приложения по техническому заданию в один клик.</p>
    </div>
    <div class="feature-card">
      <h3>⚙️ Управление</h3>
      <p>Запускайте, останавливайте и контролируйте свои проекты через PM2.</p>
    </div>
    <div class="feature-card">
      <h3>🤖 Мультиагентность</h3>
      <p>Четыре агента: Coder, Scout, Guardian, Reporter. Делегируйте задачи.</p>
    </div>
    <div class="feature-card">
      <h3>📊 История и аналитика</h3>
      <p>Все задачи сохраняются, лимиты контролируются тарифами.</p>
    </div>
  </div>

  <div class="pricing">
    <div class="price-card">
      <h4>Free</h4>
      <div class="price">0 ₽</div>
      <ul><li>1 проект</li><li>10 задач/день</li><li>Базовая поддержка</li></ul>
    </div>
    <div class="price-card">
      <h4>Pro</h4>
      <div class="price">500 ₽/мес</div>
      <ul><li>5 проектов</li><li>100 задач/день</li><li>Приоритет</li></ul>
    </div>
    <div class="price-card">
      <h4>Business</h4>
      <div class="price">2000 ₽/мес</div>
      <ul><li>∞ проектов</li><li>∞ задач</li><li>Выделенные ресурсы</li></ul>
    </div>
  </div>
  <div style="margin-top:20px"><a href="/agents/tariffs" style="color:#a78bfa;">Подробнее о тарифах</a> | <a href="/how-it-works" style="color:#a78bfa;">Как это работает</a></div>

  <div class="footer">Aeon Agents · от Aeon Labs</div>
</div>
</body></html>`);
});


app.get('/how-it-works', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Как это работает — Aeon Agents</title><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body{background:#0a0a12;color:#e8e4f0;font-family:Inter,sans-serif;padding:20px;margin:0}
.panel{max-width:700px;margin:0 auto;background:#12121f;border:1px solid #333;border-radius:12px;padding:30px}
h1{text-align:center;margin-bottom:20px}
.step{display:flex;gap:16px;margin-bottom:24px;align-items:flex-start}
.step-number{background:#a78bfa;color:#0a0a12;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;flex-shrink:0}
.step-content h2{margin:0 0 6px;font-size:18px}
.step-content p{font-size:14px;color:#a09ab8;margin:0}
.cta{text-align:center;margin-top:30px}
button{background:#a78bfa;color:#0a0a12;border:none;border-radius:8px;padding:12px 24px;font-size:16px;cursor:pointer}
</style></head><body>
<div class="panel">
<h1>🚀 Как это работает</h1>
<div class="step">
  <div class="step-number">1</div>
  <div class="step-content">
    <h2>Зарегистрируйтесь</h2>
    <p>Создайте аккаунт за 30 секунд — нужен только email и пароль.</p>
  </div>
</div>
<div class="step">
  <div class="step-number">2</div>
  <div class="step-content">
    <h2>Выберите тариф</h2>
    <p>Начните с Free (1 проект, 10 задач/день) или перейдите на Pro для больших возможностей.</p>
  </div>
</div>
<div class="step">
  <div class="step-number">3</div>
  <div class="step-content">
    <h2>Опишите задачу</h2>
    <p>В панели управления выберите агента (Coder, Scout, Guardian, Reporter) и введите задачу.</p>
  </div>
</div>
<div class="step">
  <div class="step-number">4</div>
  <div class="step-content">
    <h2>Получите результат</h2>
    <p>Агенты сгенерируют проект, выполнят задачу и покажут отчёт. Всё сохраняется в истории.</p>
  </div>
</div>
<div class="cta">
  <button onclick="location.href='/agents'">Перейти в панель</button>
</div>
</div>
</body></html>`);
});


app.get('/vps-control', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>VPS Control</title><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>
body{background:#0a0a12;color:#e8e4f0;font-family:Inter,sans-serif;padding:20px}
.panel{max-width:600px;margin:0 auto;background:#12121f;border:1px solid #333;border-radius:12px;padding:24px}
h1{margin:0 0 16px}
button{background:#a78bfa;color:#0a0a12;border:none;border-radius:8px;padding:10px 18px;margin:4px;cursor:pointer}
pre{background:#1a1a2e;padding:12px;border-radius:8px;white-space:pre-wrap;max-height:300px;overflow:auto}
input{width:100%;padding:10px;margin-bottom:12px;background:#1a1a2e;border:1px solid #333;border-radius:8px;color:#e8e4f0}
</style></head><body>
<div class="panel">
<h1>🖥️ VPS Control</h1>
<input type="password" id="vpsPass" placeholder="Пароль">
<button onclick="login()">Войти</button>
<button onclick="startVoice()">🎤 Голос</button>
<div id="controls" style="display:none;margin-top:20px">
  <button onclick="exec('pm2 status')">Статус PM2</button>
  <button onclick="exec('pm2 logs aeon_agents --lines 20 --nostream')">Логи Aeon Agents</button>
  <button onclick="exec('df -h')">Диск</button>
  <button onclick="exec('free -h')">Память</button>
  <button onclick="exec('uptime')">Аптайм</button>
  <div id="voiceResult" style="margin-top:12px;color:#a09ab8"></div>
<input type="text" id="manualCommand" placeholder="Или введите команду словами..." style="margin-top:12px;">
<button onclick="executeByVoice(document.getElementById('manualCommand').value)">Выполнить</button><pre id="output"></pre>
</div>
</div>
<script>
async function login(){
  var pass = document.getElementById('vpsPass').value;
  var res = await fetch('/vps-control/auth', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password: pass})});
  var data = await res.json();
  if (data.ok) {
    document.getElementById('controls').style.display = 'block';
    localStorage.setItem('vpsPass', pass);
  } else {
    alert('Неверный пароль');
  }
}
let recognition = null;
function startVoice(){
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    alert('Голосовой ввод не поддерживается этим браузером');
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'ru-RU';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = function(event) {
    const text = event.results[0][0].transcript;
    document.getElementById('voiceResult').textContent = 'Распознано: ' + text;
    // Отправляем на выполнение автоматически
    executeByVoice(text);
  };
  recognition.onerror = function(event) {
    alert('Ошибка распознавания: ' + event.error);
  };
  recognition.start();
}
function speak(text){
  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ru-RU';
    speechSynthesis.speak(utterance);
  }
}
async function executeByVoice(text){
  const pass = localStorage.getItem('vpsPass') || document.getElementById('vpsPass').value;
  const res = await fetch('/vps-control/process-text', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password: pass, text: text})});
  const data = await res.json();
  document.getElementById('output').textContent = data.result || data.error || 'Готово';
  speak(data.result || data.error || 'Готово');
}

async function exec(cmd){
  var pass = localStorage.getItem('vpsPass') || document.getElementById('vpsPass').value;
  var res = await fetch('/vps-control/exec', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password: pass, command: cmd})});
  var data = await res.json();
  document.getElementById('output').textContent = data.result || data.error || 'Готово';
}
</script>
</body></html>`);
});

app.get('/agents', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Aeon Agents — Панель управления</title>
<meta name="description" content="Панель управления Aeon Agents: задачи, проекты, агенты.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{background:#0a0a12;color:#e8e4f0;font-family:Inter,sans-serif;padding:20px;margin:0}
.panel{max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
h1{margin:0 0 8px}select,textarea,input[type=text]{width:100%;background:#12121f;color:#e8e4f0;border:1px solid #333;border-radius:8px;padding:10px;font-size:14px;box-sizing:border-box}
button{background:#a78bfa;color:#0a0a12;border:none;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer;margin-right:8px}
button.secondary{background:transparent;border:1px solid #555;color:#e8e4f0}
pre{background:#12121f;border:1px solid #333;border-radius:8px;padding:12px;white-space:pre-wrap;max-height:400px;overflow:auto;font-size:13px}
.status{color:#a09ab8;font-size:13px}.row{display:flex;gap:8px;flex-wrap:wrap}.project-row{display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);padding:10px 14px;border-radius:8px;margin-bottom:8px}
.project-name{font-weight:500}.project-actions{display:flex;gap:6px}

@media (max-width: 600px) {
  .panel { padding: 12px !important; }
  h1 { font-size: 28px !important; }
  select, textarea, input[type=text], input[type=email], input[type=password] { font-size: 16px !important; }
  button { padding: 8px 14px !important; font-size: 14px !important; }
  .row { flex-direction: column; gap: 8px !important; }
  .project-row { flex-direction: column; align-items: flex-start; gap: 6px; }
  .cards, .pricing { flex-direction: column; align-items: center; }
  .card, .price-card, .feature-card { width: 100% !important; max-width: 100% !important; }
  .hero { padding: 30px 15px !important; }
  h1 { font-size: 32px !important; }
  .subtitle { font-size: 16px !important; }
}

</style></head><body>
<div class="panel"><h1>🐦‍🔥 Aeon Agents</h1>
<div style="display:flex;align-items:center;gap:8px">
  <span id="userBadge" style="color:#a09ab8;font-size:14px"></span>
  <button id="authButton" class="secondary" onclick="handleAuthClick()">Войти</button>
</div>
<select id="agent"><option value="coder">Coder</option><option value="scout">Scout</option><option value="guardian">Guardian</option><option value="reporter">Reporter</option></select>
<textarea id="prompt" rows="3" placeholder="Опиши задачу для агента..."></textarea>
<input type="text" id="target_file" placeholder="Файл для сохранения (необязательно)">
<div class="row"><button id="submitBtn" onclick="submitTask()">Отправить задачу</button><button class="secondary" onclick="loadLogs()">Обновить логи</button><button class="secondary" onclick="gitStatus()">Git status</button><button class="secondary" onclick="commitPush()">Commit & Push</button>
<button class="secondary" onclick="location.href='/agents/account'">👤 Личный кабинет</button></div>
<div style="margin-top:12px;padding-top:12px;border-top:1px solid #333"><h3>🧱 Создание проекта по ТЗ</h3>
<select id="project_type"><option value="Лендинг">Лендинг</option><option value="Блог">Блог</option><option value="Веб-приложение">Веб-приложение</option><option value="Фото-сервис">Фото-сервис</option></select>
<textarea id="tz" rows="4" placeholder="Вставь ТЗ для сайта или приложения..."></textarea>
<div class="row" style="margin-top:8px"><button onclick="generateProject()">Создать проект</button><button class="secondary" onclick="viewProject()">Посмотреть</button><button class="secondary" onclick="saveProject()">Сохранить</button></div></div>
<div style="margin-top:12px;padding-top:12px;border-top:1px solid #333">
<h3>📝 История задач</h3>
<button class="secondary" onclick="loadTaskHistory()">Обновить историю</button>
<div id="taskHistory"></div>
</div>
<div class="status" id="status">Готов к работе.</div>
<h3>🖥️ Управление проектами</h3><div id="projectList"></div>
<h3>Последние отчёты</h3><pre id="output">Здесь появятся результаты.</pre></div>
<script>
function getHeaders() {
  return { 'Content-Type': 'application/json' };
}
async function updateAuthUI() {
  try {
    const res = await fetch('/agents/me', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      document.getElementById('userBadge').textContent = '👤 ' + data.user.username;
      document.getElementById('authButton').textContent = 'Выйти';
    } else {
      document.getElementById('userBadge').textContent = '';
      document.getElementById('authButton').textContent = 'Войти';
    }
  } catch(e) {
    document.getElementById('userBadge').textContent = '';
    document.getElementById('authButton').textContent = 'Войти';
  }
  btn.disabled = false;
  btn.textContent = 'Отправить задачу';
}
function handleAuthClick() {
  // Если нажата кнопка "Выйти", отправляем запрос на выход
  if (document.getElementById('authButton').textContent === 'Выйти') {
    fetch('/agents/logout', { method: 'POST', credentials: 'include' }).then(() => {
      location.reload();
    });
  } else {
    window.location.href = '/agents/account';
  }
}
// Перехват fetch для обработки 401
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  try {
    const response = await originalFetch(...args);
    if (!response.ok) {
      alert('Ошибка сети или сервера: ' + response.status);
    }
    return response;
  } catch(e) {
    alert('Не удалось выполнить запрос. Проверьте подключение.');
    throw e;
  }
};
window.fetch = async function(...args) {
  const response = await originalFetch(...args);
  if (response.status === 401 || response.status === 403) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    updateAuthUI();
    alert('Требуется авторизация. Войдите снова.');
    window.location.href = '/agents/account';
  }
  return response;
};

function setStatus(t){document.getElementById('status').textContent=t;}
function loadProjects(){
  var list=document.getElementById('projectList');
  if(!list) return;
  fetch('/agents/projects',{headers:getHeaders(),credentials:'include'}).then(function(r){return r.json();}).then(function(data){
    list.innerHTML='';
    var projects=data.projects||[];
    if(!projects.length){list.innerHTML='<p>Нет проектов</p>';return;}
    projects.forEach(function(p){
      var row=document.createElement('div');
      row.className='project-row';
      var name=document.createElement('span');
      name.className='project-name';
      name.textContent=p.name;
      var status=document.createElement('span');
      status.style.fontSize='12px';
      status.style.color='#888';
      status.textContent=p.status;
      var actions=document.createElement('div');
      actions.className='project-actions';
      var start=document.createElement('button');
      start.className='secondary';
      start.textContent='Запустить';
      start.onclick=function(){startProject(p.name);};
      var stop=document.createElement('button');
      stop.className='secondary';
      stop.textContent='Остановить';
      stop.onclick=function(){stopProject(p.name);};
      var open=document.createElement('button');
      open.className='secondary';
      open.textContent='Открыть';
      open.onclick=function(){window.open('/projects/'+p.name+'/index.html','_blank');};
      actions.appendChild(start);actions.appendChild(stop);actions.appendChild(open);
      row.appendChild(name);row.appendChild(status);row.appendChild(actions);
      list.appendChild(row);
    });
  }).catch(function(){list.innerHTML='<p>Ошибка загрузки проектов</p>';});
}

function loadTaskHistory(){
  var container=document.getElementById('taskHistory');
  if(!container) return;
  fetch('/agents/tasks',{headers:getHeaders(),credentials:'include'}).then(function(r){return r.json();}).then(function(data){
    container.innerHTML='';
    var tasks=data.tasks||[];
    if(!tasks.length){container.innerHTML='<p>История пуста</p>';return;}
    tasks.forEach(function(t){
      var item=document.createElement('div');
      item.style.cssText='background:rgba(255,255,255,0.03);padding:10px;border-radius:6px;margin-bottom:6px';
      var meta=document.createElement('div');
      meta.style.cssText='font-size:12px;color:#888;margin-bottom:4px';
      meta.textContent=t.agent+' · '+t.created_at;
      var prompt=document.createElement('div');
      prompt.style.cssText='font-size:13px;margin-bottom:4px';
      prompt.textContent=t.prompt;
      var result=document.createElement('div');
      result.style.cssText='font-size:12px;color:#aaa;white-space:pre-wrap;max-height:120px;overflow:auto';
      result.textContent=t.result;
      item.appendChild(meta);
      item.appendChild(prompt);
      item.appendChild(result);
      container.appendChild(item);
    });
  });
}

async function submitTask(){
  var btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Выполняется...';
  var agent=document.getElementById('agent').value;
  var prompt=document.getElementById('prompt').value.trim();
  var target=document.getElementById('target_file').value.trim();
  if(!prompt){alert('Введите задачу');return;}
  var tasks=prompt.split(';').map(function(t){return t.trim();}).filter(function(t){return t;});
  if(tasks.length===1){
    setStatus('Выполняю...');
    var res=await fetch('/agents/submit',{method:'POST',headers:getHeaders(),credentials:'include',body:JSON.stringify({agent:agent,prompt:tasks[0],target_file:target})});
    var data=await res.json();
    document.getElementById('output').textContent=data.result||'Готово';
    setStatus('Задача обработана');
  } else {
    setStatus('Выполняю '+tasks.length+' задач...');
    var combined='';
    for(var i=0;i<tasks.length;i++){
      var res2=await fetch('/agents/submit',{method:'POST',headers:getHeaders(),credentials:'include',body:JSON.stringify({agent:agent,prompt:tasks[i],target_file:target})});
      var data2=await res2.json();
      combined += '=== Задача '+(i+1)+' ===\\n'+(data2.result||'Готово')+'\\n\\n';
      document.getElementById('output').textContent=combined;
      setStatus('Выполнена '+(i+1)+' из '+tasks.length);
    }
    setStatus('Все задачи выполнены');
  }
}
async function loadLogs(){setStatus('Читаю логи...');var res=await fetch('/agents/logs');var data=await res.json();document.getElementById('output').textContent=data.logs||'Логов нет';setStatus('Логи обновлены');}
async function gitStatus(){setStatus('Проверяю git...');var res=await fetch('/agents/git-status');var data=await res.json();document.getElementById('output').textContent=data.result;setStatus('Git status получен');}
async function commitPush(){setStatus('Коммичу и пушу...');var res=await fetch('/agents/commit-push');var data=await res.json();document.getElementById('output').textContent=data.result;setStatus('Commit & Push завершены');}
updateAuthUI();
loadProjects();
loadTaskHistory();
</script></body></html>`);
});

app.get('/agents/me', authenticate, (req,res)=>{
  db.get('SELECT id, username, email, tariff, created_at FROM users WHERE id = ?', [req.userId], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Пользователь не найден' });
    res.json({ user: user });
  });
});

app.get('/agents/admin/stats', authenticate, isAdmin, (req,res)=>{
  db.all("SELECT path, COUNT(*) as count, MAX(created_at) as last_visit FROM visits GROUP BY path", (err, rows)=>{
    if (err) return res.json({error: 'Ошибка'});
    res.json({stats: rows});
  });
});

app.get('/agents/admin/users', authenticate, isAdmin, (req,res)=>{
  db.all("SELECT u.id, u.username, u.email, u.tariff, u.created_at, (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS projects_count, (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) AS tasks_count, u.blocked FROM users u", (err, rows)=>{
    if (err) return res.json({error: 'Ошибка'});
    res.json({users: rows});
  });
});

app.get('/agents/tasks', authenticate, (req,res)=>{
 db.all('SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC LIMIT 10', [req.userId], (err,rows)=>{
  if(err) return res.json({tasks:[]});
  res.json({tasks:rows});
 });
});

app.post('/agents/submit', authenticate, async (req,res)=>{
 const {agent,prompt,target_file}=req.body;
 if(!agent||!prompt) return res.json({result:'Нет агента или задачи.'});
 getTariff((tariff)=>{
   const limit = TARIFF_LIMITS[tariff].tasks_per_day;
   db.get("SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND created_at >= datetime('now','start of day')", [req.userId], async (errCount, rowCount)=>{
     if(errCount) return res.json({result:'Ошибка подсчёта задач'});
     if(rowCount.count >= limit) {
       return res.json({result:`Лимит задач на сегодня для тарифа ${tariff} исчерпан (${limit}). Обновите тариф или подождите завтра.`});
     }

     const systemPrompts = {
       coder: 'Ты — агент Coder, опытный разработчик. Отвечаешь с кодом, объяснениями и рекомендациями.',
       scout: 'Ты — агент Scout, исследователь. Анализируешь проект, даёшь отчёты и советы.',
       guardian: 'Ты — агент Guardian, специалист по безопасности. Проверяешь уязвимости и даёшь рекомендации.',
       reporter: 'Ты — агент Reporter, журналист. Готовишь сводки и отчёты.'
     };
     const systemPrompt = systemPrompts[agent] || 'Ты полезный ассистент.';
     
     try {
       const { askDeepSeek } = require('/home/ishidin/phoenix/llm_client');
       const output = await askDeepSeek(systemPrompt, prompt, target_file ? 3000 : 2000);
       db.run('INSERT INTO tasks (agent, prompt, result, user_id) VALUES (?, ?, ?, ?)', [agent, prompt, output, req.userId]);
       res.json({result:output});
     } catch (e) {
       console.error('LLM error:', e.message);
       // Фолбэк на старый bash-агент, если DeepSeek не сработал
       const cmd = target_file ? `bash ~/agents/agents/${agent}.sh "${prompt}" "${target_file}"` : `bash ~/agents/agents/${agent}.sh "${prompt}"`;
       exec(cmd,(err,stdout,stderr)=>{
         const output = stdout||stderr||'Ошибка LLM и bash-агента';
         db.run('INSERT INTO tasks (agent, prompt, result, user_id) VALUES (?, ?, ?, ?)', [agent, prompt, output, req.userId]);
         res.json({result:output});
       });
     }
   });
 });
});

app.post('/agents/payment/process', authenticate, (req, res) => {
  const { tariff, amount } = req.body;
  const allowed = ['free', 'pro', 'business'];
  if (!allowed.includes(tariff)) return res.json({ error: 'Неверный тариф' });
  const price = { free: 0, pro: 500, business: 2000 }[tariff];
  if (amount !== price) return res.json({ error: 'Неверная сумма' });

  db.run('INSERT INTO payments (user_id, tariff, amount, status) VALUES (?, ?, ?, ?)', [req.userId, tariff, price, 'paid'], function(err) {
    if (err) return res.json({ error: 'Ошибка создания платежа' });
    db.run('UPDATE users SET tariff = ? WHERE id = ?', [tariff, req.userId], function(err2) {
      if (err2) return res.json({ error: 'Ошибка обновления тарифа' });
      res.json({ ok: true, result: `Тариф ${tariff} активирован. Спасибо за оплату!` });
    });
  });
});

app.get('/agents/account/data', authenticate, (req, res) => {
  db.get('SELECT id, username, email, tariff, created_at FROM users WHERE id = ?', [req.userId], (err, user) => {
    if (err || !user) return res.json({ error: 'Пользователь не найден' });
    const tariff = user.tariff;
    const limits = TARIFF_LIMITS[tariff];
    db.get('SELECT COUNT(*) AS projects_count FROM projects WHERE user_id = ?', [req.userId], (err2, proj) => {
      db.get("SELECT COUNT(*) AS tasks_today FROM tasks WHERE user_id = ? AND created_at >= datetime('now','start of day')", [req.userId], (err3, tasksToday) => {
        db.get('SELECT COUNT(*) AS tasks_count FROM tasks WHERE user_id = ?', [req.userId], (err4, tasksTotal) => {
          db.all('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [req.userId], (err5, payments) => {
            res.json({
              user: user,
              stats: {
                projects: proj ? proj.projects_count : 0,
                tasks_total: tasksTotal ? tasksTotal.tasks_count : 0,
                tasks_today: tasksToday ? tasksToday.tasks_today : 0
              },
              limits: {
                projects: limits.projects,
                tasks_per_day: limits.tasks_per_day
              },
              payments: payments || []
            });
          });
        });
      });
    });
  });
});

app.post('/agents/account/tariff', authenticate, (req, res) => {
  const { tariff } = req.body;
  const allowed = ['free', 'pro', 'business'];
  if (!allowed.includes(tariff)) return res.json({ error: 'Неверный тариф' });
  db.run('UPDATE users SET tariff = ? WHERE id = ?', [tariff, req.userId], function(err) {
    if (err) return res.json({ error: 'Ошибка обновления тарифа' });
    res.json({ ok: true, tariff: tariff });
  });
});

app.get('/agents/tariffs', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Тарифы — Aeon Agents</title>
<meta name="description" content="Тарифы Aeon Agents: Free, Pro, Business.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>
body{background:#0a0a12;color:#e8e4f0;font-family:Inter,sans-serif;padding:20px;margin:0}
.panel{max-width:900px;margin:0 auto}
h1{text-align:center;margin-bottom:24px}
.cards{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
.card{background:#12121f;border:1px solid #333;border-radius:12px;padding:24px;flex:1;min-width:220px;max-width:280px}
.card h2{margin:0 0 8px;text-align:center}
.price{font-size:28px;font-weight:bold;text-align:center;margin:16px 0}
.limits{list-style:none;padding:0;margin:0 0 20px}
.limits li{padding:8px 0;border-bottom:1px solid #222;font-size:14px;color:#a09ab8}
button{background:#a78bfa;color:#0a0a12;border:none;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer;width:100%}
button.current{background:transparent;border:1px solid #555;color:#e8e4f0;cursor:default}
.back{display:block;text-align:center;margin-top:24px;color:#a78bfa;text-decoration:none}

@media (max-width: 600px) {
  .panel { padding: 12px !important; }
  h1 { font-size: 28px !important; }
  select, textarea, input[type=text], input[type=email], input[type=password] { font-size: 16px !important; }
  button { padding: 8px 14px !important; font-size: 14px !important; }
  .row { flex-direction: column; gap: 8px !important; }
  .project-row { flex-direction: column; align-items: flex-start; gap: 6px; }
  .cards, .pricing { flex-direction: column; align-items: center; }
  .card, .price-card, .feature-card { width: 100% !important; max-width: 100% !important; }
  .hero { padding: 30px 15px !important; }
  h1 { font-size: 32px !important; }
  .subtitle { font-size: 16px !important; }
}

</style></head><body>
<div class="panel">
<h1>💎 Тарифы Aeon Agentsа</h1>
<div class="cards">
  <div class="card">
    <h2>Free</h2>
    <div class="price">0 ₽</div>
    <ul class="limits">
      <li>Проектов: 1</li>
      <li>Задач в день: 10</li>
      <li>Базовая поддержка</li>
    </ul>
    <button onclick="selectTariff('free')">Выбрать Free</button>
  </div>
  <div class="card">
    <h2>Pro</h2>
    <div class="price">500 ₽/мес</div>
    <ul class="limits">
      <li>Проектов: 5</li>
      <li>Задач в день: 100</li>
      <li>Приоритетная генерация</li>
    </ul>
    <button onclick="selectTariff('pro')">Выбрать Pro</button>
  </div>
  <div class="card">
    <h2>Business</h2>
    <div class="price">2000 ₽/мес</div>
    <ul class="limits">
      <li>Проектов: ∞</li>
      <li>Задач в день: ∞</li>
      <li>Выделенные ресурсы</li>
    </ul>
    <button onclick="selectTariff('business')">Выбрать Business</button>
  </div>
</div>
<a class="back" href="/agents/account">← Назад в личный кабинет</a>
</div>
<script>
let authToken = ''; // больше не используется

async function loadCurrentTariff() {
  if (!authToken) return;
  try {
    var res = await fetch('/agents/account/data', {headers: {'Authorization': 'Bearer ' + authToken}});
    if (res.ok) {
      var data = await res.json();
      var current = data.user.tariff;
      document.querySelectorAll('button').forEach(function(btn) {
        if (btn.textContent.includes(current.charAt(0).toUpperCase() + current.slice(1))) {
          btn.classList.add('current');
          btn.textContent = 'Текущий тариф';
        }
      });
    }
  } catch(e) {}
}

async function selectTariff(tariff) {
  if (!authToken) {
    alert('Пожалуйста, войдите в систему');
    window.location.href = '/agents/account';
    return;
  }
  if (confirm('Перейти на тариф ' + tariff + '?')) {
    var res = await fetch('/agents/account/tariff', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+authToken},
      body:JSON.stringify({tariff: tariff})
    });
    var data = await res.json();
    if (data.ok) {
      alert('Тариф успешно изменён на ' + tariff);
      location.reload();
    } else {
      alert(data.error || 'Ошибка при смене тарифа');
    }
  }
}

loadCurrentTariff();
</script>
</body></html>`);
});


app.get('/agents/payment', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Оплата — Aeon Agents</title><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body{background:#0a0a12;color:#e8e4f0;font-family:Inter,sans-serif;padding:20px;margin:0}
.panel{max-width:600px;margin:0 auto;background:#12121f;border:1px solid #333;border-radius:12px;padding:24px}
h1{margin:0 0 20px}
.tariff-option{background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:16px;margin-bottom:12px;cursor:pointer}
.tariff-option:hover{border-color:#a78bfa}
.tariff-option h2{margin:0 0 8px}
.price{font-size:24px;font-weight:bold}
button{background:#a78bfa;color:#0a0a12;border:none;border-radius:8px;padding:12px 24px;font-size:16px;cursor:pointer;width:100%}
button:disabled{background:#555;cursor:not-allowed}
#message{margin-top:12px;color:#a09ab8}

@media (max-width: 600px) {
  .panel { padding: 12px !important; }
  h1 { font-size: 28px !important; }
  select, textarea, input[type=text], input[type=email], input[type=password] { font-size: 16px !important; }
  button { padding: 8px 14px !important; font-size: 14px !important; }
  .row { flex-direction: column; gap: 8px !important; }
  .project-row { flex-direction: column; align-items: flex-start; gap: 6px; }
  .cards, .pricing { flex-direction: column; align-items: center; }
  .card, .price-card, .feature-card { width: 100% !important; max-width: 100% !important; }
  .hero { padding: 30px 15px !important; }
  h1 { font-size: 32px !important; }
  .subtitle { font-size: 16px !important; }
}

</style></head><body>
<div class="panel">
<h1>💳 Оплата тарифа</h1>
<div id="tariffList"></div>
<button id="payButton" onclick="processPayment()" disabled>Оплатить</button>
<div id="message"></div>
<p style="margin-top:20px"><a href="/agents/account" style="color:#a78bfa;">← Назад в личный кабинет</a></p>
</div>
<script>
let selectedTariff = null;
let tariffData = {
  free: { name: 'Free', price: 0 },
  pro: { name: 'Pro', price: 500 },
  business: { name: 'Business', price: 2000 }
};

function renderTariffs() {
  const container = document.getElementById('tariffList');
  container.innerHTML = '';
  Object.keys(tariffData).forEach(key => {
    const t = tariffData[key];
    const div = document.createElement('div');
    div.className = 'tariff-option';
    div.innerHTML = '<h2>' + t.name + '</h2><div class="price">' + t.price + ' ₽/мес</div>';
    div.onclick = function() {
      selectedTariff = key;
      document.getElementById('payButton').disabled = false;
      document.querySelectorAll('.tariff-option').forEach(el => el.style.borderColor = '#333');
      div.style.borderColor = '#a78bfa';
    };
    container.appendChild(div);
  });
}

async function processPayment() {
  if (!selectedTariff) return;
  const amount = tariffData[selectedTariff].price;
  if (amount > 0) {
    if (!confirm('Имитация оплаты: спишем ' + amount + ' ₽ с вашей карты?')) return;
  }
  const res = await fetch('/agents/payment/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ tariff: selectedTariff, amount: amount })
  });
  const data = await res.json();
  document.getElementById('message').textContent = data.result || data.error || 'Готово';
  if (data.ok) {
    document.getElementById('payButton').disabled = true;
  }
}

renderTariffs();
</script>
</body></html>`);
});


app.get('/agents/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Админ-панель — Aeon Agents</title><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body{background:#0a0a12;color:#e8e4f0;font-family:Inter,sans-serif;padding:20px;margin:0}
.panel{max-width:900px;margin:0 auto}
h1{margin:0 0 20px}
table{width:100%;border-collapse:collapse;background:#12121f;border-radius:8px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #333;font-size:14px}
th{background:#1a1a2e}
button{background:#a78bfa;color:#0a0a12;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}
button.block{background:#ff5555;color:#fff}
button.unblock{background:#55aa55;color:#fff}

@media (max-width: 600px) {
  .panel { padding: 12px !important; }
  h1 { font-size: 28px !important; }
  select, textarea, input[type=text], input[type=email], input[type=password] { font-size: 16px !important; }
  button { padding: 8px 14px !important; font-size: 14px !important; }
  .row { flex-direction: column; gap: 8px !important; }
  .project-row { flex-direction: column; align-items: flex-start; gap: 6px; }
  .cards, .pricing { flex-direction: column; align-items: center; }
  .card, .price-card, .feature-card { width: 100% !important; max-width: 100% !important; }
  .hero { padding: 30px 15px !important; }
  h1 { font-size: 32px !important; }
  .subtitle { font-size: 16px !important; }
}

</style></head><body>
<div class="panel">
<h1>🛠️ Админ-панель Aeon Agents</h1>
<div id="loginBlock" style="display:none; margin-bottom:20px;">
  <input type="email" id="adminEmail" placeholder="Email" style="margin-bottom:8px; width:100%; padding:8px; background:#1a1a2e; border:1px solid #333; border-radius:6px;">
  <input type="password" id="adminPassword" placeholder="Пароль" style="margin-bottom:8px; width:100%; padding:8px; background:#1a1a2e; border:1px solid #333; border-radius:6px;">
  <button onclick="adminLogin()" style="width:100%;">Войти</button>
</div>
<div id="adminContent" style="display:none;">

<div id="statsBlock" style="margin-bottom:20px"></div>
<div id="usersTable"></div>
<p style="margin-top:20px"><a href="/agents" style="color:#a78bfa;">← Назад</a></p>
</div>
</div>
<script>
async function adminLogin() {
  var email = document.getElementById('adminEmail').value.trim();
  var password = document.getElementById('adminPassword').value;
  if (!email || !password) { alert('Введите email и пароль'); return; }
  var res = await fetch('/agents/login', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({email, password}) });
  var data = await res.json();
  if (data.error) { alert(data.error); return; }
  location.reload();
}
async function checkAdminAuth() {
  var res = await fetch('/agents/me', { credentials: 'include' });
  if (res.ok) {
    document.getElementById('loginBlock').style.display = 'none';
    document.getElementById('adminContent').style.display = 'block';
    loadStats();
    loadUsers();
  } else {
    document.getElementById('loginBlock').style.display = 'block';
    document.getElementById('adminContent').style.display = 'none';
  }
}
checkAdminAuth();
async function loadStats() {
  const res = await fetch('/agents/admin/stats', { credentials: 'include' });
  if (!res.ok) return;
  const data = await res.json();
  if (data.stats && data.stats.length) {
    let html = '<h3>Посещения</h3><table><tr><th>Страница</th><th>Количество</th><th>Последний визит</th></tr>';
    data.stats.forEach(s => {
      html += '<tr><td>' + s.path + '</td><td>' + s.count + '</td><td>' + s.last_visit + '</td></tr>';
    });
    html += '</table>';
    document.getElementById('statsBlock').innerHTML = html;
  }
}

async function loadUsers() {
  const res = await fetch('/agents/admin/users', { credentials: 'include' });
  if (!res.ok) { alert('Ошибка доступа'); return; }
  const data = await res.json();
  const container = document.getElementById('usersTable');
  let html = '<table><tr><th>ID</th><th>Username</th><th>Email</th><th>Тариф</th><th>Проекты</th><th>Задачи</th><th>Действия</th></tr>';
  data.users.forEach(u => {
    html += '<tr>' +
      '<td>' + u.id + '</td>' +
      '<td>' + u.username + '</td>' +
      '<td>' + u.email + '</td>' +
      '<td>' + u.tariff + '</td>' +
      '<td>' + u.projects_count + '</td>' +
      '<td>' + u.tasks_count + '</td>' +
      '<td>' + (u.blocked ? '<button class="unblock" onclick="toggleBlock('+u.id+', false)">Разблокировать</button>' : '<button class="block" onclick="toggleBlock('+u.id+', true)">Заблокировать</button>') + '</td>' +
      '</tr>';
  });
  html += '</table>';
  container.innerHTML = html;
}
async function toggleBlock(userId, block) {
  const res = await fetch('/agents/admin/toggle-block', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    credentials: 'include',
    body: JSON.stringify({ userId, blocked: block })
  });
  const data = await res.json();
  if (data.ok) loadStats();
loadUsers();
}
loadStats();
loadUsers();
</script>
</body></html>`);
});


app.get('/agents/account', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Личный кабинет — Aeon Agents</title>
<meta name="description" content="Личный кабинет Aeon Agents: профиль, статистика, тариф.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{background:#0a0a12;color:#e8e4f0;font-family:Inter,sans-serif;padding:20px;margin:0}
.panel{max-width:600px;margin:0 auto;background:#12121f;border:1px solid #333;border-radius:12px;padding:24px}
h1{margin:0 0 16px} .row{display:flex;gap:12px;margin-top:12px} button{background:#a78bfa;color:#0a0a12;border:none;border-radius:8px;padding:10px 18px;cursor:pointer}
button.secondary{background:transparent;border:1px solid #555;color:#e8e4f0}
.stat{font-size:14px;color:#a09ab8;margin:4px 0}
.tariff-select{margin-top:16px;padding-top:16px;border-top:1px solid #333}

@media (max-width: 600px) {
  .panel { padding: 12px !important; }
  h1 { font-size: 28px !important; }
  select, textarea, input[type=text], input[type=email], input[type=password] { font-size: 16px !important; }
  button { padding: 8px 14px !important; font-size: 14px !important; }
  .row { flex-direction: column; gap: 8px !important; }
  .project-row { flex-direction: column; align-items: flex-start; gap: 6px; }
  .cards, .pricing { flex-direction: column; align-items: center; }
  .card, .price-card, .feature-card { width: 100% !important; max-width: 100% !important; }
  .hero { padding: 30px 15px !important; }
  h1 { font-size: 32px !important; }
  .subtitle { font-size: 16px !important; }
}

</style></head><body>
<div class="panel">
<h1>👤 Личный кабинет</h1>
<div id="authBlock" style="margin-bottom:16px">
  <input type="email" id="loginEmail" placeholder="Email" style="margin-bottom:8px">
  <input type="password" id="loginPassword" placeholder="Пароль" style="margin-bottom:8px">
  <div class="row">
    <button onclick="login()">Войти</button>
<button onclick="startVoice()">🎤 Голос</button>
    <button class="secondary" onclick="register()">Регистрация</button>
  </div>
  <div id="authMessage" style="margin-top:8px;color:#a09ab8"></div>
</div>
<div id="userInfo"></div>
<div id="stats" style="margin-top:16px"></div>
<div class="tariff-select">
<label>Тариф:</label>
<select id="tariffSelect" onchange="changeTariff(this.value)">
<option value="free">Free</option><option value="pro">Pro</option><option value="business">Business</option>
</select>
</div>
<div class="row" style="margin-top:20px"><button onclick="location.href='/agents'">← Назад к Aeon Agentsу</button>
<button onclick="location.href='/agents/tariffs'" class="secondary">💎 Тарифы</button></div>
</div>
<script>
let authToken = ''; // больше не используется
fetch('/agents/me', { credentials: 'include' }).then(res => {
  if (res.ok) {
    document.getElementById('authBlock').style.display = 'none';
    loadAccount();
  } else {
    document.getElementById('userInfo').innerHTML = '<p>Пожалуйста, войдите или зарегистрируйтесь</p>';
  }
});
async function login(){
  var email = document.getElementById('loginEmail').value.trim();
  var password = document.getElementById('loginPassword').value;
  if(!email||!password){alert('Введите email и пароль');return;}
  var res = await fetch('/agents/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({email,password})});
  var data = await res.json();
  if(data.error){document.getElementById('authMessage').textContent=data.error;return;}
  document.getElementById('authBlock').style.display = 'none';
  loadAccount();
}
async function register(){
  var email = document.getElementById('loginEmail').value.trim();
  var password = document.getElementById('loginPassword').value;
  if(!email||!password){alert('Введите email и пароль');return;}
  var username = prompt('Придумайте имя пользователя:', email.split('@')[0]);
  if(!username) return;
  var res = await fetch('/agents/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,email,password})});
  var data = await res.json();
  if(data.error){document.getElementById('authMessage').textContent=data.error;return;}
  document.getElementById('authMessage').textContent='Регистрация успешна! Теперь войдите.';
}
async function loadAccount(){
  var res=await fetch('/agents/account/data',{credentials:'include'});
  var data=await res.json();
  if(data.error){alert(data.error);return;}
  document.getElementById('userInfo').innerHTML='<h2>'+data.user.username+'</h2><p class="stat">Email: '+data.user.email+'</p><p class="stat">Регистрация: '+data.user.created_at+'</p>';
document.getElementById('userInfo').innerHTML += '<button onclick="logout()" class="secondary">Выйти</button>';
  document.getElementById('stats').innerHTML='<h3>Статистика</h3>'+
    '<p class="stat">Проектов: '+data.stats.projects+' / '+data.limits.projects+'</p>'+
    '<p class="stat">Задач сегодня: '+data.stats.tasks_today+' / '+data.limits.tasks_per_day+'</p>'+
    '<p class="stat">Всего задач: '+data.stats.tasks_total+'</p>';
  if (data.payments && data.payments.length) {
    var payHtml = '<h3>Платежи</h3>';
    data.payments.forEach(function(p) {
      payHtml += '<p class="stat">'+p.created_at+' — '+p.tariff+' ('+p.amount+' ₽)</p>';
    });
    document.getElementById('stats').innerHTML += payHtml;
  }
  var payButton = document.createElement('button');
  payButton.textContent = '💳 Оплатить тариф';
  payButton.className = 'secondary';
  payButton.onclick = function() { window.location.href = '/agents/payment'; };
  document.getElementById('stats').appendChild(payButton);

  document.getElementById('tariffSelect').value=data.user.tariff;
}
async function logout(){
  await fetch('/agents/logout', { method: 'POST', credentials: 'include' });
  location.reload();
}
async function changeTariff(t){
  var res=await fetch('/agents/account/tariff',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({tariff:t})});
  var data=await res.json();
  if(data.ok){alert('Тариф обновлён до '+t);}else{alert(data.error||'Ошибка');}
}
</script>
</body></html>`);
});

app.post('/agents/generate-project', authenticate, (req,res)=>{
 const {type,tz}=req.body;
 if(!tz) return res.json({result:'Нет ТЗ'});
 getTariff((tariff)=>{
   const limit = TARIFF_LIMITS[tariff].projects;
   db.get('SELECT COUNT(*) AS count FROM projects WHERE user_id = ?', [req.userId], async (errCount, rowCount)=>{
     if(errCount) return res.json({result:'Ошибка подсчёта проектов'});
     if(rowCount.count >= limit) {
       return res.json({result:`Лимит проектов для тарифа ${tariff} исчерпан (${limit}). Обновите тариф в личном кабинете.`});
     }

     try {
       const { askDeepSeek } = require('/home/ishidin/phoenix/llm_client');
       const systemPrompt = 'Ты — агент Coder, который создаёт одностраничные сайты. Верни ТОЛЬКО HTML-код с встроенными CSS и JS. Без пояснений, без обёрток в ```html.';
       const userPrompt = `Тип: ${type}\nТехническое задание:\n${tz}\n\nСгенерируй index.html.`;
       const html = await askDeepSeek(systemPrompt, userPrompt, 4000);
       
       let finalHtml = html;
       const match = html.match(/<html[\s\S]*<\/html>/i);
       if (match) finalHtml = match[0];
       else if (html.startsWith('```html')) {
         finalHtml = html.replace(/```html/g, '').replace(/```/g, '').trim();
       }
       
       const projectName = 'gen_' + Date.now();
       const projectPath = path.join(projectsDir, projectName);
       fs.mkdirSync(projectPath, { recursive: true });
       fs.writeFileSync(path.join(projectPath, 'index.html'), finalHtml);
       upsertProject(projectName, projectPath, type, req.userId);
       res.json({ result: `Проект создан: ${projectName}`, url: `/projects/${projectName}/index.html` });
     } catch(e) {
       console.error('LLM gen error:', e.message);
       // fallback на старый генератор
       exec(`bash ~/phoenix/generate_project.sh "${type}" "${tz}"`,(err,stdout,stderr)=>{
         if(err) return res.json({result:stderr||err.message});
         const dirMatch=stdout.match(/Готово\. Файлы созданы в (.+)/);
         if(dirMatch){
           const projectPath = dirMatch[1];
           const name = path.basename(projectPath);
           upsertProject(name, projectPath, type, req.userId);
           res.json({result:`Проект создан: ${projectPath}`});
         } else {
           res.json({result:stdout||'Готово'});
         }
       });
     }
   });
 });
});

app.get('/agents/projects', authenticate, (req,res)=>{
 db.all('SELECT * FROM projects ORDER BY created_at DESC',(err,rows)=>{
  if(err) return res.json({projects:[]});
  res.json({projects:rows});
 });
});

app.post('/agents/start-project',(req,res)=>{
 const name=req.body.name;
 if(!name) return res.json({result:'Нет имени'});
 const projectPath=path.join(projectsDir,name,'server.js');
 exec(`pm2 start ${projectPath} --name ${name}`,(err,stdout,stderr)=>{
  if(err) return res.json({result:stderr||err.message});
  db.run('UPDATE projects SET status=? WHERE name=?',['running',name]);
  res.json({result:stdout||'Запущен'});
 });
});

app.post('/agents/stop-project',(req,res)=>{
 const name=req.body.name;
 if(!name) return res.json({result:'Нет имени'});
 exec(`pm2 delete ${name}`,(err,stdout,stderr)=>{
  if(err) return res.json({result:stderr||err.message});
  db.run('UPDATE projects SET status=? WHERE name=?',['stopped',name]);
  res.json({result:stdout||'Остановлен'});
 });
});

app.get('/agents/logs',(req,res)=>{
 const files=['autonomous.log','coder.log','guardian.log','reporter.log','scout.log'];
 let combined='';
 files.forEach(file=>{
  const p=path.join(logsDir,file);
  if(fs.existsSync(p)) combined += '--- '+file+' ---\n'+fs.readFileSync(p,'utf8').slice(-1500)+'\n\n';
 });
 res.json({logs:combined||'Логов нет'});
});

app.post('/agents/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.post('/agents/admin/toggle-block', authenticate, isAdmin, (req,res)=>{
  const { userId, blocked } = req.body;
  if (!userId) return res.json({error: 'Нет userId'});
  db.run('UPDATE users SET blocked = ? WHERE id = ?', [blocked ? 1 : 0, userId], function(err){
    if (err) return res.json({error: 'Ошибка обновления'});
    res.json({ok: true});
  });
});

app.get('/agents/git-status',(req,res)=>{
 exec('cd ~/phoenix && git status --short',(err,stdout)=>res.json({result:stdout||'Нет изменений'}));
});

app.get('/agents/commit-push',(req,res)=>{
 exec('cd ~/phoenix && git add -A && git commit -m "auto: update from gardener" && git push origin main',(err,stdout,stderr)=>res.json({result:stdout||stderr||'OK'}));
});

// Логирование ошибок в файл
process.on('uncaughtException', (err) => {
  require('fs').appendFileSync('/home/ishidin/phoenix/logs/error.log', new Date().toISOString() + ' Uncaught: ' + err.stack + '\n');
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  require('fs').appendFileSync('/home/ishidin/phoenix/logs/error.log', new Date().toISOString() + ' Rejection: ' + reason + '\n');
});

const tools = require('./agent_tools');

function checkVpsAuth(req, res) {
  if (req.body.password !== process.env.VPS_CONTROL_PASSWORD) {
    res.json({ error: 'Wrong password' });
    return false;
  }
  return true;
}

app.post('/agent/read', (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  res.json(tools.readFile(req.body.path));
});

app.post('/agent/write', (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  res.json(tools.writeFile(req.body.path, req.body.content));
});

app.post('/agent/edit', (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  res.json(tools.editFile(req.body.path, req.body.old, req.body.new));
});

app.post('/agent/exec', async (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  res.json(await tools.runCommand(req.body.cmd));
});

app.post('/agent/commit', async (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  res.json(await tools.gitCommit(req.body.message || 'auto commit'));
});

app.post('/agent/think', async (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  const prompt = req.body.prompt;
  const MAX_STEPS = 5;
  try {
    const askDeepSeekChat = require('./llm_client').askDeepSeekChat;
    const sys = 'You are Aeon. Tools: read(path), write(path,content), edit(path,old,new), exec(cmd), commit(message). Reply with ONE JSON object only: {"tool":"read","args":{"path":"..."},"reason":"..."} or {"tool":"done","answer":"final"}. After each result call next tool or return done.';
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: prompt }
    ];
    const log = [];
    for (let step = 0; step < MAX_STEPS; step++) {
      const answer = await askDeepSeekChat(messages, 1500);
      let parsed = null;
      const cleaned = answer.split('```json').join('').split('```').join('').trim();
      let depth = 0, start = -1;
      for (let k = 0; k < cleaned.length; k++) {
        if (cleaned[k] === '{') { if (depth === 0) start = k; depth++; }
        else if (cleaned[k] === '}') {
          depth--;
          if (depth === 0 && start !== -1) {
            try { parsed = JSON.parse(cleaned.slice(start, k + 1)); } catch(e) {}
            break;
          }
        }
      }
      if (!parsed) return res.json({ ok: false, step: step, raw: answer, error: 'No valid JSON' });
      log.push({ step: step, tool: parsed.tool, reason: parsed.reason });
      if (parsed.tool === 'done') {
        const changedTools = log.filter(s => ['write','edit','patch'].includes(s.tool));
        if (changedTools.length > 0) {
          try { await tools.gitCommit('auto: agent self-edit via /agent/think'); } catch(e) {}

          const today = new Date().toISOString().split('T')[0];
          const memFile = 'memory/' + today + '.md';
          const time = new Date().toISOString().split('T')[1].slice(0,8);
          let memLog = '';
          try { memLog = require('fs').readFileSync('/home/ishidin/phoenix/' + memFile, 'utf8'); }
          catch(e) { memLog = '# ' + today + '\n\n'; }
          memLog += '## [' + time + '] Auto self-edit\n';
          memLog += '- Prompt: ' + prompt.slice(0, 200) + '\n';
          memLog += '- Changes:\n';
          for (const s of changedTools) {
            memLog += '  - ' + s.tool + ': ' + (s.reason || '').slice(0, 120) + '\n';
          }
          memLog += '- Answer: ' + (parsed.answer || '').slice(0, 200) + '\n\n';
          try {
            require('fs').writeFileSync('/home/ishidin/phoenix/' + memFile, memLog);
          } catch(e) {}
        }
        return res.json({ ok: true, answer: parsed.answer, steps: log });
      }
      const a = parsed.args || {};
      let result;
      if (parsed.tool === 'read') result = tools.readFile(a.path);
      else if (parsed.tool === 'write') result = tools.writeFile(a.path, a.content);
      else if (parsed.tool === 'edit') result = tools.editFile(a.path, a.old, a.new);
      else if (parsed.tool === 'exec') result = await tools.runCommand(a.cmd);
      else if (parsed.tool === 'commit') result = await tools.gitCommit(a.message);
      else result = { error: 'Unknown tool: ' + parsed.tool };
      messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
      messages.push({ role: 'user', content: 'RESULT of ' + parsed.tool + ': ' + JSON.stringify(result).slice(0, 4000) + ' | Next tool or done.' });
    }
    return res.json({ ok: false, error: 'Max steps', steps: log });
  } catch (e) { res.json({ error: e.message }); }
});


app.post('/agent/think-v2', async (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  const prompt = req.body.prompt;
  try {
    const agentV2 = require('./agent_responses');
    const result = await agentV2.runAgent(prompt);
    if (result.ok) {
      const changed = (result.steps || []).filter(s => ['write','edit'].includes(s.tool) && s.ok);
      await agentV2.commitAndLog(prompt, changed, result.answer);
    }
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


app.post('/agent/think-v3', async (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  const prompt = req.body.prompt;
  try {
    const loopV3 = require('./agent_loop_v3');
    const result = await loopV3.runWithCritic(prompt);

    // Собираем все изменения из всех попыток (даже отклонённых)
    const allSteps = (result.attempts || []).flatMap(a => (a.executor && a.executor.steps) || []);
    const changed = allSteps.filter(s => ['write','edit'].includes(s.tool) && s.ok);

    // Пишем паттерн (файловая память)
    const pilot = require('./agent_pilot');
    await pilot.sleepProtocol(prompt, result, changed);

    // Пишем в EverOS (семантическая память)
    try {
      const everos = require('./everos_client');
      await everos.recordTask(prompt, result, result.critic);
    } catch (e) {
      console.error('EverOS record failed:', e.message);
    }

    // Коммит только если были изменения
    if (changed.length > 0) {
      const agentV2 = require('./agent_responses');
      await agentV2.commitAndLog(prompt, changed, result.answer || '(rejected)');
    }

    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


app.post('/agent/team', async (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  const goal = req.body.goal;
  if (!goal) return res.json({ error: 'goal required' });
  try {
    const pilot = require('./agent_pilot');
    const result = await pilot.runPilot(goal);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


// ============================================================================
//  EVOLUTION LOOP: Prophet → Architect → apply (dry-run by default)
// ============================================================================
app.post('/agent/evolve', async (req, res) => {
  if (!checkVpsAuth(req, res)) return;
  const { goal, dryRun } = req.body;
  try {
    const prophet = require('./agent_prophet');
    const architect = require('./agent_architect');

    const analysis = await prophet.analyze(goal);
    if (!analysis.ok) return res.json(analysis);

    const plan = await architect.planChanges(analysis.analysis.insights || [], {
      patterns_count: analysis.patterns_count,
      goal: goal
    });

    const applied = await architect.applyChange(plan, dryRun !== false);
    res.json({ ok: true, prophet: analysis.analysis, architect_plan: plan, applied });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


// Phoenix API — пользовательские задачи (non-blocking через child_process)
app.post('/api/phoenix/task', async (req, res) => {
  const { task, user_id } = req.body;
  if (!task) return res.json({ error: 'task required' });

  const { spawn } = require('child_process');
  const child = spawn('node', ['smart_race.js', task], {
    cwd: '/home/ishidin/phoenix',
    env: { ...process.env }
  });

  let out = '';
  let err = '';
  const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 300000);

  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });

  child.on('close', (code) => {
    clearTimeout(killTimer);

    // Извлекаем JSON из вывода: от первой { до последней }
    let parsed = null;
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try { parsed = JSON.parse(out.slice(start, end + 1)); } catch (e) {}
    }

    if (parsed) {
      res.json({
        ok: true,
        task: task.slice(0, 200),
        source: parsed.source,
        answer: parsed.answer,
        box: parsed.box,
        score: parsed.score,
        race_id: parsed.race_id,
        error: parsed.error || null
      });
    } else {
      res.json({ ok: false, error: err || 'parse failed', raw: out.slice(-500), code });
    }
  });
});


// === RADIO: Socket.IO ===
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
global.radioIO = io;

io.on('connection', (socket) => {
  console.log('📻 Радио: клиент подключён ' + socket.id);
  socket.join('radio');
  socket.on('radio:command', (data) => {
    console.log('📻 Команда:', JSON.stringify(data));
    io.to('radio').emit('radio:event', Object.assign({}, data, { ts: Date.now() }));
  });
  socket.on('disconnect', () => console.log('📻 Радио: отключён ' + socket.id));
});

// Заменяем app.listen на httpServer.listen
httpServer.listen(PORT, () => console.log("Aeon Agents + Radio на " + PORT));
