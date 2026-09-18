import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import LanguageSwitcher from './components/LanguageSwitcher';
import LivingField from './components/LivingField';
import Mantra from './components/Mantra';
import Academy from './modules/Academy';
import Workshop from './modules/Workshop';
import Companion from './modules/Companion';
import './App.css';

function Home() {
  return (
    <div className="home-garden">
      <h1 className="home-title">Привет, Архитектор</h1>
      <p className="home-subtitle">🦅 Пространство пробуждения</p>
      <div className="halls-grid">
        <Link to="/poznanie" className="hall-card academy">
          <span className="hall-icon">📜</span>
          <h2>Познание</h2>
          <p>Смыслы и исцеление</p>
        </Link>
        <Link to="/workshop" className="hall-card workshop">
          <span className="hall-icon">🛠️</span>
          <h2>Мастерская</h2>
          <p>Творчество, цели, инициативы</p>
        </Link>
        <Link to="/community" className="hall-card companion">
          <span className="hall-icon">🤝</span>
          <h2>Сообщество</h2>
          <p>Общение, дружба, сеть</p>
        </Link>
      </div>
    </div>
  );
}

function AppRoutes() {
  const location = useLocation();
  const isHome = location.pathname === '/';

  return (
    <div className="app-shell">
      <div className="top-right-group">
        <LanguageSwitcher />
        <a href="/profile.html" className="profile-link" title="Профиль">👤</a>
      </div>
      <LivingField onActivate={(active) => console.log('Живое Поле:', active)} />
      <Mantra />
      {!isHome && (
        <nav className="top-nav">
          <Link to="/" className="back-link">← ВЕРНУТЬСЯ К ЗАЛАМ</Link>
        </nav>
      )}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/poznanie" element={<Academy />} />
        <Route path="/workshop" element={<Workshop />} />
        <Route path="/community" element={<Companion />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

// ЯВНЫЙ ЭКСПОРТ ДЛЯ VITE — чтобы компонент не был выброшен
export { LanguageSwitcher, LivingField, Mantra };
