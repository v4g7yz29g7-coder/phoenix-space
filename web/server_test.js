// Aeon Arena Dashboard — визуализация эволюции
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const http = require('http');
const io = require('socket.io');

const WEB_ROOT = __dirname;
const PUBLIC_DIR = path.join(WEB_ROOT, 'public');
const PROJECT_ROOT = path.resolve(WEB_ROOT, '..');  // /home/ishidin/phoenix
const PORT = 3021;
// OLD PROJECT_ROOT: const PROJECT_ROOT = __dirname;

app.use(express.static(PUBLIC_DIR));

// === API: Leaderboard ===
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

const server = http.createServer(app);
const socketIO = io(server, { cors: { origin: '*' } });

socketIO.on('connection', (socket) => {
  console.log('[socket] client connected:', socket.id);
  socket.on('radio:event', (data) => {
    socketIO.emit('radio:event', data);
  });
  socket.on('radio:command', (data) => {
    socketIO.emit('radio:command', data);
  });
});

server.listen(PORT, () => console.log('Aeon Arena Dashboard (with socket.io): http://localhost:' + PORT));
