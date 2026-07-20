document.addEventListener("DOMContentLoaded", function() {
// academyWindow объявлена в core.js
  closeAcademyBtn = document.getElementById('closeAcademyBtn'),
  pulsarBtn = document.getElementById('pulsarBtn'),
  academyWindow = document.getElementById('academyWindow');

function openAcademy() { if (academyWindow) academyWindow.classList.add("active"); if (academyWindow) { academyWindow.tabIndex = 0; academyWindow.focus(); } showMainMenu(); }
  setTimeout(() => { if (typeof renderHome === "function") renderHome(); }, 100);
  if (typeof renderHome === "function") renderHome();
function closeAcademy() { if (academyWindow) academyWindow.classList.remove("active"); }
pulsarBtn.addEventListener('click', openAcademy);
closeAcademyBtn.addEventListener('click', closeAcademy);
academyWindow.addEventListener('click', e => { if (e.target === academyWindow) closeAcademy(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && academyWindow.classList.contains('active')) closeAcademy(); });

const mainMenu = document.getElementById('mainMenu'),
  hallContent = document.getElementById('hallContent'),
  hallContentInner = document.getElementById('hallContentInner'),
  backToMenuBtn = document.getElementById('backToMenuBtn'),
  openGardenFromMenuBtn = document.getElementById('openGardenFromMenuBtn'),
  hallCards = document.querySelectorAll('.hall-card');

function showMainMenu() { mainMenu.style.display = 'grid'; hallContent.style.display = 'none'; hallContentInner.dataset.currentHall = ''; }

async function showHall(hallId) {
  mainMenu.style.display = 'none'; hallContent.style.display = 'block'; hallContentInner.dataset.currentHall = hallId;
  const t = window.currentLocale || {};
  hallContentInner.innerHTML = '<p style="color:#aa8c7a;">' + (t.loading || 'Загрузка...') + '</p>';

  if (hallId === 'media') {
    hallContentInner.innerHTML = `<h3 style="color:var(--accent-soft);"><i class="fa-solid fa-headphones"></i> ${t.sound_silence || 'Sound of Silence'}</h3><p>${t.media_coming || 'Coming soon...'}</p><div class="media-visual"><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div></div><p style="color:#aa8c7a;">${t.media_ready || 'Preparing...'}</p>`;
    return;
  }

  if (hallId === 'workshop') {
    let html = `<h3 style="color:var(--accent-soft);"><i class="fa-solid fa-hammer"></i> ${t.workshop || 'Мастерская'}</h3><div class="key-item"><h3>${t.create_artifact || 'Создать артефакт'}</h3><form id="artifactForm" enctype="multipart/form-data" style="display:flex;flex-direction:column;gap:1rem;"><input type="text" id="artifactAuthor" placeholder="${t.author_name || 'Твоё имя'}" style="background:rgba(0,0,0,0.4);border:1px solid var(--accent-main);border-radius:8px;padding:0.7rem;color:#fff;"><input type="text" id="artifactTitle" placeholder="${t.artifact_title || 'Название'}" required style="background:rgba(0,0,0,0.4);border:1px solid var(--accent-main);border-radius:8px;padding:0.7rem;color:#fff;"><select id="artifactType" style="background:rgba(0,0,0,0.4);border:1px solid var(--accent-main);border-radius:8px;padding:0.7rem;color:#fff;"><option value="text">${t.artifact_text || 'Текст'}</option><option value="image">${t.artifact_image || 'Изображение'}</option><option value="audio">${t.artifact_audio || 'Аудио'}</option></select><textarea id="artifactDesc" placeholder="${t.artifact_desc || 'Описание'}" style="background:rgba(0,0,0,0.4);border:1px solid var(--accent-main);border-radius:8px;padding:0.7rem;color:#fff;height:100px;"></textarea><input type="file" id="artifactFile" style="color:#aa8c7a;"><button type="submit" style="background:var(--accent-main);border:none;color:#fff;padding:0.7rem 2rem;border-radius:30px;cursor:pointer;font-size:1rem;"><i class="fa-solid fa-plus"></i> ${t.create_artifact || 'Создать'}</button></form></div><h3 style="color:var(--accent-soft); margin:1.5rem 0;"><i class="fa-solid fa-images"></i> ${t.gallery || 'Галерея'}</h3><div id="artifactsGallery">${t.loading || 'Загрузка...'}</div>`;
    hallContentInner.innerHTML = html;
    if (typeof loadArtifacts === 'function') loadArtifacts();
    if (typeof attachArtifactForm === 'function') attachArtifactForm();
    return;
  }

  if (hallId === 'life-school') { 
    let html = ` 
      <div style="text-align:center; margin-bottom:1.5rem;"><img src="/icons/tree.svg" style="width:3rem; height:3rem; filter:drop-shadow(0 0 15px var(--accent-glow));"/></div> 
      <div style="display:flex; gap:0.8rem; justify-content:center; margin-bottom:2rem;"> 
        <button class="school-tab active" data-tab="goals">${t.goals_tab || '🎯 Цели'}</button> 
        <button class="school-tab" data-tab="friends">${t.friends_tab || '🤝 Дружба'}</button> 
        <button class="school-tab" data-tab="dialogue">${t.dialogue_tab || '💬 Диалог'}</button> 
        <button class="school-tab" data-tab="silence">${t.meditation_title || '🕯️ Тишина'}</button> 
      </div> 
      <div id="tab-goals" class="school-panel active"> 
        <div class="key-item" style="border-left: none; background: rgba(255,255,255,0.02); border-radius:16px; padding:1.5rem;"> 
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;"><h4 style="margin:0; font-size:1.2rem; color:var(--accent-soft);">${t.goals_tab || 'Цели'}</h4><span style="font-size:0.8rem; color:#aa8c7a;" id="goalsCount">0 ${t.progress || 'в процессе'}</span></div> 
          <div id="goalsList" style="margin-bottom:1rem;"></div> 
          <div style="display:flex; gap:0.5rem;"><input type="text" id="goalInput" placeholder="${t.goal_placeholder || 'Опиши цель...'}" style="flex:1; background:rgba(0,0,0,0.4); border:1px solid rgba(255,140,0,0.3); border-radius:12px; padding:0.7rem; color:#fff; font-size:0.9rem;" autocomplete="off"><button id="addGoalBtn" style="background:var(--accent-main); border:none; color:#fff; padding:0.7rem 1.5rem; border-radius:12px; cursor:pointer; font-size:0.9rem;"><img src="/icons/plus.svg" style="width:1rem; vertical-align:middle;"> ${t.add_goal || 'Добавить'}</button></div> 
        </div> 
      </div> 
      <div id="tab-friends" class="school-panel"> 
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:1rem;"> 
          <div class="friend-card" onclick="showHall('circle')"><div style="font-size:2rem; margin-bottom:0.5rem;">🌅</div><div style="font-weight:500; color:var(--accent-soft);">${t.common_room || 'Общий круг'}</div><div style="font-size:0.8rem; color:#aa8c7a;">${t.rooms_available || 'Открыто'}</div></div> 
          <div class="friend-card" onclick="showHall('circle')"><div style="font-size:2rem; margin-bottom:0.5rem;">☀️</div><div style="font-weight:500; color:var(--accent-soft);">${t.morning_practice || 'Утренняя практика'}</div><div style="font-size:0.8rem; color:#aa8c7a;">${t.rooms_available || 'Открыто'}</div></div> 
          <div class="friend-card" onclick="showHall('circle')"><div style="font-size:2rem; margin-bottom:0.5rem;">🌙</div><div style="font-weight:500; color:var(--accent-soft);">${t.evening_practice || 'Вечерняя практика'}</div><div style="font-size:0.8rem; color:#aa8c7a;">${t.rooms_available || 'Открыто'}</div></div> 
        </div> 
      </div> 
      <div id="tab-dialogue" class="school-panel"> 
        <div class="key-item" style="border-left: none; background: rgba(255,255,255,0.02); border-radius:16px; padding:1.5rem;"> 
          <div style="display:flex; gap:1rem; align-items:flex-start;"><div style="width:50px; height:50px; background: radial-gradient(circle, var(--accent-soft), var(--accent-main)); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:1.5rem; box-shadow:0 0 15px var(--accent-glow);">🪞</div><div style="flex:1;"><div id="mirrorQuestion" style="font-style:italic; color:#ffd9b3; font-size:1rem; margin-bottom:1rem;">${t.guru_question || 'Что я сейчас чувствую?'}</div><div style="display:flex; gap:0.5rem; margin-bottom:1rem;"><button id="askMirrorBtn" style="background:var(--accent-main); border:none; color:#fff; padding:0.5rem 1.2rem; border-radius:20px; cursor:pointer; font-size:0.85rem;">${t.ask_guru || 'Задать вопрос'}</button></div><textarea id="thoughtsArea" placeholder="${t.your_thoughts || 'Что приходит в голову...'}" style="width:100%; height:100px; background:rgba(0,0,0,0.4); border:1px solid rgba(255,140,0,0.3); border-radius:12px; padding:0.7rem; color:#fff; resize:vertical; font-size:0.9rem;"></textarea><button id="saveThoughtBtn" style="background:var(--accent-main); border:none; color:#fff; padding:0.5rem 1.2rem; border-radius:20px; cursor:pointer; margin-top:0.5rem; font-size:0.85rem;">${t.save_thought || 'Сохранить заметку'}</button><div id="thoughtsHistory" style="margin-top:1rem;"></div></div></div> 
        </div> 
      </div> 
      <div id="tab-silence" class="school-panel"> 
        <div class="key-item" style="text-align:center; padding:2rem;"><div style="font-size:3rem; margin-bottom:1rem;">🕯️</div><h4>${t.meditation_title || 'Тишина'}</h4><p style="color:#aa8c7a;">Просто побудь здесь. Ничего не нужно делать.</p><div id="silenceTimer" style="font-size:2rem; color:var(--accent-soft); margin:1rem 0;">00:00</div><button id="startSilenceBtn" style="background:var(--accent-main); border:none; color:#fff; padding:0.5rem 1.5rem; border-radius:20px; cursor:pointer;">Начать</button></div> 
      </div> 
    `; 
    hallContentInner.innerHTML = html; 
    /* Вкладки */ 
    const tabBtns = hallContentInner.querySelectorAll('.school-tab'); 
    const panels = hallContentInner.querySelectorAll('.school-panel'); 
    tabBtns.forEach(btn => { 
      btn.addEventListener('click', () => { 
        const target = btn.dataset.tab; 
        tabBtns.forEach(b => b.classList.remove('active')); 
        panels.forEach(p => p.classList.remove('active')); 
        btn.classList.add('active'); 
        hallContentInner.querySelector('#tab-' + target).classList.add('active'); 
      }); 
    }); 
    /* Цели (localStorage) */ 
    const goalsKey = 'phoenix_goals_' + (currentUser?.did || 'anonymous'); 
    function loadGoals() { 
      const goals = JSON.parse(localStorage.getItem(goalsKey) || '[]'); 
      const list = document.getElementById('goalsList'); 
      const count = document.getElementById('goalsCount'); 
      if (count) count.textContent = goals.length + ' ' + (t.progress || 'в процессе'); 
      if (goals.length === 0) { 
        list.innerHTML = '<div style="text-align:center; padding:1rem; color:#aa8c7a;">' + (t.no_goals || 'Нет целей') + '</div>'; 
      } else { 
        list.innerHTML = goals.map((g, i) => ` 
          <div class="goal-row" style="display:flex; align-items:center; padding:0.6rem; background:rgba(255,255,255,0.03); border-radius:10px; margin-bottom:0.5rem; transition: all 0.2s;"> 
            <button onclick="window._completeGoal(${i})" style="width:22px; height:22px; border-radius:50%; border:2px solid var(--accent-main); background:transparent; margin-right:1rem; cursor:pointer; transition: all 0.2s; flex-shrink:0;"></button> 
            <span style="flex:1; color:#e0e0e0; font-size:0.9rem;">${g.text}</span> 
            <button onclick="window._removeGoal(${i})" style="background:transparent; border:none; color:#aa8c7a; cursor:pointer; font-size:0.8rem; padding:0.3rem;">✕</button> 
          </div>`).join(''); 
      } 
    } 
    window._removeGoal = function(index) { const goals = JSON.parse(localStorage.getItem(goalsKey) || '[]'); goals.splice(index, 1); localStorage.setItem(goalsKey, JSON.stringify(goals)); loadGoals(); }; 
    window._completeGoal = function(index) { const goals = JSON.parse(localStorage.getItem(goalsKey) || '[]'); if (goals[index]) { goals[index].completed = !goals[index].completed; localStorage.setItem(goalsKey, JSON.stringify(goals)); loadGoals(); } }; 
    document.getElementById('addGoalBtn').addEventListener('click', () => { const input = document.getElementById('goalInput'); if (!input.value.trim()) return; const goals = JSON.parse(localStorage.getItem(goalsKey) || '[]'); goals.push({ text: input.value.trim(), added: new Date().toISOString() }); localStorage.setItem(goalsKey, JSON.stringify(goals)); input.value = ''; loadGoals(); }); 
    loadGoals(); 
    /* Зеркало */ 
    const mirrorQuestions = ['Что я сейчас чувствую в теле?', 'Какая мысль крутится в голове прямо сейчас?', 'За что я могу сказать себе спасибо?', 'От чего я убегаю в этой ситуации?', 'Что для меня значит быть настоящим?']; 
    document.getElementById('askMirrorBtn').addEventListener('click', () => { const randomQ = mirrorQuestions[Math.floor(Math.random() * mirrorQuestions.length)]; document.getElementById('mirrorQuestion').textContent = (t.guru_question || 'Что я сейчас чувствую?') + ' ' + randomQ; }); 
    /* Тишина */ 
    let silenceInterval; 
    document.getElementById('startSilenceBtn').addEventListener('click', () => { const timer = document.getElementById('silenceTimer'); let seconds = 0; clearInterval(silenceInterval); silenceInterval = setInterval(() => { seconds++; timer.textContent = new Date(seconds * 1000).toISOString().substr(14, 5); }, 1000); }); 
    return; 
  }
  if (hallId === 'circle') {
    hallContentInner.innerHTML = `<h3 style="color:var(--accent-soft);"><i class="fa-solid fa-circle-nodes"></i> ${t.circle || 'Круг Соратников'}</h3><div id="circleLogin" class="key-item"><input type="text" id="circleName" value="${currentUser ? 'Архитектор ' + currentUser.address.substring(0,8) + '...' : ''}" placeholder="${t.your_name || 'Твоё имя'}" style="background:rgba(0,0,0,0.4);border:1px solid var(--accent-main);border-radius:8px;padding:0.7rem;color:#fff;width:100%;margin-bottom:0.5rem;"><select id="circleRoom" style="background:rgba(0,0,0,0.4);border:1px solid var(--accent-main);border-radius:8px;padding:0.7rem;color:#fff;width:100%;margin-bottom:0.5rem;"><option value="общий">${t.common_room || 'Общий круг'}</option><option value="утренняя">${t.morning_practice || 'Утренняя практика'}</option><option value="вечерняя">${t.evening_practice || 'Вечерняя практика'}</option></select><button id="joinCircleBtn" style="background:var(--accent-main);border:none;color:#fff;padding:0.7rem 2rem;border-radius:30px;cursor:pointer;width:100%;">${t.enter_circle || 'Войти в Круг'}</button></div><div id="circleChat" style="display:none;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;"><span id="onlineIndicator" style="color:var(--accent-soft);"></span><button id="leaveCircleBtn" style="background:transparent;border:1px solid var(--accent-main);color:var(--accent-main);padding:0.3rem 1rem;border-radius:20px;cursor:pointer;">✕</button></div><div id="circleMessages" style="height:300px;overflow-y:auto;background:rgba(0,0,0,0.3);border-radius:12px;padding:1rem;margin-bottom:1rem;"></div><div style="display:flex;gap:0.5rem;"><input type="text" id="circleMessageInput" placeholder="${t.message_placeholder || 'Напиши сообщение...'}" style="flex:1;background:rgba(0,0,0,0.4);border:1px solid var(--accent-main);border-radius:8px;padding:0.7rem;color:#fff;"><button id="sendCircleMsgBtn" style="background:var(--accent-main);border:none;color:#fff;padding:0.7rem 1.5rem;border-radius:8px;cursor:pointer;">${t.send || 'Отправить'}</button></div></div>`;
    if (typeof attachCircleEvents === 'function') attachCircleEvents();
    return;
  }

  try {
    const res = await fetch(`/api/contents/${hallId}?lang=${currentLang}`);
    const data = await res.json();
    if (!data.success || !data.data.length) { hallContentInner.innerHTML = '<p>' + (t.hall_empty || 'Empty') + '</p>'; return; }
    hallContentInner.innerHTML = data.data.map(item => `<div class="key-item"><h3>${item.title}</h3><p>${item.body.replace(/\n/g, '<br>')}</p></div>`).join('');
  } catch (err) { hallContentInner.innerHTML = '<p>' + (t.error_loading || 'Error') + '</p>'; }
}

// hallCards.forEach(card => card.addEventListener('click', () => showHall(card.getAttribute('data-hall'))));
backToMenuBtn.addEventListener('click', showMainMenu);
openGardenFromMenuBtn.addEventListener('click', () => { showHall('garden'); });

});
