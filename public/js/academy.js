function renderAcademyContent() {
  var c = document.getElementById('academy-content');
  if (!c) return;
  c.innerHTML = '';

  var sutras = [
    { title: 'Ключ Реальности', text: 'Нет разделения на духовное и материальное. Всё есть единая ткань бытия. Осознание приходит через принятие мира таким, какой он есть. Духовное не противостоит материальному — они танцуют вместе. Когда ты перестаёшь делить мир на «высокое» и «низкое», ты начинаешь видеть Реальность. Каждый момент содержит в себе всю глубину мироздания. Дыши и наблюдай.' },
    { title: 'Ключ Амбивалентности', text: 'Способность вмещать полярности — свет и тьму, радость и боль — есть признак зрелой души. Не выбирай одну сторону, держи обе. Свет не существует без тьмы. Радость не познать без боли. Когда ты принимаешь амбивалентность, ты перестаёшь бороться с собой. Ты становишься целым. Вмещай противоречия — в них твоя сила.' },
    { title: 'Ключ Парадоксальности', text: 'Жизнь полна противоречий. Именно в них рождается творчество. Не пытайся разрешить парадокс — танцуй с ним. Логика бессильна перед глубиной бытия. Сад растёт не по плану, а по любви. Прими, что ты одновременно силён и уязвим, знаешь и не знаешь, здесь и везде. Парадокс — это не ошибка, это портал.' },
    { title: 'Ключ Трансгрессии', text: 'Выход за пределы привычного — это не бунт, а рост. Каждый шаг в неизвестность расширяет границы твоего Сада. Трансгрессия — это не разрушение, а преодоление внутренних стен. То, что вчера казалось невозможным, сегодня становится твоей новой нормой. Иди туда, где страшно — там живёт твоя свобода.' },
    { title: 'Ключ Радикальности', text: 'Непоколебимая честность с собой — фундамент осознания. Смотри на себя без прикрас и без осуждения. Радикальная честность не требует критики — она требует ясности. Признай свои тени. Признай свой свет. Без этой честности все практики — лишь украшения на пустоте. Сними маски. Останься собой.' },
    { title: 'Ключ Природности', text: 'Действие без усилия, как вода из родника. Твоя истинная природа не нуждается в напряжении — она просто течёт. Дерево не старается расти. Вода не старается течь. Ты не должен стараться быть собой. Отпусти контроль. Доверься потоку. Природность — это не лень, это высшая форма мудрости.' }
  ];

  var practices = [
    { title: 'Дыхание Осознания', duration: '5 минут', text: 'Сядь удобно. Закрой глаза. Сделай 10 глубоких вдохов и выдохов. На вдохе говори про себя: «Я здесь». На выдохе: «Я есть». Почувствуй, как тело расслабляется с каждым выдохом. Заметь точки напряжения и отпусти их. После 10 циклов посиди в тишине ещё минуту. Открой глаза и посмотри на мир свежим взглядом.' },
    { title: 'Амбивалентная Медитация', duration: '10 минут', text: 'Вспомни ситуацию, которая вызывает у тебя противоречивые чувства. Представь, что ты держишь обе эмоции в ладонях — как два тёплых шара. Один шар — это то, что ты считаешь «хорошим». Другой — то, что ты считаешь «плохим». Не оценивай, просто наблюдай. Дыши ровно. Почувствуй, как напряжение между ними растворяется. Ты — не эти эмоции. Ты — пространство, в котором они встречаются.' },
    { title: 'Практика Природности', duration: '15 минут', text: 'Выйди на улицу или открой окно. Найди взглядом что-то живое — дерево, облако, птицу. Наблюдай без цели и без мыслей. Не анализируй. Не фотографируй. Просто будь с этим. Почувствуй, как ты часть этого мира. Почувствуй, что тебе не нужно ничего делать, чтобы быть. Ты уже есть. Это и есть Природность.' }
  ];

  var tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:8px;margin-bottom:20px;overflow-x:auto;padding:0 4px;justify-content:center';
  
  var sutrasBtn = document.createElement('button');
  sutrasBtn.textContent = '📖 Сутры';
  sutrasBtn.style.cssText = 'padding:8px 18px;border-radius:100px;border:1px solid var(--border);background:rgba(167,139,250,0.12);color:var(--violet);font-size:13px;cursor:pointer;white-space:nowrap;font-family:var(--font)';
  
  var practicesBtn = document.createElement('button');
  practicesBtn.textContent = '🧘 Практики';
  practicesBtn.style.cssText = 'padding:8px 18px;border-radius:100px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:13px;cursor:pointer;white-space:nowrap;font-family:var(--font)';

  tabBar.appendChild(sutrasBtn);
  tabBar.appendChild(practicesBtn);
  c.appendChild(tabBar);

  var contentArea = document.createElement('div');
  c.appendChild(contentArea);

  function createCard(title, subtitle, text) {
    var card = document.createElement('div');
    card.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;text-align:left;cursor:pointer;margin-bottom:8px';
    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="font-size:15px;font-weight:500;color:var(--text);margin:0">'+title+'</h3><span style="color:var(--muted);transition:transform 0.3s">▼</span></div>'+(subtitle?'<p style="font-size:12px;color:var(--muted);margin-top:4px">'+subtitle+'</p>':'')+'<div style="max-height:0;overflow:hidden;transition:max-height 0.4s ease;margin-top:0"><p style="color:var(--muted);font-size:14px;line-height:1.6;padding-top:12px;border-top:1px solid var(--border)">'+text+'</p></div>';
    
    var expanded = false;
    var body = card.querySelector('div:last-child');
    var arrow = card.querySelector('span');
    
    card.addEventListener('click', function() {
      expanded = !expanded;
      body.style.maxHeight = expanded ? '500px' : '0';
      body.style.marginTop = expanded ? '12px' : '0';
      arrow.style.transform = expanded ? 'rotate(180deg)' : 'rotate(0deg)';
    });
    
    return card;
  }

  function showSutras() {
    sutrasBtn.style.background = 'rgba(167,139,250,0.12)';
    sutrasBtn.style.color = 'var(--violet)';
    practicesBtn.style.background = 'var(--surface)';
    practicesBtn.style.color = 'var(--muted)';
    contentArea.innerHTML = '';
    sutras.forEach(function(s) { contentArea.appendChild(createCard(s.title, null, s.text)); });
  }

  function showPractices() {
    practicesBtn.style.background = 'rgba(167,139,250,0.12)';
    practicesBtn.style.color = 'var(--violet)';
    sutrasBtn.style.background = 'var(--surface)';
    sutrasBtn.style.color = 'var(--muted)';
    contentArea.innerHTML = '';
    practices.forEach(function(p) { contentArea.appendChild(createCard(p.title, p.duration, p.text)); });
  }

  sutrasBtn.onclick = showSutras;
  practicesBtn.onclick = showPractices;
  showSutras();
}

if (document.getElementById('academy-page') && document.getElementById('academy-page').classList.contains('active')) {
  setTimeout(renderAcademyContent, 50);
}
