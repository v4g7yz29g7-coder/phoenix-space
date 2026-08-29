document.addEventListener('DOMContentLoaded', function() {
  var LANGUAGES = [
    { code: 'ru', label: 'Русский', file: 'ru.svg' },
    { code: 'en', label: 'English', file: 'en.svg' },
    { code: 'es', label: 'Español', file: 'es.svg' },
    { code: 'de', label: 'Deutsch', file: 'de.svg' },
    { code: 'fr', label: 'Français', file: 'fr.svg' },
    { code: 'zh', label: '中文', file: 'zh.svg' },
    { code: 'hi', label: 'हिन्दी', file: 'hi.svg' },
    { code: 'ar', label: 'العربية', file: 'ar.svg' },
    { code: 'pt', label: 'Português', file: 'pt.svg' }
  ];

  var current = localStorage.getItem('phoenix_lang') || 'ru';

  var div = document.createElement('div');
  div.id = 'lang-switcher';
  div.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;align-items:center;gap:10px';
  div.innerHTML = '<div style="position:relative"><button id="lang-btn" style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:8px 14px;color:#f0eef8;cursor:pointer;font-size:15px"></button><div id="lang-dropdown" style="display:none;position:absolute;top:100%;right:0;margin-top:8px;background:rgba(10,10,18,0.97);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:8px;min-width:180px;z-index:10000"></div></div><a href="/profile.html" style="font-size:22px;text-decoration:none;opacity:0.8" title="Профиль">👤</a>';
  document.body.appendChild(div);

  var btn = document.getElementById('lang-btn');
  var dropdown = document.getElementById('lang-dropdown');

  function flagImg(file) {
    return '<img src="/flags/' + file + '" width="24" height="16" style="vertical-align:middle;border-radius:2px" alt="">';
  }

  function updateBtn() {
    var lang = LANGUAGES.find(function(l) { return l.code === current; });
    btn.innerHTML = flagImg(lang.file) + ' <span style="vertical-align:middle">' + lang.code.toUpperCase() + '</span>';
  }

  function renderDropdown() {
    dropdown.innerHTML = '';
    LANGUAGES.forEach(function(lang) {
      var item = document.createElement('button');
      item.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;border:none;background:' + (lang.code === current ? 'rgba(167,139,250,0.2)' : 'transparent') + ';color:' + (lang.code === current ? '#a78bfa' : '#a09ab8') + ';cursor:pointer;border-radius:8px;font-size:14px;text-align:left';
      item.innerHTML = flagImg(lang.file) + ' ' + lang.label;
      item.onclick = function() {
        current = lang.code;
        localStorage.setItem('phoenix_lang', current);
        updateBtn();
        dropdown.style.display = 'none';
      };
      dropdown.appendChild(item);
    });
  }

  btn.onclick = function(e) {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
    renderDropdown();
  };

  document.addEventListener('click', function() {
    dropdown.style.display = 'none';
  });

  updateBtn();
});
