#!/bin/bash
set -e

cd ~/phoenix/public

# 1. CSS
cat > css/app.css <<'CSSEOF'
:root { --bg: #08080f; --surface: rgba(255,255,255,0.04); --border: rgba(255,255,255,0.06); --text: #e8e4f0; --muted: #88839a; --violet: #a78bfa; --gold: #fbbf24; --radius: 14px; --font: 'Inter', system-ui, sans-serif; }
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:100%; overflow-x:hidden; background:var(--bg); }
body { font-family:var(--font); color:var(--text); min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:1.5rem; }
.home-garden { width:100%; max-width:400px; margin:0 auto; display:flex; flex-direction:column; gap:2rem; }
.home-title { font-size:1.75rem; font-weight:500; }
.home-subtitle { color:var(--muted); font-size:0.95rem; margin-top:-1rem; }
.halls-grid { display:flex; flex-direction:column; gap:0.75rem; width:100%; }
.hall-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:1.25rem; width:100%; cursor:pointer; }
.hall-card h2 { font-size:1rem; font-weight:500; }
.hall-card p { font-size:0.8rem; color:var(--muted); }
.page { display:none; min-height:100vh; flex-direction:column; align-items:center; justify-content:center; padding:2rem 1rem; width:100%; }
.page.active { display:flex; }
.back-link { position:fixed; top:1rem; left:1rem; color:var(--muted); font-size:0.8rem; cursor:pointer; z-index:100; }
#lang-switcher { position:fixed; top:16px; right:16px; display:flex; align-items:center; gap:12px; z-index:200; }
#lang-btn { display:flex; align-items:center; gap:6px; background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:6px 14px; color:var(--text); font-size:13px; cursor:pointer; font-family:var(--font); }
#lang-dropdown { display:none; position:absolute; top:100%; right:0; margin-top:6px; background:#12121f; border:1px solid var(--border); border-radius:var(--radius); padding:6px; min-width:170px; }
.lang-option { display:flex; align-items:center; gap:8px; width:100%; padding:10px 12px; border:none; background:transparent; color:var(--muted); font-size:13px; cursor:pointer; border-radius:10px; font-family:var(--font); text-align:left; }
.lang-option:hover { background:rgba(255,255,255,0.04); color:var(--text); }
#profile-link { font-size:17px; text-decoration:none; opacity:0.6; }
#about-link { position:fixed; bottom:20px; left:20px; font-size:11px; color:var(--muted); text-decoration:none; opacity:0.6; z-index:9999; }
CSSEOF

# 2. app.js
cat > js/app.js <<'JSEOF'
var LANGS=[{code:'ru',label:'Русский',file:'ru.svg'},{code:'en',label:'English',file:'en.svg'},{code:'es',label:'Español',file:'es.svg'},{code:'de',label:'Deutsch',file:'de.svg'},{code:'fr',label:'Français',file:'fr.svg'},{code:'zh',label:'中文',file:'zh.svg'},{code:'hi',label:'हिन्दी',file:'hi.svg'},{code:'ar',label:'العربية',file:'ar.svg'},{code:'pt',label:'Português',file:'pt.svg'}];
var currentLang=localStorage.getItem('phoenix_lang')||'ru';
var TR={home_title:{ru:'Привет, Архитектор',en:'Hello, Architect'},home_subtitle:{ru:'🐦‍🔥 Пространство пробуждения',en:'🐦‍🔥 Space of Awakening'},academy:{ru:'Академия',en:'Academy'},academy_desc:{ru:'Мудрость, практики, исцеление',en:'Wisdom, practices, healing'},workshop:{ru:'Мастерская',en:'Workshop'},workshop_desc:{ru:'Творчество, цели, инициативы',en:'Creativity, goals, initiatives'},companion:{ru:'Соратник',en:'Companion'},companion_desc:{ru:'Общение, дружба, сеть',en:'Dialogue, friendship, network'}};
function t(k){return(TR[k]&&TR[k][currentLang])||(TR[k]&&TR[k]['ru'])||k;}
function flagImg(f){return'<img src="/flags/'+f+'" width="20" height="13" style="vertical-align:middle;border-radius:2px" alt="">';}
function updateLangBtn(){var l=LANGS.find(function(x){return x.code===currentLang});var b=document.getElementById('lang-btn');if(b)b.innerHTML=flagImg(l.file)+' <span style="vertical-align:middle;font-weight:500">'+l.code.toUpperCase()+'</span>';}
function toggleLangDropdown(e){e.stopPropagation();var dd=document.getElementById('lang-dropdown');if(dd.style.display==='block'){dd.style.display='none';return;}dd.innerHTML='';LANGS.forEach(function(l){var it=document.createElement('button');it.className='lang-option'+(l.code===currentLang?' active':'');it.innerHTML=flagImg(l.file)+' '+l.label;it.onclick=function(){currentLang=l.code;localStorage.setItem('phoenix_lang',currentLang);updateLangBtn();dd.style.display='none';translatePage();};dd.appendChild(it);});dd.style.display='block';}
document.addEventListener('click',function(){var dd=document.getElementById('lang-dropdown');if(dd)dd.style.display='none';});
function translatePage(){var h1=document.querySelector('.home-title');if(h1)h1.textContent=t('home_title');var sub=document.querySelector('.home-subtitle');if(sub)sub.textContent=t('home_subtitle');var cards=document.querySelectorAll('.hall-card');if(cards[0]){cards[0].querySelector('h2').textContent=t('academy');cards[0].querySelector('p').textContent=t('academy_desc');}if(cards[1]){cards[1].querySelector('h2').textContent=t('workshop');cards[1].querySelector('p').textContent=t('workshop_desc');}if(cards[2]){cards[2].querySelector('h2').textContent=t('companion');cards[2].querySelector('p').textContent=t('companion_desc');}}
function showPage(n){document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active')});var pg=document.getElementById(n+'-page');if(pg){pg.classList.add('active');window.scrollTo(0,0);}if(n==='academy'&&typeof renderAcademyContent==='function')setTimeout(renderAcademyContent,50);if(n==='about'&&typeof renderAboutContent==='function')setTimeout(renderAboutContent,50);if(n==='workshop'&&typeof renderWorkshop==='function')setTimeout(renderWorkshop,50);if(n==='companion'&&typeof renderCompanion==='function')setTimeout(renderCompanion,50);}
function renderHalls(){var h=document.getElementById('halls-container');if(!h)return;h.innerHTML='<div class="hall-card" onclick="showPage(\'academy\')"><h2>'+t('academy')+'</h2><p>'+t('academy_desc')+'</p></div><div class="hall-card" onclick="showPage(\'workshop\')"><h2>'+t('workshop')+'</h2><p>'+t('workshop_desc')+'</p></div><div class="hall-card" onclick="showPage(\'companion\')"><h2>'+t('companion')+'</h2><p>'+t('companion_desc')+'</p></div>';}
document.addEventListener('DOMContentLoaded',function(){renderHalls();updateLangBtn();translatePage();});
JSEOF

# 3. Заглушки модулей
echo "function renderAcademyContent(){var c=document.getElementById('academy-content');if(c)c.innerHTML='<p style=\"color:var(--muted)\">Академия загружается...</p>';}" > js/academy.js
echo "function renderWorkshop(){var c=document.getElementById('workshop-content');if(c)c.innerHTML='<p style=\"color:var(--muted)\">Мастерская загружается...</p>';}" > js/workshop.js
echo "function renderCompanion(){var c=document.getElementById('companion-content');if(c)c.innerHTML='<p style=\"color:var(--muted)\">Соратник загружается...</p>';}" > js/companion.js
echo "function renderAboutContent(){var c=document.getElementById('about-content');if(c)c.innerHTML='<p style=\"color:var(--muted)\">О проекте загружается...</p>';}" > js/about.js
echo "(function(){var f=document.createElement('div');f.id='living-field';f.innerHTML='<div id=\"phoenix-pulsar\"></div><span>Живое поле</span>';f.style.cssText='position:fixed;bottom:20px;right:20px;cursor:pointer;text-align:center;z-index:9999';f.onclick=function(){document.getElementById('phoenix-pulsar').classList.toggle('active');};document.body.appendChild(f);})();" > js/living-field.js

# 4. index.html
cat > index.html <<'HTMLEOF'
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
HTMLEOF

pm2 restart phoenix
echo "Восстановление завершено."
