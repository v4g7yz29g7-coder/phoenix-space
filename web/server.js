// FORMULA I1 Control — визуализация эволюции
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '64kb' }));
const http = require('http');
const io = require('socket.io');

const WEB_ROOT = __dirname;
const PUBLIC_DIR = path.join(WEB_ROOT, 'public');
const PROJECT_ROOT = path.resolve(WEB_ROOT, '..');  // /home/ishidin/phoenix
const PORT = 3020;
// OLD PROJECT_ROOT: const PROJECT_ROOT = __dirname;

app.use(express.static(PUBLIC_DIR));

// === API: Leaderboard ===
// Roadmap
app.get('/api/roadmap', (req, res) => {
  const f = path.join(PROJECT_ROOT, 'arena_roadmap.json');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'no roadmap' });
  res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
});

// === NIGHT EVOLUTION ===
app.get('/night', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'night.html'));
});

app.get('/api/night', (req, res) => {
  const f = path.join(PROJECT_ROOT, 'tasks_night_pool.json');
  if (!fs.existsSync(f)) return res.json({ tasks: [] });
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    // Отдаём только нужные поля (не весь prompt)
    const tasks = (d.tasks || []).map(t => ({
      id: t.id,
      group: t.group,
      file: t.file,
      status: t.status || 'pending',
      min_lines: t.min_lines,
      result: t.result ? {
        verify: t.result.verify,
        log_tail: (t.result.log_tail || '').slice(0, 200),
      } : null,
    }));
    res.json({ tasks, total: tasks.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/board', (req, res) => {
  const f = path.join(PROJECT_ROOT, 'arena_board.json');
  if (!fs.existsSync(f)) return res.json({ tasks: {}, notes: [] });
  res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
});

// Landing
app.get('/offer', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'offer.html')));
app.get('/offer.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'offer.html')));

app.get('/landing', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
app.get('/landing.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));

// Pricing
app.get('/pricing', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pricing.html')));
app.get('/pricing.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pricing.html')));

app.get('/tasks', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tasks.html')));
app.get('/control', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'control.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));

// === RACE LIVE — трансляция гонки в реальном времени ===
app.get('/race/live', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'race_live.html')));

// === ARENA (публичная арена) ===
app.get('/arena', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'arena.html')));
app.get('/arena/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'arena.html')));
app.get('/arena/register', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'arena.html')));
app.get('/arena/my-team', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'arena_team.html')));
app.get('/arena/leaderboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'arena_leaderboard.html')));

app.get('/api/leaderboard', (req, res) => {
  try {
    const files = fs.readdirSync(path.join(PROJECT_ROOT, 'memory/patterns'))
      .filter(f => f.startsWith('race_') && f.endsWith('.json'));

    const wins = {};
    const scores = {};
    const times = {};
    const fails = {};
    const totalRaces = files.length;

    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'memory/patterns', f), 'utf8'));
      if (!d.winner) continue;
      wins[d.winner] = (wins[d.winner] || 0) + 1;

      for (const r of (d.results || [])) {
        const box = r.box;
        if (!box) continue;
        if (r.ok && r.score !== undefined && r.score !== null) {
          (scores[box] = scores[box] || []).push(r.score);
          const t = r.duration_ms || r.time || r.time_ms;
          if (t) (times[box] = times[box] || []).push(t);
        } else {
          fails[box] = (fails[box] || 0) + 1;
        }
      }
    }

    const boxes = Object.keys({ ...wins, ...scores, ...fails });
    const leaderboard = boxes.map(box => ({
      box,
      wins: wins[box] || 0,
      avgScore: scores[box] ? +(scores[box].reduce((a, b) => a + b, 0) / scores[box].length).toFixed(2) : null,
      avgTime: times[box] ? Math.round(times[box].reduce((a, b) => a + b, 0) / times[box].length) : null,
      fails: fails[box] || 0,
      totalRuns: (scores[box] ? scores[box].length : 0) + (fails[box] || 0)
    })).sort((a, b) => b.wins - a.wins);

    res.json({ totalRaces, leaderboard });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === API: Последние гонки ===
// 18.09: агрегирующий API для Dashboard
app.get('/api/dashboard/state', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  const state = { ts: new Date().toISOString() };

  // 1. Модули (evolution)
  try {
    const evoDir = path.join(PROJECT_ROOT, 'evolution');
    const mods = fs.readdirSync(evoDir)
      .filter(f => f.endsWith('.js') && !f.includes('.bak') && !f.includes('.test'))
      .map(f => ({ name: f.replace('.js', ''), file: f }));
    state.modules = { total: mods.length, list: mods };
  } catch (e) { state.modules = { total: 0, list: [] }; }

  // 2. Боксы
  try {
    const fit = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'memory', 'fitness.json'), 'utf8'));
    const agents = Object.values(fit.agents || {});
    state.agents = {
      total: agents.length,
      top: agents.sort((a,b) => b.fitness - a.fitness).slice(0, 10).map(a => ({
        box: a.box, fitness: a.fitness, runs: a.runs_total, wins: a.wins_total
      }))
    };
  } catch (e) { state.agents = { total: 0, top: [] }; }

  // 3. Пул задач
  try {
    const pool = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tasks_night_pool.json'), 'utf8'));
    const g = {};
    (pool.tasks || []).forEach(t => { const k = t.status || 'undef'; g[k] = (g[k]||0)+1; });
    state.pool = { total: (pool.tasks || []).length, byStatus: g };
  } catch (e) { state.pool = { total: 0, byStatus: {} }; }

  // 4. Последние гонки
  try {
    const racesDir = path.join(PROJECT_ROOT, 'memory', 'races');
    const files = fs.readdirSync(racesDir).filter(f => f.endsWith('.json'))
      .map(f => ({ f, m: fs.statSync(path.join(racesDir, f)).mtimeMs }))
      .sort((a,b) => b.m - a.m).slice(0, 10);
    state.races = files.map(({f}) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(racesDir, f), 'utf8'));
        return { id: r.race_id, winner: r.winner, score: r.winner_score, task: (r.task||'').slice(0, 60) };
      } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { state.races = []; }

  // 5. PM2
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 });
    const list = JSON.parse(out);
    state.pm2 = list.map(p => ({ name: p.name, status: p.pm2_env.status, cpu: p.monit.cpu, mem: p.monit.memory }));
  } catch (e) { state.pm2 = []; }

  // 6. Бюджет
  try {
    const spend = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'memory', 'daily_spend.json'), 'utf8'));
    state.budget = { date: spend.date, spent: spend.spent_usd, limit: 2 };
  } catch (e) { state.budget = { spent: 0, limit: 2 }; }

  // 7. Git
  try {
    const git = execSync('cd ' + PROJECT_ROOT + ' && git status --short', { encoding: 'utf8', timeout: 3000 });
    const lines = git.split('\n').filter(Boolean);
    state.git = { uncommitted: lines.length };
  } catch (e) { state.git = { uncommitted: 0 }; }

  res.json(state);
});

app.get('/api/races', (req, res) => {
  try {
    const dir = path.join(PROJECT_ROOT, 'memory/patterns');
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('race_') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 20);

    const races = files.map(f => {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        id: d.race_id,
        ts: d.ts,
        task: (d.task || '').slice(0, 120),
        winner: d.winner,
        winner_score: d.winner_score,
        winner_time: d.winner_time,
        results: (d.results || []).map(r => ({ box: r.box, score: r.score, time: r.duration_ms || r.time, ok: r.ok }))
      };
    });
    res.json(races);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === API: Скиллы ===
app.get('/api/skills', (req, res) => {
  try {
    const skills = fs.readdirSync(path.join(PROJECT_ROOT, 'skills'))
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, 'skills', f), 'utf8');
        const title = (content.match(/^#\s+(.+)$/m) || [, f])[1];
        const purpose = (content.match(/##\s+Purpose[\s\S]{0,200}/i) || [''])[0].replace(/##\s+Purpose\s*/i, '').trim().slice(0, 150);
        return { file: f, title: title.trim(), purpose };
      });
    res.json(skills);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === API: Боксы ===
app.get('/api/boxes', (req, res) => {
  try {
    const boxesDir = path.join(PROJECT_ROOT, 'boxes');
    const boxes = fs.readdirSync(boxesDir)
      .filter(d => d.startsWith('agent_') && fs.statSync(path.join(boxesDir, d)).isDirectory())
      .map(d => {
        const metaPath = path.join(boxesDir, d, 'BOX_META.json');
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
        const skillsCount = fs.existsSync(path.join(boxesDir, d, 'skills'))
          ? fs.readdirSync(path.join(boxesDir, d, 'skills')).filter(f => f.endsWith('.md')).length
          : 0;
        return { box: d, meta, skillsCount };
      });
    res.json(boxes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === API: Общая статистика ===
app.get('/api/stats', (req, res) => {
  try {
    const racesCount = fs.readdirSync(path.join(PROJECT_ROOT, 'memory/patterns'))
      .filter(f => f.startsWith('race_')).length;
    const skillsCount = fs.readdirSync(path.join(PROJECT_ROOT, 'skills')).filter(f => f.endsWith('.md')).length;
    const patternsCount = fs.readdirSync(path.join(PROJECT_ROOT, 'memory/patterns')).filter(f => f.endsWith('.json')).length;
    const everosSize = '—';
    res.json({ racesCount, skillsCount, patternsCount, everosSize });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// === API: Cache stats ===
app.get('/api/cache', (req, res) => {
  try {
    const logPath = path.join(PROJECT_ROOT, 'logs/usage.log');
    if (!fs.existsSync(logPath)) return res.json({ ok: false, error: 'no log' });
    
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    let totalIn = 0, totalCached = 0, count = 0;
    const recent = [];
    
    for (const line of lines.slice(-200)) {
      const inMatch = line.match(/in=(\d+)/);
      const cachedMatch = line.match(/cached=(\d+)/);
      if (inMatch && cachedMatch) {
        const t = parseInt(inMatch[1]);
        const c = parseInt(cachedMatch[1]);
        totalIn += t;
        totalCached += c;
        count++;
        if (recent.length < 10) recent.push({ in: t, cached: c, pct: t > 0 ? Math.round(c/t*100) : 0 });
      }
    }
    
    const hitRate = totalIn > 0 ? Math.round(totalCached / totalIn * 100) : 0;
    res.json({ ok: true, hitRate, totalIn, totalCached, count, recent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === 3D Arena ===
// 18.09: явная раздача assets ПЕРЕД catch-all
app.use('/3d/assets', express.static(path.join(PUBLIC_DIR, 'arena3d', 'assets')));
// 18.09: явная раздача assets ПЕРЕД catch-all
app.use('/3d/assets', express.static(path.join(PUBLIC_DIR, 'arena3d', 'assets')));
app.use('/3d', express.static(path.join(PUBLIC_DIR, 'arena3d')));
app.get('/3d/*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'arena3d', 'index.html')));

app.get('/radio', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'radio.html')));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));


// === API: Логи ===
app.get('/api/logs', (req, res) => {
  const file = (req.query.file || 'race_100').replace(/[^a-zA-Z0-9_.-]/g, '');
  const lines = Math.min(parseInt(req.query.lines) || 100, 1000);
  const logPath = path.join(PROJECT_ROOT, 'logs', file + (file.endsWith('.log') ? '' : '.log'));
  try {
    const data = fs.readFileSync(logPath, 'utf8');
    const tail = data.split('\n').slice(-lines).join('\n');
    res.type('text/plain').send(tail);
  } catch (e) {
    res.status(404).send('Log not found: ' + logPath);
  }
});

// === API: Список логов ===
app.get('/api/logs-list', (req, res) => {
  try {
    const files = fs.readdirSync(path.join(PROJECT_ROOT, 'logs'))
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const stat = fs.statSync(path.join(PROJECT_ROOT, 'logs', f));
        return { name: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

/* ========================================================================== */
/*  API: Авторизация пилотов (JWT) — ЗАДАЧА 6.1                               */
/*  register / login / me. Токен HS256 подписывается здесь, секрет — на       */
/*  сервере (env JWT_SECRET или memory/.jwt_secret). React хранит только токен. */
/* ========================================================================== */
const AUTH_USERS_FILE = path.join(PROJECT_ROOT, 'memory', 'auth_users.json');
const AUTH_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(PROJECT_ROOT, 'memory', '.jwt_secret');
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  } catch (e) {
    return 'formula-i1-dev-secret';
  }
})();
const JWT_TTL_SEC = 8 * 60 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJwt(payload, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const data =
    b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) +
    '.' +
    b64url(JSON.stringify({ iat: now, exp: now + ttlSec, ...payload }));
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest();
  return data + '.' + b64url(sig);
}
function verifyJwt(token) {
  try {
    const [h, p, s] = String(token || '').split('.');
    if (!h || !p || !s) return null;
    const expected = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(h + '.' + p).digest());
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_USERS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveUsers(users) {
  fs.mkdirSync(path.dirname(AUTH_USERS_FILE), { recursive: true });
  fs.writeFileSync(AUTH_USERS_FILE, JSON.stringify(users, null, 2));
}
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return { salt: s, hash: crypto.scryptSync(String(password), s, 64).toString('hex') };
}
function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const { hash } = hashPassword(password, rec.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt };
}

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
    return res.status(400).json({ error: 'Некорректный e-mail' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  }
  const users = loadUsers();
  const key = String(email).toLowerCase();
  if (users[key]) return res.status(409).json({ error: 'Пилот уже зарегистрирован' });
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    email: key,
    name: name || key.split('@')[0],
    salt,
    hash,
    createdAt: Date.now(),
  };
  users[key] = user;
  saveUsers(users);
  const token = signJwt({ sub: user.id, email: user.email, name: user.name }, JWT_TTL_SEC);
  res.status(201).json({ token, access_token: token, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const users = loadUsers();
  const user = users[String(email || '').toLowerCase()];
  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ error: 'Неверный e-mail или пароль' });
  }
  const token = signJwt({ sub: user.id, email: user.email, name: user.name }, JWT_TTL_SEC);
  res.json({ token, access_token: token, user: publicUser(user) });
});

app.get('/api/auth/me', (req, res) => {
  const payload = verifyJwt(bearer(req));
  if (!payload) return res.status(401).json({ error: 'Требуется действующий JWT' });
  res.json({ user: { id: payload.sub, email: payload.email, name: payload.name } });
});

app.post('/api/auth/logout', (req, res) => res.status(204).end());

// === ARENA: user models ===
const USERS_DIR = path.join(PROJECT_ROOT, 'boxes', 'users');
const MODELS_REGISTRY = path.join(PROJECT_ROOT, 'memory', 'arena_models.json');
const multer = require('multer');
const upload = multer({
  dest: '/tmp/ai1_uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB
});

function loadModels() {
  try {
    if (!fs.existsSync(MODELS_REGISTRY)) return {};
    return JSON.parse(fs.readFileSync(MODELS_REGISTRY, 'utf8'));
  } catch (e) { return {}; }
}

function saveModels(m) {
  fs.mkdirSync(path.dirname(MODELS_REGISTRY), { recursive: true });
  fs.writeFileSync(MODELS_REGISTRY, JSON.stringify(m, null, 2));
}

// GET /api/arena/my-team — мои модели + официальные AI-1
app.get('/api/arena/my-team', (req, res) => {
  const payload = verifyJwt(bearer(req));
  if (!payload) return res.status(401).json({ error: 'JWT' });
  const models = Object.values(loadModels());
  const mine = models.filter(m => m.user_id === payload.sub);
  const official = models.filter(m => m.is_official === true);
  res.json({
    user: { id: payload.sub, name: payload.name, email: payload.email },
    models: mine,
    official,
  });
});

// POST /api/arena/upload — загрузить ZIP модели
app.post('/api/arena/upload', upload.single('model'), (req, res) => {
  const payload = verifyJwt(bearer(req));
  if (!payload) return res.status(401).json({ error: 'JWT' });

  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

  const userDir = path.join(USERS_DIR, 'user_' + payload.sub);
  fs.mkdirSync(userDir, { recursive: true });

  const ts = Date.now();
  const modelId = 'model_' + ts;
  const modelDir = path.join(userDir, modelId);
  fs.mkdirSync(modelDir, { recursive: true });

  // Распаковка ZIP через unzip (или fallback — копирование как есть)
  const zipPath = req.file.path;
  let unpacked = false;
  try {
    // Fallback через Python zipfile (если unzip не установлен)
    const { execSync } = require('child_process');
    const pyScript = `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'r') as z:
    z.extractall(sys.argv[2])
print('OK')
`;
    const fs2 = require('fs');
    const tmpPy = '/tmp/_unzip_ai1.py';
    fs2.writeFileSync(tmpPy, pyScript);
    execSync('python3 ' + JSON.stringify(tmpPy) + ' ' + JSON.stringify(zipPath) + ' ' + JSON.stringify(modelDir), { timeout: 15000 });
    unpacked = true;
  } catch (e) {
    // Не ZIP — копируем как одиночный файл
    const singleFile = path.join(modelDir, req.file.originalname || 'model.bin');
    fs.copyFileSync(zipPath, singleFile);
  }
  try { fs.unlinkSync(zipPath); } catch (e) {}

  // Читаем manifest, если есть
  let manifest = { name: 'Untitled model', version: '0.0.0' };
  const manifestPath = path.join(modelDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest = Object.assign(manifest, m);
    } catch (e) {}
  }

  // Файлы внутри
  function walk(dir, base) {
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const rel = base ? base + '/' + f : f;
      const st = fs.statSync(full);
      if (st.isDirectory()) out.push(...walk(full, rel));
      else out.push({ path: rel, size: st.size });
    }
    return out;
  }
  const files = walk(modelDir, '').slice(0, 100);

  const record = {
    id: modelId,
    user_id: payload.sub,
    user_email: payload.email,
    user_name: payload.name,
    name: manifest.name || 'Untitled',
    version: manifest.version || '0.0.0',
    description: manifest.description || '',
    strategy: manifest.strategy || null,
    uploaded_at: ts,
    path: path.relative(PROJECT_ROOT, modelDir),
    files_count: files.length,
    files: files.slice(0, 20),
    status: 'ready',
  };

  const models = loadModels();
  models[modelId] = record;
  saveModels(models);

  console.log('[arena/upload]', payload.email, '→', modelId, '| files:', files.length);

  res.status(201).json({
    ok: true,
    model: record,
    unpacked,
  });
});

// POST /api/arena/race — запустить гонку с моделью
app.post('/api/arena/race', async (req, res) => {
  const payload = verifyJwt(bearer(req));
  if (!payload) return res.status(401).json({ error: 'JWT' });
  const { model_id, task } = req.body || {};
  if (!model_id) return res.status(400).json({ error: 'model_id обязателен' });

  const models = loadModels();
  const model = models[model_id];
  if (!model) return res.status(404).json({ error: 'Модель не найдена' });
  // официальные — доступны всем; пользовательские — только владельцу
  if (!model.is_official && model.user_id !== payload.sub) {
    return res.status(403).json({ error: 'Нет доступа к модели' });
  }

  try {
    const raceRunner = require(path.join(PROJECT_ROOT, 'arena', 'race_runner'));
    const result = await raceRunner.runRace({
      userId: payload.sub,
      modelId: model_id,
      task: task || undefined,
    });

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error, log_tail: result.log_tail });
    }

    // Статистику обновляем только для пользовательских моделей
    if (!model.is_official) {
      models[model_id].last_race = {
        race_id: result.race_id,
        ts: Date.now(),
        is_winner: result.is_winner,
        user_score: result.user_score,
        user_time_ms: result.user_time_ms,
      };
      models[model_id].races_count = (models[model_id].races_count || 0) + 1;
      if (result.is_winner) models[model_id].wins = (models[model_id].wins || 0) + 1;
      if (result.user_score != null) {
        const prev = models[model_id].best_score || 0;
        if (result.user_score > prev) models[model_id].best_score = result.user_score;
      }
      saveModels(models);
    }

    res.json({
      ok: true,
      race_id: result.race_id,
      winner: result.winner,
      user_score: result.user_score,
      user_time_ms: result.user_time_ms,
      is_winner: result.is_winner,
      results: result.results,
      duration_sec: result.duration_sec,
    });
  } catch (e) {
    console.error('[arena/race] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/arena/leaderboard — рейтинг пользователей
app.get('/api/arena/leaderboard', (req, res) => {
  const models = loadModels();
  const byUser = {};
  for (const m of Object.values(models)) {
    if (!byUser[m.user_id]) {
      byUser[m.user_id] = {
        user_id: m.user_id,
        user_name: m.user_name,
        user_email: m.user_email,
        models_count: 0,
        races_count: 0,
        wins: 0,
        best_score: 0,
      };
    }
    byUser[m.user_id].models_count++;
  }
  const board = Object.values(byUser).sort((a, b) => b.wins - a.wins || b.best_score - a.best_score);
  res.json({ leaderboard: board, total_users: board.length });
});


const server = http.createServer(app);
const socketIO = io(server, { cors: { origin: '*' } });

socketIO.on('connection', (socket) => {
  console.log('[socket] client connected:', socket.id);
  // Radio
  socket.on('radio:event', (data) => socketIO.emit('radio:event', data));
  socket.on('radio:command', (data) => socketIO.emit('radio:command', data));
  // 3D Arena race events — broadcast всем клиентам
  socket.on('race:start', (data) => {
    console.log('[race:start]', data.race_id, '| agents:', (data.agents || []).length);
    socketIO.emit('race:start', data);
  });
  socket.on('race:tick', (data) => socketIO.emit('race:tick', data));
  socket.on('race:finish', (data) => {
    console.log('[race:finish]', data.race_id, '| winner:', data.winner);
    socketIO.emit('race:finish', data);
  });

  // Race Live — единый канал телеметрии гонки: broadcast всем клиентам
  // Формат от race_director: { race_id, ts, type, data } (start|tick|overtake|finish)
  socket.on('race:live', (data) => {
    if (data && data.type) console.log('[race:live]', data.type, data.race_id || '');
    socketIO.emit('race:live', data);
  });

  // Флаги маршалов
  socket.on('flag:event', (data) => {
    console.log('[flag]', data.flag, data.agent || '');
    socketIO.emit('flag:event', data);
  });
});

server.listen(PORT, () => console.log('FORMULA I1 Control (with socket.io): http://localhost:' + PORT));
