// Глобальная переменная языка (currentLang уже объявлена в core.js)
// Новая система навигации: 3 Зала с табами
const HALLS = {
  academy: { title: { ru: '📜 Академия', en: '📜 Academy' }, tabs: ['sutras', 'practices', 'healing'] },
  workshop: { title: { ru: '🛠️ Мастерская', en: '🛠️ Workshop' }, tabs: ['artifacts', 'goals', 'initiatives'] },
  companion: { title: { ru: '🤝 Соратник', en: '🤝 Companion' }, tabs: ['dialogue', 'friends', 'network'] }
};

function renderHome() {
  const mainMenu = document.getElementById('mainMenu');
  const t = window.currentLocale || {};
  mainMenu.innerHTML = `
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:1.5rem; margin-bottom:2rem;">
      <div class="hall-card" onclick="navigateToHall('academy')"><span class="hall-icon"><img src="/icons/scroll.svg" style="width:3rem; height:3rem;"></span><h3>${t.academy || 'Академия'}</h3><p>${t.academy_desc || 'Мудрость, практики, исцеление'}</p></div>
      <div class="hall-card" onclick="navigateToHall('workshop')"><span class="hall-icon"><img src="/icons/hammer.svg" style="width:3rem; height:3rem;"></span><h3>${t.workshop || 'Мастерская'}</h3><p>${t.workshop_desc || 'Творчество, цели, инициативы'}</p></div>
      <div class="hall-card" onclick="navigateToHall('companion')"><span class="hall-icon"><img src="/icons/circle.svg" style="width:3rem; height:3rem;"></span><h3>${t.companion || 'Соратник'}</h3><p>${t.companion_desc || 'Общение, друзья, сеть'}</p></div>
    </div>`;
}

function navigateToHall(hallId) {
  const academyWindow = document.getElementById('academyWindow');
  const hallContentInner = document.getElementById('hallContentInner');
  const t = window.currentLocale || {};
  if (!academyWindow || !hallContentInner) return;

  const hall = HALLS[hallId];
  if (!hall) return;

  const tabLabels = {
    sutras: t.sutras || 'Сутры', practices: t.practices || 'Практики', healing: t.healing || 'Исцеление',
    artifacts: t.artifacts || 'Артефакты', goals: t.goals_tab || 'Цели', initiatives: t.initiatives || 'Инициативы',
    dialogue: t.dialogue_tab || 'Диалог', friends: t.friends_tab || 'Друзья', network: t.network_tab || 'Сеть'
  };

  let tabsHtml = hall.tabs.map(tab => `<button class="tab-btn ${tab === hall.tabs[0] ? 'active' : ''}" data-hall="${hallId}" data-tab="${tab}">${tabLabels[tab] || tab}</button>`).join('');

  hallContentInner.innerHTML = `
    <h2 class="academy-title">${hall.title[currentLang || 'ru'] || hall.title.ru}</h2>
    <div class="tabs" style="margin-bottom:1.5rem;">${tabsHtml}</div>
    <div id="tabContent"></div>`;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', function() { switchHallTab(this.dataset.hall, this.dataset.tab); });
  });

  switchHallTab(hallId, hall.tabs[0]);
}

function safeFetch(url) {
  return fetch(url)
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const contentType = r.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) return r.json();
      throw new Error('Ответ не JSON');
    })
    .catch(() => ({ success: false, data: [] }));
}

function switchHallTab(hallId, tab) {
  const tabContent = document.getElementById('tabContent');
  const t = window.currentLocale || {};
  if (!tabContent) return;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.hall === hallId && btn.dataset.tab === tab);
  });

  if (hallId === 'academy') {
    if (tab === 'sutras') {
      safeFetch(`/api/contents/sutras?lang=${currentLang || 'ru'}`).then(data => {
        tabContent.innerHTML = data.success && data.data.length ? data.data.map(item => `<div class="key-item"><h3>${item.title}</h3><p>${item.body.replace(/\n/g, '<br>')}</p></div>`).join('') : '<p style="color:#aa8c7a;">Сутры пока не добавлены.</p>';
      });
    } else if (tab === 'practices') {
      safeFetch(`/api/contents/practices?lang=${currentLang || 'ru'}`).then(data => {
        tabContent.innerHTML = data.success && data.data.length ? data.data.map(item => `<div class="key-item"><h3>${item.title}</h3><p>${item.body.replace(/\n/g, '<br>')}</p></div>`).join('') : '<p style="color:#aa8c7a;">Практики пока не добавлены.</p>';
      });
    } else if (tab === 'healing') {
      tabContent.innerHTML = '<p style="color:#aa8c7a;">Психосоматика и аффирмации скоро появятся.</p>';
    }
  } else if (hallId === 'workshop') {
    if (tab === 'artifacts') {
      safeFetch('/api/artifacts').then(data => {
        tabContent.innerHTML = data.success && data.data.length ? data.data.map(a => `<div class="key-item"><h4>${a.title}</h4><p>${a.description || ''}</p></div>`).join('') : '<p style="color:#aa8c7a;">Артефактов пока нет. Создайте первый!</p>';
      });
    } else if (tab === 'goals') {
      tabContent.innerHTML = '<div id="goalsContainer"><p style="color:#aa8c7a;">Загрузка целей...</p></div>';
    } else if (tab === 'initiatives') {
      tabContent.innerHTML = '<p style="color:#aa8c7a;">Инициативы скоро появятся.</p>';
    }
  } else if (hallId === 'companion') {
    if (tab === 'dialogue') tabContent.innerHTML = '<p style="color:#aa8c7a;">Откройте Круг для общения.</p>';
    else if (tab === 'friends') tabContent.innerHTML = '<p style="color:#aa8c7a;">Список друзей скоро появится.</p>';
    else if (tab === 'network') tabContent.innerHTML = '<iframe src="/network" style="width:100%;height:500px;border:none;border-radius:16px;"></iframe>';
  }
}
