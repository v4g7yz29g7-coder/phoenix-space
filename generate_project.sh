#!/bin/bash
TYPE="$1"
TZ="$2"
NAME="$3"
[ -z "$TZ" ] && { echo "Нет ТЗ"; exit 1; }
if [ -z "$NAME" ]; then
  NAME=$(echo "$TZ" | grep -oP '(?<=Название: )\S+' | head -1 | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_')
fi
[ -z "$NAME" ] && NAME="project_$(date +%Y%m%d_%H%M%S)"
PROJECT_DIR=/home/ishidin/phoenix/generated_projects/$NAME
if [ -d "$PROJECT_DIR" ]; then
  i=1
  while [ -d "${PROJECT_DIR}_v${i}" ]; do i=$((i+1)); done
  PROJECT_DIR="${PROJECT_DIR}_v${i}"
fi
mkdir -p "$PROJECT_DIR"

# Универсальный генератор: создаём index.html с ТЗ, style.css, app.js
cat > "$PROJECT_DIR/index.html" <<HTMLEOF
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>$NAME</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <header class="site-header">
      <a href="index.html" class="logo">$NAME</a>
      <nav><a href="index.html">Главная</a><a href="about.html">О нас</a><a href="contact.html">Контакты</a></nav>
    </header>
    <main class="content">
      <h1>$TZ</h1>
      <p>Это автоматически сгенерированный проект Садовником.</p>
    </main>
    <footer class="site-footer">© 2026 $NAME</footer>
  </div>
  <script src="app.js"></script>
</body>
</html>
HTMLEOF

cat > "$PROJECT_DIR/style.css" <<'CSSEOF'
body{background:#0a0a12;color:#f0eef8;font-family:Inter,sans-serif;margin:0}#app{max-width:1100px;margin:0 auto;padding:24px}.site-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:40px}.logo{font-size:1.6rem;font-weight:700;color:#a78bfa;text-decoration:none}.content h1{font-size:2rem;margin-bottom:16px}.site-footer{margin-top:60px;text-align:center;color:#888}
CSSEOF

cat > "$PROJECT_DIR/app.js" <<'JSEOF'
document.addEventListener('DOMContentLoaded', function() {
  console.log('Проект ' + document.title + ' готов');
});
JSEOF

cat > "$PROJECT_DIR/server.js" <<'SRVEOF'
const express=require('express');const path=require('path');const app=express();const PORT=process.env.PORT||3003;app.use(express.static(__dirname));app.listen(PORT,()=>console.log('Server on '+PORT));
SRVEOF
cat > "$PROJECT_DIR/package.json" <<'PKGEOF'
{"name":"generated","version":"1.0.0","main":"server.js","dependencies":{"express":"^4.18.2"}}
PKGEOF

echo "Готово. Файлы созданы в $PROJECT_DIR"
