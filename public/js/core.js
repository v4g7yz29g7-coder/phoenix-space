// ========== ЛУЧИ ==========
(function createRays() {
  if (!document.getElementById("raysContainer")) return;
  const container = document.getElementById("raysContainer"); if (!container) return;
  const rays = [];
  const count = 24;
  for (let i = 0; i < count; i++) {
    const ray = document.createElement('div');
    ray.className = 'ray';
    const baseAngle = (i * 360) / count;
    ray.dataset.baseAngle = baseAngle;
    ray.style.transform = `rotate(${baseAngle}deg)`;
    ray.style.animationDelay = `${(i * 0.1)}s`;
    container.appendChild(ray);
    rays.push(ray);
  }
  let globalRotation = 0;
  const baseSpeed = 0.03, maxSpeed = 0.15, acceleration = 0.001, deceleration = 0.0005;
  let currentSpeed = baseSpeed, mouseMoving = false, moveTimeout;
  document.addEventListener('mousemove', () => { mouseMoving = true; clearTimeout(moveTimeout); moveTimeout = setTimeout(() => { mouseMoving = false; }, 100); });
  function animate() {
    currentSpeed = mouseMoving ? Math.min(maxSpeed, currentSpeed + acceleration) : Math.max(baseSpeed, currentSpeed - deceleration);
    globalRotation = (globalRotation + currentSpeed) % 360;
    rays.forEach(ray => {
      const base = parseFloat(ray.dataset.baseAngle);
      ray.style.transform = `rotate(${base + globalRotation}deg)`;
    });
    requestAnimationFrame(animate);
  }
  animate();
})();

// ========== ЯЗЫКОВОЙ ПЕРЕКЛЮЧАТЕЛЬ ==========
const langBtn = document.getElementById('langBtnCurrent');
const langDropdown = document.getElementById('langDropdown');
const langOptions = document.querySelectorAll('.lang-option');

let currentLang = localStorage.getItem('phoenixLang') || 'ru';
document.documentElement.lang = currentLang;

function updateLangButton(lang) {
  const flags = { ru: '🇷🇺', en: '🇬🇧', zh: '🇨🇳', fr: '🇫🇷', pt: '🇧🇷', hi: '🇮🇳', es: '🇪🇸' };
  const names = { ru: 'Русский', en: 'English', zh: '中文', fr: 'Français', pt: 'Português', hi: 'हिन्दी', es: 'Español' };
  if (langBtn) langBtn.innerHTML = (flags[lang] || '🌐') + ' ' + (names[lang] || '');
}

function setActiveLang(lang) {
  const flags = { ru: "🇷🇺", en: "🇬🇧", zh: "🇨🇳", fr: "🇫🇷", pt: "🇧🇷", hi: "🇮🇳", es: "🇪🇸" }; 
  const names = { ru: "Русский", en: "English", zh: "中文", fr: "Français", pt: "Português", hi: "हिन्दी", es: "Español" }; 
  if (langBtn) langBtn.innerHTML = (flags[lang] || "🌐") + " " + (names[lang] || "");
  langOptions.forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
  updateLangButton(lang);
  localStorage.setItem('phoenixLang', lang);
  document.documentElement.lang = lang;
  if (typeof applyLocale === 'function') applyLocale(lang);
  currentLang = lang;
  if (typeof window.updateMainUI === 'function') window.updateMainUI();
}

langBtn.addEventListener('click', e => { e.stopPropagation(); langDropdown.classList.toggle('active'); });
langOptions.forEach(b => b.addEventListener('click', e => { e.stopPropagation(); setActiveLang(b.dataset.lang); langDropdown.classList.remove('active'); }));
document.addEventListener('click', () => langDropdown.classList.remove('active'));

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', () => {
  updateLangButton(currentLang);
  const p = document.getElementById('pulsarBtn');
  if (p) p.setAttribute('data-tooltip', 'Пульсар — центр Феникса');
});

// Логика «О проекте»
const aboutBtn = document.getElementById('aboutBtnSmall');
const aboutScreen = document.getElementById('aboutScreen');
const closeAboutBtn = document.getElementById('closeAboutBtn');
const aboutContent = document.getElementById('aboutContent');

function renderMD(md) {
  if (!md) return '';
  return '<p>' + md
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^- (.*$)/gim, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>') + '</p>';
}

async function loadAboutContent(lang) {
  if (!aboutContent) return;
  const t = window.currentLocale || {};
  aboutContent.innerHTML = '<p style="color:#aa8c7a;">' + (t.about_loading || 'Загрузка...') + '</p>';
  try {
    let [visRes, roadRes] = await Promise.all([
      fetch(`/VISION_${lang}.md`).catch(() => null),
      fetch(`/ROADMAP_${lang}.md`).catch(() => null)
    ]);
    if (!visRes || !visRes.ok) visRes = await fetch('/VISION_ru.md');
    if (!roadRes || !roadRes.ok) roadRes = await fetch('/ROADMAP_ru.md');
    let html = '';
    if (visRes.ok) html += '<h2 style="color:var(--accent-soft);">📜 ' + (t.vision_title || 'Technical Vision') + '</h2>' + renderMD(await visRes.text());
    if (roadRes.ok) html += '<h2 style="color:var(--accent-soft); margin-top:2rem;">🗺️ ' + (t.roadmap_title || 'Roadmap') + '</h2>' + renderMD(await roadRes.text());
    aboutContent.innerHTML = html || '<p>' + (t.about_not_found || 'Not found') + '</p>';
  aboutContent.innerHTML += `<p style="margin-top:1rem;text-align:center;font-size:0.8rem;"><a href="/license" target="_blank" style="color:var(--accent-soft);">📜 Лицензия MIT</a></p>`;
  aboutContent.innerHTML += `<p style="margin-top:2rem;text-align:center;"><a href="/constitution" target="_blank" style="color:var(--accent-soft);">📜 Конституция Феникса</a></p>`;
  } catch (e) { aboutContent.innerHTML = '<p>' + (t.error_loading || 'Error') + '</p>'; }
}

function openAbout() { aboutScreen.classList.add('active'); loadAboutContent(currentLang || 'ru'); }
function closeAbout() { aboutScreen.classList.remove('active'); }

if (aboutBtn) aboutBtn.addEventListener('click', openAbout);
if (closeAboutBtn) closeAboutBtn.addEventListener('click', closeAbout);
if (aboutScreen) {
  aboutScreen.addEventListener('click', e => { if (e.target === aboutScreen) closeAbout(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && aboutScreen.classList.contains('active')) closeAbout(); });
}
// Обработчик Пульсара (открытие Академии)
if (typeof openAcademy === 'function') {
  document.getElementById('pulsarBtn').addEventListener('click', openAcademy);
}

// Явный обработчик Пульсара (открытие Академии)
document.addEventListener('DOMContentLoaded', function() {
  const pulsar = document.getElementById('pulsarBtn');
  if (pulsar && typeof openAcademy === 'function') {
    pulsar.addEventListener('click', openAcademy);
  }
});

// Замена эмодзи на SVG-иконки
function replaceEmojis() {
  const emojiMap = {
    '🕊️': '/icons/dove.svg',
    '💎': '/icons/gem.svg',
    '🌿': '/icons/leaf.svg',
    '✨': '/icons/star.svg',
    '📝': '/icons/book.svg',
    '🌳': '/icons/tree.svg',
    '🔥': '/icons/fire.svg',
    '💧': '/icons/water.svg',
    '⛰️': '/icons/mountain.svg'
  };
  
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let node;
  while (node = walker.nextNode()) {
    let text = node.textContent;
    let changed = false;
    for (const [emoji, icon] of Object.entries(emojiMap)) {
      if (text.includes(emoji)) {
        text = text.replace(new RegExp(emoji, 'g'), '');
        changed = true;
      }
    }
    if (changed) {
      const span = document.createElement('span');
      span.innerHTML = text;
      node.parentNode.replaceChild(span, node);
    }
  }
}
document.addEventListener('DOMContentLoaded', replaceEmojis);
