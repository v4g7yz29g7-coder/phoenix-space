// currentUser объявлена глобально

function initAuth() {
  const loginBlock = document.getElementById('loginBlock');
  const welcomeBlock = document.getElementById('welcomeBlock');
  const savedDID = JSON.parse(localStorage.getItem('phoenix_did') || 'null');

  if (savedDID && savedDID.mnemonic) {
    loginBlock.style.display = 'none';
    welcomeBlock.style.display = 'block';
    document.getElementById('displayName').textContent = 'Архитектор ' + savedDID.address.substring(0, 8) + '...';
    currentUser = savedDID;
  } else {
    loginBlock.style.display = 'block';
    welcomeBlock.style.display = 'none';
  }

  document.getElementById('loginBtn').addEventListener('click', () => {
    const input = document.getElementById('didInput').value.trim();
    if (!input) return alert('Введи 12 слов');
    try {
      const wallet = ethers.Wallet.fromMnemonic(input);
      const user = { address: wallet.address, did: `did:phoenix:${wallet.address}`, mnemonic: input };
      localStorage.setItem('phoenix_did', JSON.stringify(user));
      currentUser = user;
      loginBlock.style.display = 'none';
      welcomeBlock.style.display = 'block';
      document.getElementById('displayName').textContent = 'Архитектор ' + user.address.substring(0, 8) + '...';
    } catch(e) { alert('Неверная мнемоника'); }
  });

  document.getElementById('registerBtn').addEventListener('click', () => {
    const wallet = ethers.Wallet.createRandom();
    const user = { address: wallet.address, did: `did:phoenix:${wallet.address}`, mnemonic: wallet.mnemonic.phrase };
    localStorage.setItem('phoenix_did', JSON.stringify(user));
    currentUser = user;
    alert('Твой DID создан! Запиши 12 слов:\n\n' + user.mnemonic);
    loginBlock.style.display = 'none';
    welcomeBlock.style.display = 'block';
    document.getElementById('displayName').textContent = 'Архитектор ' + user.address.substring(0, 8) + '...';
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('phoenix_did');
    currentUser = null;
    welcomeBlock.style.display = 'none';
    loginBlock.style.display = 'block';
    document.getElementById('didInput').value = '';
  });
}

window.updateMainUI = function() {
  const t = window.currentLocale || {};
  const helloEl = document.getElementById('helloWord'); if (helloEl) helloEl.textContent = t.hello || 'Привет';
  const subtitle = document.querySelector('.subtitle'); if (subtitle) subtitle.textContent = t.subtitle_main || 'Пространство осознания';
  const profileLink = document.querySelector('a[href="/profile"]'); if (profileLink) profileLink.textContent = t.profile_btn || 'Профиль';
  const logoutBtn = document.getElementById('logoutBtn'); if (logoutBtn) logoutBtn.textContent = t.logout_btn || 'Выйти';
  const loginBtn = document.getElementById('loginBtn'); if (loginBtn) loginBtn.textContent = t.login_btn || 'Войти';
  const registerBtn = document.getElementById('registerBtn'); if (registerBtn) registerBtn.textContent = t.register_btn || 'Создать DID';
  const didInput = document.getElementById('didInput'); if (didInput) didInput.placeholder = t.did_placeholder || '12 слов или создать';
};

document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  setTimeout(window.updateMainUI, 100);
});
