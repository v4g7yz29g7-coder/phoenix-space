import { useState } from 'react';
import './LanguageSwitcher.css';
const LANGUAGES = [
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
];
export default function LanguageSwitcher() {
  const [active, setActive] = useState('ru');
  const [open, setOpen] = useState(false);
  const current = LANGUAGES.find(l => l.code === active);
  return (
    <div className="lang-switcher">
      <button className="lang-current" onClick={() => setOpen(!open)}>
        {current.flag} <span>{current.code.toUpperCase()}</span>
      </button>
      {open && (
        <div className="lang-dropdown">
          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              className={`lang-option ${lang.code === active ? 'active' : ''}`}
              onClick={() => { setActive(lang.code); setOpen(false); }}
            >
              {lang.flag} {lang.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
