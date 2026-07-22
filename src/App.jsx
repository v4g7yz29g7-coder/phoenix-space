import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import LanguageSwitcher from './components/LanguageSwitcher';
import LivingField from './components/LivingField';
import Mantra from './components/Mantra';
import './App.css';

function Home() {
  return (
    <div className="home-garden">
      <h1 className="home-title">Привет, Архитектор</h1>
      <p className="home-subtitle">🐦‍🔥 Пространство пробуждения</p>
      <div className="halls-grid">
        <Link to="/academy" className="hall-card academy"><span className="hall-icon">📜</span><h2>Академия</h2><p>Мудрость, практики, исцеление</p></Link>
        <Link to="/workshop" className="hall-card workshop"><span className="hall-icon">🛠️</span><h2>Мастерская</h2><p>Творчество, цели, инициативы</p></Link>
        <Link to="/companion" className="hall-card companion"><span className="hall-icon">🤝</span><h2>Соратник</h2><p>Общение, дружба, сеть</p></Link>
      </div>
    </div>
  );
}

function Academy() {
  return (
    <div className="hall-view">
      <Link to="/" className="back-link">← Вернуться к Залам</Link>
      <h1>📜 Академия</h1>
      <p style={{ color: '#a09ab8' }}>Войди в свою глубину</p>
    </div>
  );
}

function Workshop() {
  return (
    <div className="hall-view">
      <Link to="/" className="back-link">← Вернуться к Залам</Link>
      <h1>🛠️ Мастерская</h1>
      <p style={{ color: '#a09ab8' }}>Твори свои артефакты</p>
    </div>
  );
}

function Companion() {
  return (
    <div className="hall-view">
      <Link to="/" className="back-link">← Вернуться к Залам</Link>
      <h1>🤝 Соратник</h1>
      <p style={{ color: '#a09ab8' }}>Диалог, дружба, сеть</p>
    </div>
  );
}

export default function App() {
  const handleLivingField = (active) => {
    console.log('Живое Поле:', active ? 'активно' : 'не активно');
  };
  return (
    <BrowserRouter>
      <div className="app-shell">
        <LanguageSwitcher />
        <LivingField onActivate={handleLivingField} />
        <Mantra />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/academy" element={<Academy />} />
          <Route path="/workshop" element={<Workshop />} />
          <Route path="/companion" element={<Companion />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
