// ========== МАСТЕРСКАЯ (АЛЛЕЙКА РЕМЁСЕЛ) ==========
async function loadArtifacts() {
  try {
    const res = await fetch('/api/artifacts');
    const data = await res.json();
    const gallery = document.getElementById('artifactsGallery');
    if (!gallery) return;
    if (!data.data || data.data.length === 0) {
      const t = window.currentLocale || {};
      gallery.innerHTML = '<p style="color:#aa8c7a;">' + (t.no_artifacts || 'Пока нет артефактов.') + '</p>';
      return;
    }
    gallery.innerHTML = data.data.map(a => `
      <div class="key-item">
        <h4>${a.title} <span style="font-size:0.8rem;color:#aa8c7a;">— ${a.author}</span></h4>
        <p>${a.description || ''}</p>
        ${a.file_path ? `<a href="${a.file_path}" target="_blank" style="color:var(--accent-soft);"><img src="/icons/link.svg" style="width:0.9em;vertical-align:middle;"> Скачать</a>` : ''}
        <small style="color:#aa8c7a;">${new Date(a.created_at).toLocaleDateString()}</small>
        <br>
        <button class="blockchain-btn" data-id="${a.id}" data-title="${a.title}" data-author="${a.author}" data-desc="${a.description || ''}" style="background:transparent;border:1px solid var(--accent-soft);color:var(--accent-soft);padding:0.3rem 0.8rem;border-radius:15px;cursor:pointer;font-size:0.75rem;margin-top:0.5rem;">
          <img src="/icons/link.svg" style="width:0.9em;vertical-align:middle;"> Записать в блокчейн
        </button>
      </div>
    `).join('');
    document.querySelectorAll('.blockchain-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const a = { id: btn.dataset.id, title: btn.dataset.title, author: btn.dataset.author, description: btn.dataset.desc };
        try {
          const res = await fetch('/api/blockchain/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ artifactId: a.id, title: a.title, author: a.author, description: a.description })
          });
          const d = await res.json();
          if (d.success) alert(`✅ "${a.title}" записан в блокчейн!\nTX: ${d.data.txHash.substring(0,20)}...`);
          else alert('❌ ' + (d.error || 'Ошибка'));
        } catch(e) { alert('❌ Блокчейн не отвечает'); }
      });
    });
  } catch(e) {}
}

function attachArtifactForm() {
  const form = document.getElementById('artifactForm');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await fetch('/api/artifacts', { method: 'POST', body: fd });
      form.reset();
      loadArtifacts();
    } catch(e) {}
  });
}
