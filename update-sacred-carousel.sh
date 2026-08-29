#!/bin/bash
# 🐦‍🔥 Сакральная карусель Феникса — интеграция
set -e

echo "🌿 Внедряю сакральную геометрию в Сад..."

# --- 1. СОЗДАЁМ SVG-ИКОНКИ (5 сакральных символов) ---
mkdir -p /home/ishidin/phoenix/public/shapes

# BG3 (Балансирующая форма)
cat > /home/ishidin/phoenix/public/shapes/bg3.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="2.5">
  <circle cx="50" cy="50" r="45"/>
  <path d="M50 5 L50 95 M5 50 L95 50"/>
  <ellipse cx="50" cy="50" rx="30" ry="45"/>
  <ellipse cx="50" cy="50" rx="45" ry="30"/>
</svg>
EOF

# Пирамида
cat > /home/ishidin/phoenix/public/shapes/pyramid.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="2.5">
  <polygon points="50,5 5,95 95,95"/>
  <line x1="50" y1="5" x2="50" y2="95"/>
  <line x1="50" y1="50" x2="5" y2="95"/>
  <line x1="50" y1="50" x2="95" y2="95"/>
</svg>
EOF

# Анкх
cat > /home/ishidin/phoenix/public/shapes/ankh.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="2.5">
  <path d="M50 95 L50 25"/>
  <circle cx="50" cy="20" r="15"/>
  <line x1="30" y1="60" x2="70" y2="60"/>
</svg>
EOF

# Цветок Жизни (упрощённый паттерн)
cat > /home/ishidin/phoenix/public/shapes/flower-of-life.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="2">
  <circle cx="50" cy="50" r="20"/>
  <circle cx="30" cy="40" r="20"/>
  <circle cx="70" cy="40" r="20"/>
  <circle cx="30" cy="60" r="20"/>
  <circle cx="70" cy="60" r="20"/>
  <circle cx="50" cy="30" r="20"/>
  <circle cx="50" cy="70" r="20"/>
</svg>
EOF

# Ключ Феникса (абстрактный взлёт)
cat > /home/ishidin/phoenix/public/shapes/phoenix-key.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="2.5">
  <path d="M20 80 Q50 20 80 80"/>
  <path d="M50 80 L50 40"/>
  <circle cx="50" cy="35" r="5"/>
  <circle cx="50" cy="55" r="3"/>
  <circle cx="50" cy="70" r="3"/>
</svg>
EOF

echo "✅ SVG-иконки созданы в /public/shapes/"

# --- 2. ОСНОВНОЙ МОДУЛЬ КАРУСЕЛИ (sacred-carousel.js) ---
cat > /home/ishidin/phoenix/public/js/sacred-carousel.js << 'EOF'
/**
 * 🐦‍🔥 Сакральная карусель Феникса
 * Биоинтерфейс на основе Биогеометрии (д-р Ибрагим Карим)
 * Эффект «вибрационной импрегнации» через сакральные формы
 */

(function() {
    // --- ДАННЫЕ САКРАЛЬНЫХ СИМВОЛОВ ---
    const sacredData = [
        { 
            icon: '/shapes/bg3.svg', 
            ru: 'Биогеометрический Баланс', 
            en: 'BioGeometry Balance', 
            zh: '生物几何平衡', 
            hi: 'बायोज्यामिति संतुलन', 
            ar: 'التوازن البيوغرافي' 
        },
        { 
            icon: '/shapes/pyramid.svg', 
            ru: 'Пирамида Сознания', 
            en: 'Pyramid of Consciousness', 
            zh: '意识金字塔', 
            hi: 'चेतना का पिरामिड', 
            ar: 'هرم الوعي' 
        },
        { 
            icon: '/shapes/ankh.svg', 
            ru: 'Ключ Жизни Анкх', 
            en: 'Ankh Key of Life', 
            zh: '生命之匙安赫', 
            hi: 'जीवन की कुंजी अंख', 
            ar: 'مفتاح الحياة عنخ' 
        },
        { 
            icon: '/shapes/flower-of-life.svg', 
            ru: 'Цветок Жизни', 
            en: 'Flower of Life', 
            zh: '生命之花', 
            hi: 'जीवन का फूल', 
            ar: 'زهرة الحياة' 
        },
        { 
            icon: '/shapes/phoenix-key.svg', 
            ru: 'Ключ Феникса', 
            en: 'Phoenix Key', 
            zh: '凤凰之钥', 
            hi: 'फीनिक्स कुंजी', 
            ar: 'مفتاح العنقاء' 
        }
    ];

    // --- ФУНКЦИЯ ПЕРЕВОДА ---
    function getTranslation(item) {
        const lang = localStorage.getItem('phoenix_lang') || 'ru';
        return item[lang] || item.ru;
    }

    // --- РЕНДЕР КАРУСЕЛИ ---
    function renderSacredCarousel() {
        // Удаляем старую карусель, если есть
        const existing = document.getElementById('sacred-carousel-section');
        if (existing) existing.remove();

        // Проверяем, что мы на главной
        const homePage = document.getElementById('home-page');
        if (!homePage || !homePage.classList.contains('active')) return;

        // Создаём секцию
        const section = document.createElement('div');
        section.id = 'sacred-carousel-section';
        section.className = 'sacred-section';

        // Заголовок
        const title = document.createElement('div');
        title.className = 'sacred-title';
        title.textContent = '🌿 Сакральный язык единства';
        section.appendChild(title);

        // Контейнер карусели
        const track = document.createElement('div');
        track.className = 'sacred-track';

        // Удваиваем массив для бесконечной анимации
        const doubledData = [...sacredData, ...sacredData];
        
        doubledData.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'sacred-card';
            
            const img = document.createElement('img');
            img.src = item.icon;
            img.alt = getTranslation(item);
            img.className = 'sacred-icon';
            img.loading = 'lazy';
            
            const label = document.createElement('span');
            label.className = 'sacred-label';
            label.textContent = getTranslation(item);

            card.appendChild(img);
            card.appendChild(label);
            track.appendChild(card);
        });

        section.appendChild(track);
        homePage.appendChild(section);
    }

    // --- ИНИЦИАЛИЗАЦИЯ ---
    function init() {
        renderSacredCarousel();

        // Слушаем смену языка и перерисовываем
        window.addEventListener('storage', function(e) {
            if (e.key === 'phoenix_lang') {
                renderSacredCarousel();
            }
        });

        // При ручной смене языка (если не через storage)
        const origSetItem = localStorage.setItem;
        localStorage.setItem = function(key, value) {
            origSetItem.apply(this, arguments);
            if (key === 'phoenix_lang') {
                renderSacredCarousel();
            }
        };
    }

    // Запускаем при загрузке и при возврате на главную
    document.addEventListener('DOMContentLoaded', init);
    
    // Патчим showPage для перерисовки при возврате на главную
    const origShowPage = window.showPage;
    window.showPage = function(n) {
        if (origShowPage) origShowPage(n);
        if (n === 'home') {
            setTimeout(renderSacredCarousel, 200);
        }
    };
})();
EOF

echo "✅ Модуль sacred-carousel.js создан"

# --- 3. ДОБАВЛЯЕМ СТИЛИ В app.css ---
cat >> /home/ishidin/phoenix/public/css/app.css << 'EOF'

/* ========== 🐦‍🔥 САКРАЛЬНАЯ КАРУСЕЛЬ ========== */
.sacred-section {
  margin-top: 28px;
  width: 100%;
  max-width: 100vw;
  overflow: hidden;
  position: relative;
}

.sacred-title {
  font-size: 13px;
  color: var(--muted);
  letter-spacing: 0.05em;
  margin-bottom: 14px;
  opacity: 0.7;
}

.sacred-track {
  display: flex;
  gap: 24px;
  width: max-content;
  animation: sacred-scroll 30s linear infinite;
  /* Маска по краям — символы исчезают в пространстве */
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0%,
    rgba(0,0,0,1) 15%,
    rgba(0,0,0,1) 85%,
    transparent 100%
  );
  mask-image: linear-gradient(
    to right,
    transparent 0%,
    rgba(0,0,0,1) 15%,
    rgba(0,0,0,1) 85%,
    transparent 100%
  );
}

/* Остановка при касании */
.sacred-track:hover {
  animation-play-state: paused;
}

@media (hover: none) {
  .sacred-track:active {
    animation-play-state: paused;
  }
}

.sacred-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  min-width: 80px;
  transition: opacity 0.5s ease, transform 0.5s ease;
  cursor: default;
  /* Лёгкое дыхание по синусоиде — эффект вибрационной импрегнации */
  animation: sacred-breathe 4s ease-in-out infinite;
}

.sacred-card:nth-child(odd) {
  animation-delay: -2s;
}

.sacred-icon {
  width: 48px;
  height: 48px;
  color: var(--violet);
  opacity: 0.8;
  transition: opacity 0.5s, transform 0.5s, color 0.5s;
}

.sacred-card:hover .sacred-icon {
  opacity: 1;
  color: var(--gold);
  transform: scale(1.1);
}

.sacred-label {
  font-size: 10px;
  color: var(--muted);
  text-align: center;
  max-width: 90px;
  line-height: 1.3;
  opacity: 0.6;
  transition: opacity 0.5s;
}

.sacred-card:hover .sacred-label {
  opacity: 1;
  color: var(--text);
}

/* Бесконечный скролл */
@keyframes sacred-scroll {
  0% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(-50%);
  }
}

/* Дыхание карусели (синусоида) */
@keyframes sacred-breathe {
  0%, 100% {
    opacity: 0.75;
    transform: translateY(0);
  }
  50% {
    opacity: 1;
    transform: translateY(-3px);
  }
}
EOF

echo "✅ Стили добавлены в app.css"

# --- 4. ПОДКЛЮЧАЕМ СКРИПТ В index.html ---
if ! grep -q "sacred-carousel.js" /home/ishidin/phoenix/public/index.html; then
  sed -i 's|<script src="/js/living-field.js">|<script src="/js/sacred-carousel.js"></script>\n  <script src="/js/living-field.js">|' /home/ishidin/phoenix/public/index.html
fi

echo "✅ Скрипт подключён в index.html"

# --- 5. ПЕРЕЗАПУСК ---
pm2 restart phoenix

echo ""
echo "🌿🐦‍🔥 Сакральная карусель внедрена."
echo "Символы дышат, балансируют и говорят на 5 языках."
echo "Открой https://phoenixsearch.ru — карусель ждёт внизу главной."
