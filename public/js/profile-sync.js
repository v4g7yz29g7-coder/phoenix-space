// Модуль синхронизации профиля с сервером
(function() {
  // Ждём, пока страница загрузится и появится форма профиля
  document.addEventListener('DOMContentLoaded', function() {
    // Проверяем, есть ли DID и форма профиля
    const did = JSON.parse(localStorage.getItem('phoenix_did') || '{}');
    if (!did.did) return; // Нет DID — нечего синхронизировать

    // Перехватываем событие сохранения профиля
    const observer = new MutationObserver(function() {
      const saveBtn = document.querySelector('#editForm button');
      if (saveBtn) {
        // Добавляем наш код к существующей кнопке "Сохранить"
        const originalSave = window.saveProfile;
        if (originalSave && !originalSave._patched) {
          window.saveProfile = async function() {
            // Сначала вызываем оригинальное сохранение (локальное)
            await originalSave();
            
            // Затем отправляем на сервер
            const profile = JSON.parse(localStorage.getItem('phoenix_profile') || '{}');
            if (profile.name || profile.avatar) {
              try {
                const formData = new FormData();
                formData.append('did', did.did);
                formData.append('display_name', profile.name || '');
                
                // Если аватар — это base64, конвертируем в файл
                if (profile.avatar && profile.avatar.startsWith('data:image')) {
                  const blob = await (await fetch(profile.avatar)).blob();
                  formData.append('avatar', blob, 'avatar.jpg');
                }
                
                await fetch('/api/profile/update', { method: 'POST', body: formData });
                console.log('✅ Профиль синхронизирован с сервером');
              } catch(e) {
                console.log('⚠️ Не удалось синхронизировать профиль:', e);
              }
            }
          };
          window.saveProfile._patched = true;
          observer.disconnect(); // Отключаем наблюдение после патча
        }
      }
    });
    
    // Начинаем наблюдать за появлением формы редактирования
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
