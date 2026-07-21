// Модуль трекера целей (Цели)
(function() {
  let goals = JSON.parse(localStorage.getItem('phoenix_goals') || '[]');

  function renderGoals() {
    const container = document.getElementById('goalsContainer');
    if (!container) return;

    let html = '<div style="display:flex; gap:0.5rem; margin-bottom:1rem;">';
    html += '<input type="text" id="goalInput" placeholder="Опиши цель..." style="flex:1; background:rgba(0,0,0,0.4); border:1px solid rgba(255,140,0,0.3); border-radius:12px; padding:0.7rem; color:#fff; font-size:0.9rem;">';
    html += '<button id="addGoalBtn" style="background:#ff5500; border:none; color:#fff; padding:0.7rem 1.5rem; border-radius:12px; cursor:pointer; font-size:0.9rem;">Добавить</button>';
    html += '</div>';

    if (goals.length === 0) {
      html += '<p style="color:#aa8c7a; text-align:center; padding:1rem;">Пока целей нет. Добавь первую!</p>';
    } else {
      html += '<div id="goalsList" style="display:flex; flex-direction:column; gap:0.5rem;">';
      goals.forEach((goal, index) => {
        const completedStyle = goal.completed ? 'text-decoration: line-through; color: #aa8c7a;' : '';
        html += `
          <div style="display:flex; align-items:center; padding:0.5rem; background:rgba(255,255,255,0.03); border-radius:10px;">
            <input type="checkbox" ${goal.completed ? 'checked' : ''} data-index="${index}" style="margin-right:0.8rem; accent-color: #ff5500;">
            <span style="flex:1; ${completedStyle}">${goal.text}</span>
            <button data-index="${index}" class="delGoalBtn" style="background:none; border:none; color:#aa8c7a; cursor:pointer; font-size:1.2rem;">✕</button>
          </div>`;
      });
      html += '</div>';
    }
    container.innerHTML = html;

    // Обработчики добавления
    document.getElementById('addGoalBtn')?.addEventListener('click', () => {
      const input = document.getElementById('goalInput');
      if (!input.value.trim()) return;
      goals.push({ text: input.value.trim(), completed: false });
      localStorage.setItem('phoenix_goals', JSON.stringify(goals));
      input.value = '';
      renderGoals();
    });

    // Обработчики удаления и выполнения
    document.querySelectorAll('.delGoalBtn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = e.target.dataset.index;
        goals.splice(index, 1);
        localStorage.setItem('phoenix_goals', JSON.stringify(goals));
        renderGoals();
      });
    });

    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const index = e.target.dataset.index;
        goals[index].completed = e.target.checked;
        localStorage.setItem('phoenix_goals', JSON.stringify(goals));
        renderGoals();
      });
    });
  }

  // Экспортируем функцию инициализации глобально
  window.initGoalsModule = function() {
    renderGoals();
  };
})();
