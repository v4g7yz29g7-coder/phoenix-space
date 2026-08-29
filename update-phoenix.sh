#!/bin/bash
# Полный редизайн Феникса — Премиум UI
set -e

echo "🐦‍🔥 Начинаем обновление до премиум-уровня..."

# 1. Единый CSS
cat > /home/ishidin/phoenix/public/css/app.css << 'EOF'
/* ===== ФЕНИКС · ПРЕМИУМ UI (Mobile First) ===== */
:root {
  --bg: #08080f;
  --surface: rgba(255,255,255,0.04);
  --border: rgba(255,255,255,0.06);
  --text: #e8e4f0;
  --muted: #88839a;
  --violet: #a78bfa;
  --gold: #fbbf24;
  --radius-lg: 20px;
  --radius: 14px;
  --radius-sm: 10px;
  --font: 'Inter', system-ui, -apple-system, sans-serif;
  --gradient: linear-gradient(135deg, #a78bfa, #c084fc, #e9b84c);
  --safe-bottom: env(safe-area-inset-bottom, 16px);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body { width: 100%; overflow-x: hidden; background: var(--bg); }

body {
  font-family: var(--font);
  color: var(--text);
  min-height: 100vh; min-height: 100dvh;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  text-align: center;
  padding: 20px 20px calc(20px + var(--safe-bottom));
  -webkit-font-smoothing: antialiased;
}

/* ========== ГЛАВНАЯ ========== */
.home-garden { width: 100%; max-width: 400px; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; }
.home-title { font-size: 28px; font-weight: 500; letter-spacing: -0.03em; line-height: 1.15; background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.home-subtitle { font-size: 15px; color: var(--muted); margin-top: -12px; }
.halls-grid { display: flex; flex-direction: column; gap: 10px; }
.hall-card { background: var(--surface); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px 20px; cursor: pointer; transition: border-color 0.2s, background 0.2s, transform 0.15s; }
.hall-card:active { transform: scale(0.98); background: rgba(255,255,255,0.06); }
.hall-card h2 { font-size: 17px; font-weight: 500; margin-bottom: 4px; background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.hall-card p { font-size: 13px; color: var(--muted); line-height: 1.4; }

/* ========== СТРАНИЦЫ (общие) ========== */
.page { display: none; min-height: 100vh; min-height: 100dvh; flex-direction: column; align-items: center; justify-content: flex-start; padding: 24px 20px calc(24px + var(--safe-bottom)); width: 100%; max-width: 500px; margin: 0 auto; }
.page.active { display: flex; }
.page h1 { font-size: 24px; font-weight: 500; letter-spacing: -0.02em; background: var(--gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 4px; }
.page-sub { font-size: 14px; color: var(--muted); margin-bottom: 20px; }
.back-link { position: fixed; top: 16px; left: 16px; z-index: 100; color: var(--muted); font-size: 14px; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; cursor: pointer; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); transition: color 0.2s, background 0.2s; }
.back-link:hover { color: var(--violet); background: rgba(255,255,255,0.06); }

/* ========== ТАБЫ (Академия / О проекте / Соратник) ========== */
.tab-bar { display: flex; gap: 8px; margin-bottom: 20px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding: 0 4px; }
.tab-bar::-webkit-scrollbar { display: none; }
.tab-btn { flex: 0 0 auto; padding: 8px 18px; border-radius: 100px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: all 0.25s ease; font-family: var(--font); }
.tab-btn.active { background: rgba(167,139,250,0.12); border-color: var(--violet); color: var(--violet); }

/* ========== КАРТОЧКИ (Сутры / Практики / Артефакты) ========== */
.sutra-card, .artifact-item, .friend-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px 18px; text-align: left; cursor: pointer; transition: border-color 0.2s, background 0.2s; margin-bottom: 8px; }
.sutra-card:hover, .artifact-item:hover, .friend-card:hover { border-color: var(--violet); }
.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.card-header h3 { font-size: 15px; font-weight: 500; color: var(--text); margin: 0; }
.card-arrow { font-size: 12px; color: var(--muted); transition: transform 0.35s ease; }
.card-body { max-height: 0; overflow: hidden; transition: max-height 0.45s ease, margin-top 0.45s ease, padding-top 0.45s ease, border-top 0.45s ease; margin-top: 0; padding-top: 0; border-top: none; }
.card-body.open { max-height: 3000px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 14px; line-height: 1.6; }

/* ========== МАСТЕРСКАЯ ========== */
.workshop-create textarea, .workshop-create input[type="text"] { width: 100%; padding: 14px 16px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 14px; font-family: var(--font); transition: border-color 0.2s; }
.workshop-create textarea:focus, .workshop-create input:focus { outline: none; border-color: var(--violet); }
.btn-primary { padding: 14px 20px; border-radius: var(--radius); border: none; background: var(--gradient); color: #08080f; font-weight: 600; font-size: 15px; cursor: pointer; font-family: var(--font); width: 100%; transition: opacity 0.2s, transform 0.15s; }
.btn-primary:active { opacity: 0.85; transform: scale(0.98); }
.btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 12px 16px; border-radius: var(--radius); font-size: 13px; cursor: pointer; font-family: var(--font); transition: border-color 0.2s, color 0.2s; }
.btn-secondary:hover { border-color: var(--violet); color: var(--violet); }
.artifact-info { flex: 1; text-align: left; min-width: 0; }
.artifact-info .name { font-size: 14px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.artifact-info .date { font-size: 11px; color: var(--muted); margin-top: 2px; }
.icon-btn { background: none; border: none; color: var(--muted); font-size: 18px; cursor: pointer; padding: 6px; border-radius: 8px; transition: color 0.2s, background 0.2s; }
.icon-btn:hover { color: var(--violet); background: rgba(255,255,255,0.05); }

/* ========== ПУСТЫЕ СОСТОЯНИЯ (Empty States) ========== */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 20px; color: var(--muted); gap: 8px; }
.empty-state .empty-icon { font-size: 48px; opacity: 0.5; margin-bottom: 8px; }
.empty-state .empty-title { font-size: 15px; color: var(--text); font-weight: 500; }
.empty-state .empty-desc { font-size: 13px; line-height: 1.5; max-width: 260px; }

/* ========== СКЕЛЕТОНЫ (Skeleton Screens) ========== */
.skeleton { background: linear-gradient(90deg, var(--surface) 25%, rgba(255,255,255,0.02) 50%, var(--surface) 75%); background-size: 200% 100%; animation: skeleton-loading 1.5s infinite; border-radius: var(--radius-sm); }
.skeleton-text { height: 14px; margin-bottom: 8px; width: 100%; }
.skeleton-text.short { width: 60%; }
.skeleton-card { height: 60px; margin-bottom: 8px; border-radius: var(--radius); }
@keyframes skeleton-loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ========== ПРОФИЛЬ ========== */
.profile-container { width: 100%; max-width: 400px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; align-items: center; }
.profile-avatar { width: 72px; height: 72px; border-radius: 50%; background: var(--gradient); display: flex; align-items: center; justify-content: center; font-size: 28px; color: #0a0a14; margin-bottom: 8px; }
.profile-name { font-size: 20px; font-weight: 500; }
.profile-did { font-size: 11px; color: var(--muted); word-break: break-all; }
.profile-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px 20px; width: 100%; text-align: left; }
.profile-card h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 10px; }
.profile-stat { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
.profile-stat:last-child { border-bottom: none; }
.profile-stat .label { color: var(--muted); }
.profile-stat .value { font-weight: 500; }

/* ========== ЖИВОЕ ПОЛЕ ========== */
#living-field { position: fixed; bottom: 20px; right: 20px; z-index: 9999; cursor: pointer; text-align: center; }
#phoenix-pulsar { width: 14px; height: 14px; border-radius: 50%; background: var(--gradient); animation: breathe 3s ease-in-out infinite; }
#phoenix-pulsar.active { background: var(--gold); box-shadow: 0 0 20px rgba(251,191,36,0.7); }
@keyframes breathe { 0%, 100% { opacity: 0.5; transform: scale(1); } 50% { opacity: 1; transform: scale(1.06); } }
#living-field span { display: block; font-size: 9px; color: var(--muted); letter-spacing: 1.5px; margin-top: 4px; }

/* ========== О ПРОЕКТЕ (ссылка) ========== */
#about-link { position: fixed; bottom: 20px; left: 20px; font-size: 11px; color: var(--muted); text-decoration: none; opacity: 0.6; z-index: 9999; transition: opacity 0.2s, color 0.2s; }
#about-link:hover { opacity: 1; color: var(--violet); }

/* ========== ЯЗЫКОВОЙ ПЕРЕКЛЮЧАТЕЛЬ ========== */
#lang-switcher { position: fixed; top: 16px; right: 16px; display: flex; align-items: center; gap: 12px; z-index: 200; }
#lang-btn { display: flex; align-items: center; gap: 6px; background: var(--surface); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--border); border-radius: 100px; padding: 8px 14px; color: var(--text); font-size: 13px; cursor: pointer; font-family: var(--font); }
#lang-dropdown { display: none; position: absolute; top: calc(100% + 6px); right: 0; background: #12121f; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; min-width: 170px; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
.lang-option { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 14px; border: none; background: transparent; color: var(--muted); font-size: 13px; cursor: pointer; border-radius: 12px; font-family: var(--font); text-align: left; transition: background 0.15s, color 0.15s; }
.lang-option:hover { background: rgba(255,255,255,0.04); color: var(--text); }
#profile-link { font-size: 18px; text-decoration: none; opacity: 0.7; transition: opacity 0.2s; }
#profile-link:hover { opacity: 1; }

/* ========== ДЕСКТОП ========== */
@media (min-width: 768px) {
  body { padding: 0; }
  .halls-grid { flex-direction: row; flex-wrap: wrap; justify-content: center; gap: 14px; }
  .hall-card { width: 200px; }
  .hall-card:hover { border-color: var(--violet); background: rgba(167,139,250,0.05); transform: translateY(-2px); }
}
EOF

# 2. Новый index.html (чистая структура)
cat > /home/ishidin/phoenix/public/index.html << 'EOF'
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <title>Феникс — Пространство пробуждения</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <div id="home-page" class="page active"><div class="home-garden"><h1 class="home-title">Привет, Архитектор</h1><p class="home-subtitle">🐦‍🔥 Пространство пробуждения</p><div class="halls-grid" id="halls-container"></div></div></div>
  <div id="academy-page" class="page"><span class="back-link" onclick="showPage('home')">← Назад</span><h1>📜 Академия</h1><p class="page-sub">Войди в свою глубину</p><div id="academy-content" class="content-box"></div></div>
  <div id="workshop-page" class="page"><span class="back-link" onclick="showPage('home')">← Назад</span><h1>🛠️ Мастерская</h1><p class="page-sub">Твори свои артефакты</p><div id="workshop-content" class="content-box"></div></div>
  <div id="companion-page" class="page"><span class="back-link" onclick="showPage('home')">← Назад</span><h1>🤝 Соратник</h1><p class="page-sub">Диалог, дружба, сеть</p><div id="companion-content" class="content-box"></div></div>
  <div id="about-page" class="page"><span class="back-link" onclick="showPage('home')">← Назад</span><h1>🐦‍🔥 О проекте</h1><div id="about-content" class="content-box"></div></div>
  <a href="#" id="about-link" onclick="showPage('about');return false">🐦‍🔥 О проекте</a>
  <div id="lang-switcher"><div style="position:relative"><button id="lang-btn" onclick="toggleLangDropdown(event)"></button><div id="lang-dropdown"></div></div><a href="/profile.html" id="profile-link" title="Профиль">👤</a></div>
  <script src="/js/living-field.js"></script>
  <script src="/js/app.js"></script>
  <script src="/js/academy.js"></script>
  <script src="/js/workshop.js"></script>
  <script src="/js/companion.js"></script>
  <script src="/js/about.js"></script>
</body>
</html>
EOF

# 3. app.js (ядро навигации)
cat > /home/ishidin/phoenix/public/js/app.js << 'EOF'
var LANGS=[{code:'ru',label:'Русский',file:'ru.svg'},{code:'en',label:'English',file:'en.svg'},{code:'es',label:'Español',file:'es.svg'},{code:'de',label:'Deutsch',file:'de.svg'},{code:'fr',label:'Français',file:'fr.svg'},{code:'zh',label:'中文',file:'zh.svg'},{code:'hi',label:'हिन्दी',file:'hi.svg'},{code:'ar',label:'العربية',file:'ar.svg'},{code:'pt',label:'Português',file:'pt.svg'}];
var currentLang=localStorage.getItem('phoenix_lang')||'ru';
function flagImg(f){return'<img src="/flags/'+f+'" width="20" height="13" style="vertical-align:middle;border-radius:2px;opacity:0.85" alt="">';}
function updateLangBtn(){var l=LANGS.find(function(x){return x.code===currentLang});var b=document.getElementById('lang-btn');if(b)b.innerHTML=flagImg(l.file)+' <span style="vertical-align:middle;font-weight:500">'+l.code.toUpperCase()+'</span>';}
function toggleLangDropdown(e){e.stopPropagation();var dd=document.getElementById('lang-dropdown');if(dd.style.display==='block'){dd.style.display='none';return;}dd.innerHTML='';LANGS.forEach(function(l){var it=document.createElement('button');it.className='lang-option'+(l.code===currentLang?' active':'');it.innerHTML=flagImg(l.file)+' '+l.label;it.onclick=function(){currentLang=l.code;localStorage.setItem('phoenix_lang',currentLang);updateLangBtn();dd.style.display='none';};dd.appendChild(it);});dd.style.display='block';}
document.addEventListener('click',function(){var dd=document.getElementById('lang-dropdown');if(dd)dd.style.display='none';});
function showPage(n){document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active')});var pg=document.getElementById(n+'-page');if(pg){pg.classList.add('active');window.scrollTo(0,0);}if(n==='academy'&&typeof renderAcademyContent==='function')setTimeout(renderAcademyContent,50);if(n==='about'&&typeof renderAboutContent==='function')setTimeout(renderAboutContent,50);if(n==='workshop'&&typeof renderWorkshop==='function')setTimeout(renderWorkshop,50);if(n==='companion'&&typeof renderCompanion==='function')setTimeout(renderCompanion,50);}
function renderHalls(){var h=document.getElementById('halls-container');if(!h)return;h.innerHTML='<div class="hall-card" onclick="showPage(\'academy\')"><h2>Академия</h2><p>Мудрость, практики, исцеление</p></div><div class="hall-card" onclick="showPage(\'workshop\')"><h2>Мастерская</h2><p>Творчество, цели, инициативы</p></div><div class="hall-card" onclick="showPage(\'companion\')"><h2>Соратник</h2><p>Общение, дружба, сеть</p></div>';}
document.addEventListener('DOMContentLoaded',function(){renderHalls();updateLangBtn();});
EOF

# 4. living-field.js (Живое поле)
cat > /home/ishidin/phoenix/public/js/living-field.js << 'EOF'
(function(){if(document.getElementById('living-field'))return;var f=document.createElement('div');f.id='living-field';f.innerHTML='<div id="phoenix-pulsar"></div><span>Живое поле</span>';f.addEventListener('click',function(){var p=document.getElementById('phoenix-pulsar');if(p)p.classList.toggle('active');});document.body.appendChild(f);})();
EOF

# 5. academy.js (с плавным раскрытием)
cat > /home/ishidin/phoenix/public/js/academy.js << 'EOF'
function renderAcademyContent(){var c=document.getElementById('academy-content');if(!c)return;c.innerHTML='';var s=[{title:'Ключ Реальности',text:'Нет разделения на духовное и материальное. Всё есть единая ткань бытия. Осознание приходит через принятие мира таким, какой он есть. Духовное не противостоит материальному — они танцуют вместе.'},{title:'Ключ Амбивалентности',text:'Способность вмещать полярности — свет и тьму, радость и боль — есть признак зрелой души. Не выбирай одну сторону, держи обе.'},{title:'Ключ Парадоксальности',text:'Жизнь полна противоречий. Именно в них рождается творчество. Не пытайся разрешить парадокс — танцуй с ним.'},{title:'Ключ Трансгрессии',text:'Выход за пределы привычного — это не бунт, а рост. Каждый шаг в неизвестность расширяет границы твоего Сада.'},{title:'Ключ Радикальности',text:'Непоколебимая честность с собой — фундамент осознания. Смотри на себя без прикрас и без осуждения.'},{title:'Ключ Природности',text:'Действие без усилия, как вода из родника. Твоя истинная природа не нуждается в напряжении — она просто течёт.'}];var p=[{title:'Дыхание Осознания',duration:'5 минут',text:'Сядь удобно. Закрой глаза. Сделай 10 глубоких вдохов и выдохов.'},{title:'Амбивалентная Медитация',duration:'10 минут',text:'Вспомни ситуацию с противоречивыми чувствами. Представь эмоции в ладонях.'},{title:'Практика Природности',duration:'15 минут',text:'Найди что-то живое — дерево, облако, птицу. Наблюдай без мыслей.'}];var tb=document.createElement('div');tb.className='tab-bar';var sb=document.createElement('button');sb.className='tab-btn active';sb.textContent='📖 Сутры';var pb=document.createElement('button');pb.className='tab-btn';pb.textContent='🧘 Практики';tb.appendChild(sb);tb.appendChild(pb);c.appendChild(tb);var ca=document.createElement('div');ca.id='tab-content-area';c.appendChild(ca);function cc(t,sub,bt){var cd=document.createElement('div');cd.className='sutra-card';var h=document.createElement('div');h.className='card-header';h.innerHTML='<h3>'+t+'</h3><span class="card-arrow">▼</span>';var b=document.createElement('div');b.className='card-body';if(sub){var sp=document.createElement('p');sp.style.cssText='font-size:12px;color:var(--muted);margin-bottom:6px';sp.textContent=sub;b.appendChild(sp);}var tp=document.createElement('p');tp.textContent=bt;b.appendChild(tp);cd.appendChild(h);cd.appendChild(b);cd.addEventListener('click',function(){b.classList.toggle('open');h.querySelector('.card-arrow').style.transform=b.classList.contains('open')?'rotate(180deg)':'rotate(0deg)';});return cd;}function ss(){ca.innerHTML='';s.forEach(function(x){ca.appendChild(cc(x.title,null,x.text));});}function sp(){ca.innerHTML='';p.forEach(function(x){ca.appendChild(cc(x.title,x.duration,x.text));});}sb.onclick=function(){sb.classList.add('active');pb.classList.remove('active');ss();};pb.onclick=function(){pb.classList.add('active');sb.classList.remove('active');sp();};ss();}if(document.getElementById('academy-page')&&document.getElementById('academy-page').classList.contains('active')){setTimeout(renderAcademyContent,50);}
EOF

# 6. workshop.js (Мастерская с Empty State и скелетонами)
cat > /home/ishidin/phoenix/public/js/workshop.js << 'EOF'
var wsTab='create';function renderWorkshop(){var c=document.getElementById('workshop-content');if(!c)return;c.innerHTML='';var tb=document.createElement('div');tb.className='tab-bar';tb.innerHTML='<button class="tab-btn active" data-tab="create" onclick="switchWsTab(\'create\')">Создать</button><button class="tab-btn" data-tab="my" onclick="switchWsTab(\'my\')">Мои артефакты</button>';c.appendChild(tb);var ct=document.createElement('div');ct.id='ws-tab-content';c.appendChild(ct);var bc=document.createElement('div');bc.id='bc-bar';bc.style.cssText='margin-top:20px;padding-top:12px;border-top:1px solid var(--border);text-align:center;color:var(--muted);font-size:11px';bc.textContent=typeof window.ethereum!=='undefined'?'⛓️ Блокчейн: MetaMask готов':'⛓️ Блокчейн: не подключён';c.appendChild(bc);switchWsTab(wsTab);}function switchWsTab(t){wsTab=t;var ct=document.getElementById('ws-tab-content');if(!ct)return;var btns=document.querySelectorAll('#workshop-content .tab-btn');btns.forEach(function(b){b.classList.remove('active');if(b.getAttribute('data-tab')===t)b.classList.add('active');});if(t==='create'){ct.innerHTML='<div class="workshop-create"><textarea id="artifact-text" placeholder="Опиши свой артефакт..." style="min-height:100px;resize:vertical"></textarea><div style="display:flex;gap:8px;align-items:center"><input type="file" id="artifact-file" style="display:none" onchange="fileSelected(this)"><button class="btn-secondary" onclick="document.getElementById(\'artifact-file\').click()" style="flex:1">📎 Выбрать файл</button><span id="file-name" style="color:var(--muted);font-size:12px;flex:2;text-align:left"></span></div><button class="btn-primary" onclick="createArtifact()">Создать артефакт</button></div>';}else{showSkeleton();setTimeout(loadArtifacts,600);}}var selFile=null;function fileSelected(i){if(i.files.length>0){selFile=i.files[0];document.getElementById('file-name').textContent=selFile.name;}}function createArtifact(){var tx=document.getElementById('artifact-text').value.trim();if(!tx&&!selFile)return;var arts=JSON.parse(localStorage.getItem('phoenix_artifacts')||'[]');var a={id:Date.now(),text:tx,fileName:selFile?selFile.name:null,fileData:null,created:new Date().toISOString(),onChain:false};if(selFile){var r=new FileReader();r.onload=function(e){a.fileData=e.target.result;arts.unshift(a);localStorage.setItem('phoenix_artifacts',JSON.stringify(arts));document.getElementById('artifact-text').value='';document.getElementById('file-name').textContent='';selFile=null;switchWsTab('my');};r.readAsDataURL(selFile);}else{arts.unshift(a);localStorage.setItem('phoenix_artifacts',JSON.stringify(arts));document.getElementById('artifact-text').value='';switchWsTab('my');}}function showSkeleton(){var ct=document.getElementById('ws-tab-content');if(!ct)return;ct.innerHTML='<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card" style="margin-top:8px"></div><div class="skeleton skeleton-card" style="margin-top:8px"></div>';}function loadArtifacts(){var ct=document.getElementById('ws-tab-content');if(!ct)return;var arts=JSON.parse(localStorage.getItem('phoenix_artifacts')||'[]');if(arts.length===0){ct.innerHTML='<div class="empty-state"><div class="empty-icon">📦</div><div class="empty-title">Пока пусто</div><div class="empty-desc">Создай свой первый артефакт во вкладке «Создать»</div></div>';return;}var h='';arts.forEach(function(a){var d=new Date(a.created).toLocaleDateString('ru',{day:'numeric',month:'short',year:'numeric'});var icon=a.fileName?'📄':'📝';h+='<div class="artifact-item"><div class="artifact-info"><div class="name">'+icon+' '+(a.text?a.text.substring(0,40)+(a.text.length>40?'...':''):a.fileName)+'</div><div class="date">'+d+'</div></div><div style="display:flex;gap:4px">'+(a.fileData?'<button class="icon-btn" onclick="downloadArtifact('+a.id+')">⬇️</button>':'')+'<button class="icon-btn" onclick="saveToChain('+a.id+')" style="color:'+(a.onChain?'var(--gold)':'var(--muted)')+'">⛓️</button></div></div>';});ct.innerHTML=h;}function downloadArtifact(id){var arts=JSON.parse(localStorage.getItem('phoenix_artifacts')||'[]');var a=arts.find(function(x){return x.id===id});if(!a||!a.fileData)return;var link=document.createElement('a');link.href=a.fileData;link.download=a.fileName||'artifact';link.click();}async function saveToChain(id){alert('Подключите MetaMask для сохранения в блокчейн');}
EOF

# 7. companion.js (Соратник с Empty States)
cat > /home/ishidin/phoenix/public/js/companion.js << 'EOF'
function renderCompanion(){var c=document.getElementById('companion-content');if(!c)return;c.innerHTML='';var tb=document.createElement('div');tb.className='tab-bar';tb.innerHTML='<button class="tab-btn active" data-tab="dialogue" onclick="switchCompTab(\'dialogue\')">💬 Диалог</button><button class="tab-btn" data-tab="friends" onclick="switchCompTab(\'friends\')">👥 Друзья</button><button class="tab-btn" data-tab="network" onclick="switchCompTab(\'network\')">🌐 Сеть</button>';c.appendChild(tb);var ct=document.createElement('div');ct.id='comp-tab-content';c.appendChild(ct);switchCompTab('dialogue');}function switchCompTab(t){var ct=document.getElementById('comp-tab-content');if(!ct)return;var btns=document.querySelectorAll('#companion-content .tab-btn');btns.forEach(function(b){b.classList.remove('active');if(b.getAttribute('data-tab')===t)b.classList.add('active');});if(t==='dialogue'){ct.innerHTML='<div class="empty-state"><div class="empty-icon">💬</div><div class="empty-title">Диалог</div><div class="empty-desc">Здесь будут сообщения от друзей и соратников</div></div>';}else if(t==='friends'){ct.innerHTML='<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-title">Круг доверия</div><div class="empty-desc">Добавляй друзей и создавай свой круг</div></div>';}else{ct.innerHTML='<div class="empty-state"><div class="empty-icon">🌐</div><div class="empty-title">P2P-сеть</div><div class="empty-desc">Прямые соединения без посредников. Скоро.</div></div>';}}
EOF

# 8. about.js (О проекте с табами)
cat > /home/ishidin/phoenix/public/js/about.js << 'EOF'
function renderAboutContent(){var c=document.getElementById('about-content');if(!c)return;var tb=document.createElement('div');tb.className='tab-bar';var secs=[{id:'product',label:'🐦‍🔥 О продукте'},{id:'constitution',label:'📜 Конституция'},{id:'license',label:'⚖️ Лицензия'},{id:'community',label:'🌿 Сообщество'}];var cd=document.createElement('div');cd.id='about-tab-content';var at='product';function st(id){at=id;var btns=tb.querySelectorAll('.tab-btn');btns.forEach(function(b){b.classList.remove('active');if(b.getAttribute('data-tab')===id)b.classList.add('active');});lc(id);}secs.forEach(function(s){var b=document.createElement('button');b.className='tab-btn';if(s.id===at)b.classList.add('active');b.textContent=s.label;b.setAttribute('data-tab',s.id);b.onclick=function(){st(s.id);};tb.appendChild(b);});c.innerHTML='';c.appendChild(tb);c.appendChild(cd);function lc(id){if(id==='product'){cd.innerHTML='<div class="sutra-card"><h3 style="color:var(--text);margin-bottom:8px">🐦‍🔥 Цифровой Ковчег «Феникс»</h3><p style="color:var(--muted);line-height:1.6">Некоммерческий инструмент для тех, кто устал от слежки и цензуры. Мы не храним твои данные. Мы не продаём твоё внимание. Исходный код открыт на <a href="https://github.com/v4g7yz29g7-coder/phoenix-space" target="_blank" style="color:var(--violet)">GitHub</a>.</p></div>';}else{fetch('/'+id+'.html').then(function(r){return r.text();}).then(function(h){var p=new DOMParser();var d=p.parseFromString(h,'text/html');var b=d.querySelector('.container')||d.body;cd.innerHTML='<div class="sutra-card" style="text-align:left;color:var(--muted);line-height:1.6">'+b.innerHTML+'</div>';}).catch(function(){cd.innerHTML='<p style="color:var(--muted)">Не удалось загрузить</p>';});}}lc('product');}
EOF

# 9. Обновлённый profile.html (с функцией выхода)
cat > /home/ishidin/phoenix/public/profile.html << 'EOF'
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <title>Профиль | Феникс 🐦‍🔥</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <div class="profile-container">
    <a href="/" class="back-link">← Вернуться в Сад</a>
    <div class="profile-avatar" id="avatar-display">👤</div>
    <div class="profile-name" id="username-display">Архитектор</div>
    <div class="profile-did">did:phoenix:0x1234...5678</div>
    <button class="btn-secondary" onclick="document.getElementById('file-input').click()" style="margin-top:-8px">✎ Изменить фото</button>
    <div class="profile-card"><h3>Статистика</h3><div class="profile-stat"><span class="label">Артефактов</span><span class="value" id="profile-artifacts-count">0</span></div><div class="profile-stat"><span class="label">Целей</span><span class="value" id="profile-goals-count">0</span></div><div class="profile-stat"><span class="label">Друзей</span><span class="value">0</span></div><div class="profile-stat"><span class="label">В Саду с</span><span class="value">2026</span></div></div>
    <div class="profile-card"><h3>Активность</h3><p style="color:var(--muted);font-size:13px;line-height:1.5">Твой Сад только начинает расти. Создай первый артефакт в Мастерской или изучи Сутры в Академии.</p></div>
    <button class="btn-primary" onclick="window.location='/'">🐦‍🔥 Вернуться в Сад</button>
    <button class="btn-secondary" id="logout-btn">Выйти</button>
  </div>
  <input type="file" id="file-input" accept="image/*" style="display:none" onchange="changeAvatar(event)">
  <script>
    var savedName = localStorage.getItem('phoenix_username') || 'Архитектор';
    var savedAvatar = localStorage.getItem('phoenix_avatar');
    document.getElementById('username-display').textContent = savedName;
    if (savedAvatar) document.getElementById('avatar-display').innerHTML = '<img src="'+savedAvatar+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
    var artifacts = JSON.parse(localStorage.getItem('phoenix_artifacts')||'[]');
    var goals = JSON.parse(localStorage.getItem('phoenix_goals')||'[]');
    document.getElementById('profile-artifacts-count').textContent = artifacts.length;
    document.getElementById('profile-goals-count').textContent = goals.length;
    function changeAvatar(e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(ev) {
        localStorage.setItem('phoenix_avatar', ev.target.result);
        document.getElementById('avatar-display').innerHTML = '<img src="'+ev.target.result+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
      };
      reader.readAsDataURL(file);
    }
    document.getElementById('username-display').addEventListener('click', function() {
      var newName = prompt('Введи новое имя:', savedName);
      if (newName && newName.trim()) {
        savedName = newName.trim();
        localStorage.setItem('phoenix_username', savedName);
        document.getElementById('username-display').textContent = savedName;
      }
    });
    document.getElementById('logout-btn').addEventListener('click', function() {
      if (confirm('Все локальные данные будут удалены. Продолжить?')) {
        localStorage.clear();
        window.location.href = '/';
      }
    });
  </script>
</body>
</html>
EOF

pm2 restart phoenix
echo "✅ Феникс обновлён до премиум-уровня."
