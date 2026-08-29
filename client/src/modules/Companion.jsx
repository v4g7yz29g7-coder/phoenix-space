export default function Companion() {
  return (
    <div className="hall-view">
      <h1>🤝 Сообщество</h1>
      <p style={{ color: '#a09ab8' }}>Диалог, дружба, сеть</p>

      <div className="halls-grid" style={{ marginTop: '2rem' }}>
        <div className="hall-card">
          <span className="hall-icon">💬</span>
          <h2>Диалог</h2>
          <p>Общение с другими</p>
          <span style={{ color: '#a78bfa', fontSize: '0.8rem' }}>Скоро</span>
        </div>
        <div className="hall-card">
          <span className="hall-icon">👥</span>
          <h2>Друзья</h2>
          <p>Круг доверия</p>
          <span style={{ color: '#a78bfa', fontSize: '0.8rem' }}>Скоро</span>
        </div>
        <div className="hall-card">
          <span className="hall-icon">🌐</span>
          <h2>Сеть</h2>
          <p>P2P-связи</p>
          <span style={{ color: '#a78bfa', fontSize: '0.8rem' }}>Скоро</span>
        </div>
      </div>
    </div>
  );
}
