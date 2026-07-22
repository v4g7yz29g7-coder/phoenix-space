import { useState, useEffect } from 'react';
export default function Academy() {
  const [sutras, setSutras] = useState([]);
  useEffect(() => {
    fetch('/api/sutras')
      .then(res => res.json())
      .then(data => setSutras(data))
      .catch(() => setSutras([]));
  }, []);
console.log('TEST_VITE_CHANGE_123');
  return (
    <div className="hall-view">
      <h1 className="hall-title">📜 Академия</h1>
      <p className="hall-desc">Войди в свою глубину</p>
      <div className="content-list">
        {sutras.length === 0 ? (
          <div className="empty-state glass-card"><p>Сутры загружаются…</p></div>
        ) : sutras.map(s => (
          <div key={s.id} className="glass-card"><h3>{s.title}</h3><p>{s.content}</p></div>
        ))}
      </div>
    </div>
  );
}
