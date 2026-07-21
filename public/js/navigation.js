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
  
  let html = `
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:1.5rem; margin-bottom:2rem;">
      <div class="hall-card" onclick="navigateToHall('academy')">
        <span class="hall-icon"><img src="/icons/scroll.svg" style="width:3rem; height:3rem;"></span>
        <h3>${t.academy || 'Академия'}</h3>
        <p>${t.academy_desc || 'Твоя крепость знаний'}</p>
      </div>
      <div class="hall-card" onclick="navigateToHall('workshop')">
        <span class="hall-icon"><img src="/icons/hammer.svg" style="width:3rem; height:3rem;"></span>
        <h3>${t.workshop || 'Мастерская'}</h3>
        <p>${t.workshop_desc || 'Твоя мастерская артефактов'}</p>
      </div>
      <div class="hall-card" onclick="navigateToHall('companion')">
        <span class="hall-icon"><img src="/icons/circle.svg" style="width:3rem; height:3rem;"></span>
        <h3>${t.companion || 'Соратник'}</h3>
        <p>${t.companion_desc || 'Прямая связь без посредников'}</p>
      </div>
    </div>
  `;
  mainMenu.innerHTML = html;
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
      safeFetch(`/api/contents/healing?lang=${currentLang || 'ru'}`).then(data => {
        tabContent.innerHTML = data.success && data.data.length ? data.data.map(item => `<div class="key-item"><h3>${item.title}</h3><p>${item.body.replace(/\n/g, '<br>')}</p></div>`).join('') : '<p style="color:#aa8c7a;">Исцеляющая мудрость скоро появится.</p>';
      });
    }
  } else if (hallId === 'workshop') {
    if (tab === 'artifacts') {
      safeFetch('/api/artifacts').then(data => {
        tabContent.innerHTML = data.success && data.data.length ? data.data.map(a => `<div class="key-item"><h4>${a.title}</h4><p>${a.description || ''}</p></div>`).join('') : '<p style="color:#aa8c7a;">Артефактов пока нет. Создайте первый!</p>';
      });
      if (tab === 'goals') {
        tabContent.innerHTML = '<div id="goalsContainer"></div>';
        if (typeof window.initGoalsModule === 'function') window.initGoalsModule();
      } else if (tab === 'initiatives') {
      tabContent.innerHTML = '<p style="color:#aa8c7a;">Инициативы скоро появятся.</p>';
    }
  } else if (hallId === 'companion') {
    if (tab === 'dialogue') {
      tabContent.innerHTML = `<div id="circleContainer"><div id="circleLogin" class="key-item"><h3 style="color:var(--soft);">Войти в Круг</h3><input type="text" id="circleName" placeholder="Твоё имя" style="background:rgba(0,0,0,0.4);border:1px solid var(--accent);border-radius:8px;padding:0.7rem;color:#fff;width:100%;margin-bottom:0.5rem;"><select id="circleRoom" style="background:rgba(0,0,0,0.4);border:1px solid var(--accent);border-radius:8px;padding:0.7rem;color:#fff;width:100%;margin-bottom:0.5rem;"><option value="общий">Общий круг</option><option value="утренняя">Утренняя практика</option><option value="вечерняя">Вечерняя практика</option></select><button id="joinCircleBtn" class="btn" style="width:100%;">Войти</button></div><div id="circleChat" style="display:none;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;"><span id="onlineIndicator" style="color:var(--soft);"></span><button id="leaveCircleBtn" class="btn-outline" style="padding:0.3rem 1rem;">Выйти</button></div><div id="circleMessages" style="height:300px;overflow-y:auto;background:rgba(0,0,0,0.3);border-radius:12px;padding:1rem;margin-bottom:1rem;"></div><div style="display:flex;gap:0.5rem;"><input type="text" id="circleMessageInput" placeholder="Напиши сообщение..." style="flex:1;background:rgba(0,0,0,0.4);border:1px solid var(--accent);border-radius:8px;padding:0.7rem;color:#fff;"><button id="sendCircleMsgBtn" class="btn">Отправить</button></div></div></div>`;
      setTimeout(() => { if (typeof attachCircleEvents === 'function') attachCircleEvents(); }, 200);
    } else if (tab === 'friends') {
      tabContent.innerHTML = '<p style="color:#aa8c7a;">Список друзей скоро появится.</p>';
    } else if (tab === 'network') {
      tabContent.innerHTML = '<iframe src="/network" style="width:100%;height:500px;border:none;border-radius:16px;"></iframe>';
    }
  }
}

// При входе в Диалог проверяем DID и сразу заходим в чат
(function() {
  const origSwitchHallTab = switchHallTab;
  switchHallTab = function(hallId, tab) {
    origSwitchHallTab(hallId, tab);
    if (hallId === 'companion' && tab === 'dialogue') {
      setTimeout(() => {
        const did = JSON.parse(localStorage.getItem('phoenix_did') || '{}');
        if (did.mnemonic) {
          const joinBtn = document.getElementById('joinCircleBtn');
          if (joinBtn) joinBtn.click();
        }
      }, 500);
    }
  };
})();
