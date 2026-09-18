// ========== ШКОЛА ЖИЗНИ (полная версия) ==========
(function enhanceLifeSchool() {
  // Дожидаемся, пока academy.js загрузится и showHall станет доступна
  const checkInterval = setInterval(() => {
    if (typeof showHall === 'function') {
      clearInterval(checkInterval);
      initLifeSchool();
    }
  }, 100);

  function initLifeSchool() {
    const originalShowHall = showHall;
    showHall = async function(hallId) {
      if (hallId === 'life-school') {
        mainMenu.style.display = 'none';
        hallContent.style.display = 'block';
        hallContentInner.dataset.currentHall = 'life-school';
        const t = window.currentLocale || {};

        let html = `
          <div style="text-align:center; margin-bottom:1.5rem;">
            <img src="/icons/tree.svg" style="width:3rem; height:3rem; filter:drop-shadow(0 0 15px var(--accent-glow)); animation: float 3s ease-in-out infinite;"/>
          </div>
          <div style="display:flex; gap:0.8rem; justify-content:center; margin-bottom:2rem;">
            <button class="school-tab active" data-tab="goals" style="background:var(--accent-main);border:none;color:#fff;padding:0.6rem 1.8rem;border-radius:30px;cursor:pointer;font-size:0.95rem;transition:all 0.3s ease;box-shadow:0 0 15px rgba(255,100,0,0.3);">${t.goals_tab || '🎯 Цели'}</button>
            <button class="school-tab" data-tab="friends" style="background:transparent;border:1px solid var(--accent-main);color:var(--accent-main);padding:0.6rem 1.8rem;border-radius:30px;cursor:pointer;font-size:0.95rem;transition:all 0.3s ease;">${t.friends_tab || '🤝 Дружба'}</button>
            <button class="school-tab" data-tab="dialogue" style="background:transparent;border:1px solid var(--accent-main);color:var(--accent-main);padding:0.6rem 1.8rem;border-radius:30px;cursor:pointer;font-size:0.95rem;transition:all 0.3s ease;">${t.dialogue_tab || '💬 Диалог'}</button>
            <button class="school-tab" data-tab="silence" style="background:transparent;border:1px solid var(--accent-main);color:var(--accent-main);padding:0.6rem 1.8rem;border-radius:30px;cursor:pointer;font-size:0.95rem;transition:all 0.3s ease;">${t.meditation_title || '🕯️ Тишина'}</button>
          </div>
          <div id="tab-goals" class="school-panel active">
            <div class="key-item" style="border-left: none; background: rgba(255,255,255,0.02); border-radius:16px; padding:1.5rem;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
                <h4 style="margin:0; font-size:1.2rem; color:var(--accent-soft);">${t.goals_tab || 'Цели'}</h4>
                <span style="font-size:0.8rem; color:#aa8c7a;" id="goalsCount">0 ${t.progress || 'в процессе'}</span>
              </div>
              <div id="goalsList" style="margin-bottom:1rem;"></div>
              <div style="display:flex; gap:0.5rem;">
                <input type="text" id="goalInput" placeholder="${t.goal_placeholder || 'Опиши цель...'}" style="flex:1; background:rgba(0,0,0,0.4); border:1px solid rgba(255,140,0,0.3); border-radius:12px; padding:0.7rem; color:#fff; font-size:0.9rem;" autocomplete="off">
                <button id="addGoalBtn" style="background:var(--accent-main); border:none; color:#fff; padding:0.7rem 1.5rem; border-radius:12px; cursor:pointer; font-size:0.9rem; transition: all 0.2s;"><img src="/icons/plus.svg" style="width:1rem; vertical-align:middle;"> ${t.add_goal || 'Добавить'}</button>
              </div>
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
              <div style="display:flex; gap:1rem; align-items:flex-start;">
                <div style="width:50px; height:50px; background: radial-gradient(circle, var(--accent-soft), var(--accent-main)); border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:1.5rem; box-shadow:0 0 15px var(--accent-glow);">🪞</div>
                <div style="flex:1;">
                  <div id="mirrorQuestion" style="font-style:italic; color:#ffd9b3; font-size:1rem; margin-bottom:1rem;">${t.guru_question || 'Что я сейчас чувствую?'}</div>
                  <div style="display:flex; gap:0.5rem; margin-bottom:1rem;">
                    <button id="askMirrorBtn" style="background:var(--accent-main); border:none; color:#fff; padding:0.5rem 1.2rem; border-radius:20px; cursor:pointer; font-size:0.85rem; transition: all 0.2s;">${t.ask_guru || 'Задать вопрос'}</button>
                  </div>
                  <textarea id="thoughtsArea" placeholder="${t.your_thoughts || 'Что приходит в голову...'}" style="width:100%; height:100px; background:rgba(0,0,0,0.4); border:1px solid rgba(255,140,0,0.3); border-radius:12px; padding:0.7rem; color:#fff; resize:vertical; font-size:0.9rem;"></textarea>
                  <button id="saveThoughtBtn" style="background:var(--accent-main); border:none; color:#fff; padding:0.5rem 1.2rem; border-radius:20px; cursor:pointer; margin-top:0.5rem; font-size:0.85rem;">${t.save_thought || 'Сохранить заметку'}</button>
                  <div id="thoughtsHistory" style="margin-top:1rem;"></div>
                </div>
              </div>
            </div>
          </div>
          <div id="tab-silence" class="school-panel">
            <div class="key-item" style="text-align:center; padding:2rem;">
              <div style="font-size:3rem; margin-bottom:1rem;">🕯️</div>
              <h4>${t.meditation_title || 'Тишина'}</h4>
              <p style="color:#aa8c7a;">Просто побудь здесь. Ничего не нужно делать.</p>
              <div id="silenceTimer" style="font-size:2rem; color:var(--accent-soft); margin:1rem 0;">00:00</div>
              <button id="startSilenceBtn" style="background:var(--accent-main); border:none; color:#fff; padding:0.5rem 1.5rem; border-radius:20px; cursor:pointer;">Начать</button>
            </div>
          </div>
        `;
        hallContentInner.innerHTML = html;

        // Вкладки
        const tabBtns = hallContentInner.querySelectorAll('.school-tab');
        const panels = hallContentInner.querySelectorAll('.school-panel');
        tabBtns.forEach(btn => {
          btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            tabBtns.forEach(b => { b.classList.remove('active'); b.style.background = 'transparent'; b.style.color = 'var(--accent-main)'; b.style.boxShadow = 'none'; b.style.border = '1px solid var(--accent-main)'; });
            panels.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            btn.style.background = 'var(--accent-main)';
            btn.style.color = '#fff';
            btn.style.boxShadow = '0 0 15px rgba(255,100,0,0.3)';
            btn.style.border = 'none';
            hallContentInner.querySelector('#tab-' + target).classList.add('active');
          });
        });

        // Цели
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

        // Зеркало
        const mirrorQuestions = ['Что я сейчас чувствую в теле?', 'Какая мысль крутится в голове прямо сейчас?', 'За что я могу сказать себе спасибо?', 'От чего я убегаю в этой ситуации?', 'Что для меня значит быть настоящим?'];
        document.getElementById('askMirrorBtn').addEventListener('click', () => { const randomQ = mirrorQuestions[Math.floor(Math.random() * mirrorQuestions.length)]; document.getElementById('mirrorQuestion').textContent = (t.guru_question || 'Что я сейчас чувствую?') + ' ' + randomQ; });
        document.getElementById('saveThoughtBtn').addEventListener('click', () => { const thought = document.getElementById('thoughtsArea').value; if (!thought.trim()) return; const thoughtsKey = 'phoenix_thoughts_' + (currentUser?.did || 'anonymous'); const thoughts = JSON.parse(localStorage.getItem(thoughtsKey) || '[]'); thoughts.push({ text: thought, time: new Date().toISOString() }); localStorage.setItem(thoughtsKey, JSON.stringify(thoughts)); document.getElementById('thoughtsArea').value = ''; const history = document.getElementById('thoughtsHistory'); if (history) { history.innerHTML = '<h5 style="color:var(--accent-soft); margin-bottom:0.5rem;">📝 Твой дневник</h5>' + thoughts.slice(-5).map(th => `<div style="font-size:0.8rem; color:#ccbbaa; padding:0.3rem 0; border-bottom:1px solid rgba(255,255,255,0.05);">${th.text} <small style="color:#aa8c7a;">${new Date(th.time).toLocaleString()}</small></div>`).join(''); } });

        // Тишина
        let silenceInterval;
        document.getElementById('startSilenceBtn').addEventListener('click', () => { const timer = document.getElementById('silenceTimer'); let seconds = 0; clearInterval(silenceInterval); silenceInterval = setInterval(() => { seconds++; timer.textContent = new Date(seconds * 1000).toISOString().substr(14, 5); }, 1000); });
        return;
      }
      return originalShowHall(hallId);
    };
  }
})();
