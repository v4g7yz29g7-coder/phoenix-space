// upload_server.js — временный HTTP endpoint для загрузки файлов
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9999;
const DEST = path.join(__dirname, 'corpus', 'architect', 'raw');

if (!fs.existsSync(DEST)) fs.mkdirSync(DEST, { recursive: true });

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Upload</title>
<style>body{font-family:sans-serif;padding:40px;background:#0a0e17;color:#e0e6f0}
input,button{margin:10px 0;padding:10px;font-size:16px;background:#1a2030;color:#e0e6f0;border:1px solid #a855f7;border-radius:6px}
button{background:#a855f7;cursor:pointer}pre{background:#1a2030;padding:10px;border-radius:6px}</style></head>
<body><h1>📥 Upload в corpus/architect/raw/</h1>
<form method="POST" enctype="multipart/form-data">
<input type="file" name="files" multiple><br>
<button type="submit">Загрузить</button>
</form>
<pre id="out"></pre>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }
  if (req.method === 'POST' && req.url === '/') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const boundary = req.headers['content-type'].split('boundary=')[1];
      const parts = buf.toString('binary').split('--' + boundary);
      const saved = [];
      for (const part of parts) {
        const m = part.match(/filename="([^"]+)"/);
        if (!m) continue;
        const fname = m[1];
        const dataStart = part.indexOf('\r\n\r\n') + 4;
        const dataEnd = part.lastIndexOf('\r\n');
        const data = Buffer.from(part.slice(dataStart, dataEnd), 'binary');
        const target = path.join(DEST, path.basename(fname));
        fs.writeFileSync(target, data);
        saved.push(`${fname} (${data.length} bytes)`);
        console.log('✅ Saved:', target);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<pre>✅ Загружено:\n${saved.join('\n')}\n\n<a href="/">Назад</a></pre>`);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`📥 Upload server: http://0.0.0.0:${PORT}/`);
  console.log(`   Открой в браузере: http://89.169.166.129:${PORT}/`);
});
