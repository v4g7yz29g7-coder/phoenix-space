import { Link } from 'react-router-dom';

export default function Academy() {
  return (
    <div className="hall-view">
      <h1>📜 Познание</h1>
      <p style={{ color: '#a09ab8', marginBottom: '2rem' }}>Войди в свою глубину</p>

      <div className="halls-grid">
        <div className="hall-card">
          <span className="hall-icon">✦</span>
          <h2>Смыслы</h2>
          <p>Сутры и практики</p>
          <span style={{ color: '#a78bfa', fontSize: '0.8rem' }}>Скоро</span>
        </div>
        <div className="hall-card">
          <span className="hall-icon">💚</span>
          <h2>Исцеление</h2>
          <p>Внутренняя работа</p>
          <span style={{ color: '#a78bfa', fontSize: '0.8rem' }}>Скоро</span>
        </div>
      </div>
    </div>
  );
}
