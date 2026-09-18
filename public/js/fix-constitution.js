// Модуль восстановления ссылки на Конституцию
(function() {
  function addConstitutionLink() {
    const footer = document.querySelector('.subtitle-small') || document.querySelector('footer');
    if (!footer) return;
    // Проверяем, нет ли уже такой ссылки
    if (document.querySelector('a[href="/constitution"]')) return;
    const link = document.createElement('a');
    link.href = '/constitution';
    link.target = '_blank';
    link.textContent = '📜 Конституция';
    link.style.cssText = 'color: var(--soft, #ffb380); margin-left: 1rem; font-size: 0.8rem;';
    footer.appendChild(link);
  }
  // Ждём загрузки DOM и выполняем
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addConstitutionLink);
  } else {
    addConstitutionLink();
  }
})();
