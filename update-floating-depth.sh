#!/bin/bash
# 🐦‍🔥 Глубинное парение сакральных символов
set -e

echo "🌿 Запускаю медитативное пространство..."

# --- 1. Полностью переписываем sacred-carousel.js ---
cat > /home/ishidin/phoenix/public/js/sacred-carousel.js << 'EOF'
/**
 * 🐦‍🔥 Глубинное парение — Сакральные символы Феникса
 * Символы всплывают из темноты в случайных точках экрана,
 * дышат 4-6 секунд и исчезают обратно в глубину.
 * Не перекрывает клики (pointer-events: none).
 */

(function() {
    const sacredData = [
        { icon: '/shapes/bg3.svg', name: 'Биогеометрический Баланс' },
        { icon: '/shapes/pyramid.svg', name: 'Пирамида Сознания' },
        { icon: '/shapes/ankh.svg', name: 'Ключ Жизни Анкх' },
        { icon: '/shapes/flower-of-life.svg', name: 'Цветок Жизни' },
        { icon: '/shapes/phoenix-key.svg', name: 'Ключ Феникса' }
    ];

    let container = null;
    let timer = null;
    let lastIndex = -1;
    let lastX = -1;
    let lastY = -1;

    function createContainer() {
        if (document.getElementById('sacred-floating-layer')) return;
        
        container = document.createElement('div');
        container.id = 'sacred-floating-layer';
        container.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 500;
            pointer-events: none;
            overflow: hidden;
        `;
        document.body.appendChild(container);
    }

    function getRandomSymbol() {
        let index;
        do {
            index = Math.floor(Math.random() * sacredData.length);
        } while (index === lastIndex && sacredData.length > 1);
        lastIndex = index;
        return sacredData[index];
    }

    function getRandomPosition() {
        // Разброс по экрану с отступами от краёв
        const padding = 15; // % от края
        let x, y;
        
        // Избегаем правого верхнего угла (там языковой переключатель)
        // и нижних углов (Живое поле, О проекте)
        do {
            x = padding + Math.random() * (100 - padding * 2);
            y = padding + Math.random() * (100 - padding * 2);
        } while (
            (x > 75 && y < 20) ||  // правый верх
            (x > 80 && y > 80) ||  // правый низ
            (x < 20 && y > 80)     // левый низ
        );

        // Не повторяем ту же позицию
        if (Math.abs(x - lastX) < 15 && Math.abs(y - lastY) < 15) {
            x = padding + Math.random() * (100 - padding * 2);
            y = padding + Math.random() * (100 - padding * 2);
        }

        lastX = x;
        lastY = y;
        return { x, y };
    }

    function spawnSymbol() {
        if (!container) return;

        const symbol = getRandomSymbol();
        const pos = getRandomPosition();
        const duration = 4000 + Math.random() * 3000; // 4-7 секунд
        const size = 60 + Math.random() * 40; // 60-100px
        const delay = 2000 + Math.random() * 3000; // пауза перед следующим

        // Создаём элемент
        const el = document.createElement('div');
        el.className = 'sacred-floating-symbol';
        el.style.cssText = `
            position: absolute;
            top: ${pos.y}%;
            left: ${pos.x}%;
            width: ${size}px;
            height: ${size}px;
            opacity: 0;
            transform: scale(0.6);
            animation: sacred-emerge ${duration}ms ease-in-out forwards;
            filter: blur(0px);
        `;

        // Вставляем SVG
        const img = document.createElement('img');
        img.src = symbol.icon;
        img.alt = symbol.name;
        img.style.cssText = `
            width: 100%;
            height: 100%;
            filter: drop-shadow(0 0 ${size/4}px rgba(167,139,250,0.4));
            transition: filter 0.5s;
        `;
        el.appendChild(img);

        // Подпись (едва заметная)
        const label = document.createElement('div');
        label.textContent = symbol.name;
        label.style.cssText = `
            position: absolute;
            bottom: -20px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 10px;
            color: rgba(167,139,250,0.5);
            white-space: nowrap;
            letter-spacing: 0.05em;
            opacity: 0;
            transition: opacity 1s;
        `;
        el.appendChild(label);

        container.appendChild(el);

        // Плавное появление подписи
        setTimeout(() => { label.style.opacity = '1'; }, duration * 0.3);

        // Удаление после окончания анимации
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transition = 'opacity 1s ease-out';
            setTimeout(() => {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 1000);
        }, duration);

        // Запускаем следующий символ
        timer = setTimeout(spawnSymbol, duration + delay);
    }

    function init() {
        createContainer();
        
        // Показываем только на главной
        const homePage = document.getElementById('home-page');
        if (homePage && homePage.classList.contains('active')) {
            // Первый символ с небольшой задержкой
            setTimeout(spawnSymbol, 1500);
        }

        // Патчим showPage — запускаем/останавливаем при уходе/возврате
        const origShowPage = window.showPage;
        window.showPage = function(n) {
            if (origShowPage) origShowPage(n);
            
            if (n === 'home') {
                if (!container) createContainer();
                container.style.display = 'block';
                if (!timer) {
                    setTimeout(spawnSymbol, 1500);
                }
            } else {
                if (container) {
                    container.style.display = 'none';
                }
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                // Очищаем символы
                if (container) {
                    container.innerHTML = '';
                }
            }
        };
    }

    // Запуск
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
EOF

echo "✅ sacred-carousel.js переписан"

# --- 2. Обновляем стили в app.css — заменяем карусель на парение ---
# Удаляем старые стили карусели
sed -i '/САКРАЛЬНАЯ КАРУСЕЛЬ/,/EOF/d' /home/ishidin/phoenix/public/css/app.css 2>/dev/null
sed -i '/sacred-section/,/sacred-breathe/d' /home/ishidin/phoenix/public/css/app.css 2>/dev/null

# Добавляем новые стили
cat >> /home/ishidin/phoenix/public/css/app.css << 'EOF'

/* ========== 🐦‍🔥 ГЛУБИННОЕ ПАРЕНИЕ САКРАЛЬНЫХ СИМВОЛОВ ========== */
#sacred-floating-layer {
  pointer-events: none;
  user-select: none;
}

.sacred-floating-symbol {
  pointer-events: none;
  will-change: transform, opacity, filter;
}

/* Анимация всплытия из глубины */
@keyframes sacred-emerge {
  0% {
    opacity: 0;
    transform: scale(0.6);
    filter: blur(8px);
  }
  15% {
    opacity: 0.7;
    filter: blur(0px);
  }
  30% {
    opacity: 0.9;
    transform: scale(1.05);
  }
  50% {
    opacity: 0.85;
    transform: scale(1.0);
  }
  70% {
    opacity: 0.8;
    transform: scale(0.98);
  }
  85% {
    opacity: 0.5;
    filter: blur(0px);
  }
  100% {
    opacity: 0;
    transform: scale(0.5);
    filter: blur(12px);
  }
}

/* Медитативное мерцание фона для символов */
.sacred-floating-symbol img {
  animation: sacred-glow 3s ease-in-out infinite;
}

@keyframes sacred-glow {
  0%, 100% {
    filter: drop-shadow(0 0 8px rgba(167,139,250,0.3));
  }
  50% {
    filter: drop-shadow(0 0 20px rgba(167,139,250,0.6)) 
            drop-shadow(0 0 40px rgba(251,191,36,0.2));
  }
}
EOF

echo "✅ Стили глубинного парения добавлены"

# --- 3. Перезапуск ---
pm2 restart phoenix

echo ""
echo "🌿🐦‍🔥 Глубинное парение активировано."
echo "Сакральные символы всплывают из темноты, дышат и исчезают."
echo "Открой https://phoenixsearch.ru — побудь в тишине и наблюдай."
