import { useState, useEffect } from 'react';

export default function Workshop() {
  const [goals, setGoals] = useState([]);
  const [text, setText] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('phoenix_goals');
    if (saved) setGoals(JSON.parse(saved));
  }, []);

  const addGoal = () => {
    if (!text.trim()) return;
    const updated = [...goals, { id: Date.now(), text, done: false }];
    setGoals(updated);
    localStorage.setItem('phoenix_goals', JSON.stringify(updated));
    setText('');
  };

  const toggleGoal = (id) => {
    const updated = goals.map(g => g.id === id ? { ...g, done: !g.done } : g);
    setGoals(updated);
    localStorage.setItem('phoenix_goals', JSON.stringify(updated));
  };

  return (
    <div className="hall-view">
      <h1>🛠️ Мастерская</h1>
      <p style={{ color: '#a09ab8', marginBottom: '1rem' }}>Твори свои артефакты</p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Опиши свою цель..."
          style={{
            padding: '0.6rem 1rem',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.05)',
            color: '#f0eef8',
            width: '250px'
          }}
        />
        <button
          onClick={addGoal}
          style={{
            padding: '0.6rem 1.2rem',
            borderRadius: '8px',
            border: 'none',
            background: 'linear-gradient(135deg, #a78bfa, #fbbf24)',
            color: '#0a0a12',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Добавить
        </button>
      </div>

      <div style={{ width: '100%', maxWidth: '400px' }}>
        {goals.length === 0 ? (
          <p style={{ color: '#a09ab8' }}>Пока целей нет. Добавь первую!</p>
        ) : (
          goals.map(g => (
            <div
              key={g.id}
              onClick={() => toggleGoal(g.id)}
              style={{
                padding: '0.75rem 1rem',
                marginBottom: '0.5rem',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                textDecoration: g.done ? 'line-through' : 'none',
                opacity: g.done ? 0.5 : 1,
                cursor: 'pointer',
                textAlign: 'left'
              }}
            >
              {g.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
