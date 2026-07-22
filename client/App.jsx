import { Routes, Route, Link, useLocation } from 'react-router-dom';
import Academy from './modules/Academy';
import Workshop from './modules/Workshop';
import Companion from './modules/Companion';
import LanguageSwitcher from './components/LanguageSwitcher';
import LivingField from './components/LivingField';
import Mantra from './components/Mantra';

function Home() {
  return (
    <div className="home-garden">
      <h1 className="home-title">Привет, Архитектор</h1>
      <p className="home-subtitle">🐦‍🔥 Пространство пробуждения</p>
      <div className="halls-grid">
        <Link to="/academy" className="hall-card academy">
          <span className="hall-icon">📜</span>
          <h2>Академия</h2>
          <p>Войди в свою глубину</p>
        </Link>
        <Link to="/workshop" className="hall-card workshop">
          <span className="hall-icon">🛠️</span>
          <h2>Мастерская</h2>
          <p>Твори свои артефакты</p>
        </Link>
        <Link to="/companion" className="hall-card companion">
          <span className="hall-icon">🤝</span>
          <h2>Соратник</h2>
          <p>Диалог и дружба</p>
        </Link>
      </div>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const isHome = location.pathname === '/';

  const handleLivingField = (active) => {
    console.log('Живое Поле:', active ? 'активно' : 'не активно');
    // В будущем: открыть диалог с Гуру
  };

  return (
    <div className="app-shell">
      {/* Глобальные элементы */}
      <LanguageSwitcher />
      <LivingField onActivate={handleLivingField} />
      <Mantra />

      {/* Навигация "Назад" для внутренних страниц */}
      {!isHome && (
        <nav className="top-nav">
          <Link to="/" className="back-link">← ВЕРНУТЬСЯ К ЗАЛАМ</Link>
        </nav>
      )}

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/academy" element={<Academy />} />
        <Route path="/workshop" element={<Workshop />} />
        <Route path="/companion" element={<Companion />} />
      </Routes>
    </div>
  );
}
