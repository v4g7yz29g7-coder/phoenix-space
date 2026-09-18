import { useState } from 'react';

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
    <div style={{
      position: 'fixed',
      top: '20px',
      right: '20px',
      zIndex: 9999,
      background: 'red',
      padding: '20px',
      border: '3px solid yellow'
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid white',
          borderRadius: '8px',
          padding: '8px 16px',
          color: 'white',
          cursor: 'pointer',
          fontSize: '16px'
        }}
      >
        {current.flag} <span>{current.code.toUpperCase()}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: '8px',
          background: 'rgba(15,15,26,0.95)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '12px',
          padding: '8px',
          minWidth: '160px'
        }}>
          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => { setActive(lang.code); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '8px 12px',
                border: 'none',
                background: lang.code === active ? 'rgba(167,139,250,0.2)' : 'transparent',
                color: lang.code === active ? '#a78bfa' : '#a09ab8',
                cursor: 'pointer',
                borderRadius: '6px',
                fontSize: '14px'
              }}
            >
              {lang.flag} {lang.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
