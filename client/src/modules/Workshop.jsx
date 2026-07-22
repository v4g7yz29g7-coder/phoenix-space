import { useState, useEffect } from 'react';
export default function Workshop() {
  const [goals, setGoals] = useState([]);
  const [text, setText] = useState('');
  useEffect(() => {
    const stored = localStorage.getItem('phoenix_goals');
    if (stored) setGoals(JSON.parse(stored));
  }, []);
  const addGoal = () => {
    if (!text.trim()) return;
    const updated = [...goals, { id: Date.now(), text, created: new Date().toISOString() }];
    setGoals(updated);
    localStorage.setItem('phoenix_goals', JSON.stringify(updated));
    setText('');
  };
  return (
    <div className="hall-view">
      <h1 className="hall-title">🛠️ Мастерская</h1>
      <p className="hall-desc">Цели и артефакты</p>
      <div className="goals-input-area">
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Опиши свою цель..." className="goal-input" />
        <button onClick={addGoal} className="primary-button">Добавить цель</button>
      </div>
      <div className="goals-list">
        {goals.length === 0 ? (
          <div className="empty-state glass-card"><p>Пока целей нет. Добавь первую!</p></div>
        ) : goals.map(g => (
          <div key={g.id} className="glass-card goal-item">{g.text}</div>
        ))}
      </div>
    </div>
  );
}
