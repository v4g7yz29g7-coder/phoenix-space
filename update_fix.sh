#!/bin/bash
set -e
echo "🔥 Исправляем свечение и позиционирование..."

# 1. Полностью перезаписываем SVG файлы (убираем жесткие цвета, ставим currentColor)
cat > /home/ishidin/phoenix/public/shapes/ankh.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="50" cy="28" rx="14" ry="14" />
    <line x1="50" y1="42" x2="50" y2="85" />
    <line x1="30" y1="62" x2="70" y2="62" />
    <path d="M 50,85 Q 45,92 50,98 Q 55,92 50,85" />
  </g>
</svg>
EOF

cat > /home/ishidin/phoenix/public/shapes/bg3.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <path d="M 20,80 Q 50,-10 80,80" />
    <path d="M 20,20 Q 80,90 80,20" />
    <circle cx="50" cy="50" r="30" stroke-dasharray="2 4" opacity="0.4"/>
    <circle cx="50" cy="50" r="4" fill="currentColor" />
  </g>
</svg>
EOF

cat > /home/ishidin/phoenix/public/shapes/flower-of-life.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="50" cy="50" r="26" />
    <circle cx="50" cy="24" r="26" />
    <circle cx="50" cy="76" r="26" />
    <circle cx="27.4" cy="63" r="26" />
    <circle cx="72.6" cy="63" r="26" />
    <circle cx="27.4" cy="37" r="26" />
    <circle cx="72.6" cy="37" r="26" />
    <circle cx="50" cy="50" r="6" fill="currentColor" />
  </g>
</svg>
EOF

cat > /home/ishidin/phoenix/public/shapes/phoenix-key.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="50" cy="50" r="40" stroke-dasharray="10 5" />
    <path d="M 50,10 L 50,15 M 50,85 L 50,90 M 10,50 L 15,50 M 85,50 L 90,50" />
    <path d="M 21.7,21.7 L 25,25 M 78.3,78.3 L 75,75 M 78.3,21.7 L 75,25 M 21.7,78.3 L 25,75" />
    <path d="M 50,50 L 35,35 M 50,50 L 65,65 M 50,50 L 65,35 M 50,50 L 35,65" />
    <circle cx="50" cy="50" r="5" fill="currentColor" />
  </g>
</svg>
EOF

cat > /home/ishidin/phoenix/public/shapes/pyramid.svg << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
    <polygon points="50,15 88,85 12,85" />
    <line x1="50" y1="15" x2="50" y2="85" opacity="0.4" />
    <circle cx="50" cy="50" r="35" stroke-dasharray="2 4" opacity="0.2" />
  </g>
</svg>
EOF

# 2. Переписываем sacred-carousel.js (цвета, адаптивное позиционирование, свечение)
cat > /home/ishidin/phoenix/public/js/sacred-carousel.js << 'ENDOFFILE'
/**
 * 🐦‍🔥 Глубинное парение — Сакральные символы Феникса
 * v5.3 — Идеальный баланс: SVG с currentColor, адаптив под десктоп и мобилку, золотое свечение
 */
(function() {
    const sacredData = [
        { icon: '/shapes/bg3.svg' },
        { icon: '/shapes/pyramid.svg' },
        { icon: '/shapes/ankh.svg' },
        { icon: '/shapes/flower-of-life.svg' },
        { icon: '/shapes/phoenix-key.svg' }
    ];

    let container = null;
    let timer = null;
    let isActive = false;

    function createContainer() {
        if (document.getElementById('sacred-floating-layer')) return;
        container = document.createElement('div');
        container.id = 'sacred-floating-layer';
        container.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            z-index: 9999; pointer-events: none; overflow: hidden;
        `;
        document.body.appendChild(container);
    }

    function getRandomSymbol() {
        let index;
        do {
            index = Math.floor(Math.random() * sacredData.length);
        } while (sacredData.length > 1 && index === sacredData._lastIndex);
        sacredData._lastIndex = index;
        return sacredData[index];
    }

    function spawnSymbol() {
        if (!container || container.style.display === 'none' || !isActive) return;
        if (container.querySelector('.sacred-floating-symbol')) return;

        const symbol = getRandomSymbol();
        const holdDuration = 8000 + Math.random() * 4000; // Висит 8-12 секунд
        
        // Размер: 120-170px
        const size = 120 + Math.random() * 50;           
        
        // Умное позиционирование: % от высоты экрана + случайное смещение
        // Это работает идеально и на мобилке, и на большом ноутбуке, не задевая карточки.
        const bottomOffset = Math.max(window.innerHeight * 0.15, 100) + Math.random() * 40; 

        const el = document.createElement('div');
        el.className = 'sacred-floating-symbol';

        // Цвет и свечение переносим на родительский div (благодаря currentColor в SVG)
        el.style.cssText = `
            position: absolute;
            left: 50%;
            bottom: ${bottomOffset}px;
            width: ${size}px;
            height: ${size}px;
            transform: translateX(-50%) scale(0.1) translateY(20px);
            opacity: 0;
            pointer-events: none;
            filter: blur(12px);
            color: #fbbf24; /* Базовый золотой цвет */
            filter: drop-shadow(0 0 30px rgba(255, 215, 0, 0.7)) drop-shadow(0 0 60px rgba(167, 139, 250, 0.3)) blur(12px);
            transition: transform 4s cubic-bezier(0.2, 0.9, 0.3, 1.1), 
                        opacity 3.5s ease-in-out, 
                        filter 3.5s ease-in-out;
        `;

        const img = document.createElement('img');
        img.src = symbol.icon;
        img.alt = '';
        // Убираем CSS-фильтр и фоны с самой картинки, чтобы не было квадратов
        img.style.cssText = `
            width: 100%; height: 100%; pointer-events: none; background: transparent;
        `;
        el.appendChild(img);
        container.appendChild(el);

        el.offsetHeight; // Принудительная перерисовка

        // Медленное проявление
        setTimeout(() => {
            // Снимаем blur и размытие, поднимаем с масштабированием
            el.style.transform = 'translateX(-50%) scale(1) translateY(0px)';
            el.style.opacity = '1';
            el.style.filter = 'drop-shadow(0 0 30px rgba(255, 215, 0, 0.7)) drop-shadow(0 0 60px rgba(167, 139, 250, 0.3)) blur(0px)';
        }, 30);

        // Плавное затухание
        setTimeout(() => {
            el.style.transform = 'translateX(-50%) scale(0.6) translateY(20px)';
            el.style.opacity = '0';
            el.style.filter = 'drop-shadow(0 0 30px rgba(255, 215, 0, 0.7)) drop-shadow(0 0 60px rgba(167, 139, 250, 0.3)) blur(15px)';

            setTimeout(() => {
                if (el.parentNode) el.parentNode.removeChild(el);
                if (isActive) {
                    const nextDelay = 4000 + Math.random() * 4000;
                    timer = setTimeout(spawnSymbol, nextDelay);
                }
            }, 4500); // Исчезает за 4.5 секунды

        }, holdDuration);
    }

    function startFloating() {
        if (!isActive) {
            isActive = true;
            container.style.display = 'block';
            timer = setTimeout(spawnSymbol, 2000);
        }
    }

    function stopFloating() {
        isActive = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (container) {
            container.querySelectorAll('.sacred-floating-symbol').forEach(el => el.remove());
            container.style.display = 'none';
        }
    }

    function init() {
        createContainer();
        const homePage = document.getElementById('home-page');
        if (!homePage) return;

        if (homePage.classList.contains('active')) {
            startFloating();
        }

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.attributeName === 'class') {
                    const isActivePage = homePage.classList.contains('active');
                    if (isActivePage) startFloating();
                    else stopFloating();
                }
            });
        });

        observer.observe(homePage, { attributes: true, attributeFilter: ['class'] });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
