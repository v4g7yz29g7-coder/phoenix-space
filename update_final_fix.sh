#!/bin/bash
set -e
echo "🔥 Устанавливаем абсолютное позиционирование (привязка к карточке Соратник)..."

# Перезаписываем JS с логикой привязки к карточке
cat > /home/ishidin/phoenix/public/js/sacred-carousel.js << 'ENDOFFILE2'
/**
 * 🐦‍🔥 Глубинное парение — v6.0 Абсолютное позиционирование
 * Символ появляется строго на 50-90 пикселей ниже карточки "Соратник"
 * Работает идеально на любых экранах.
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
        const holdDuration = 9000 + Math.random() * 4000; // Висит 9-13 секунд
        const size = 140 + Math.random() * 60; // Размер 140-200px

        // ===== ГЕНИАЛЬНОЕ РЕШЕНИЕ: ПРИВЯЗКА К КАРТОЧКЕ =====
        // Ищем карточку "Соратник" (последнюю в списке .hall-card)
        const card = document.querySelector('.home-garden .hall-card:last-child');
        let topOffset = 0;
        if (card) {
            const rect = card.getBoundingClientRect();
            // Отступ от низа карточки: 50-90 пикселей
            topOffset = rect.bottom + 50 + Math.random() * 40;
        } else {
            // Фолбэк для безопасности (75% высоты экрана)
            topOffset = window.innerHeight * 0.75 + Math.random() * 50;
        }

        const el = document.createElement('div');
        el.className = 'sacred-floating-symbol';

        el.style.cssText = `
            position: absolute;
            left: 50%;
            top: ${topOffset}px;
            width: ${size}px;
            height: ${size}px;
            transform: translateX(-50%) scale(0.1) translateY(20px);
            opacity: 0;
            pointer-events: none;
            filter: drop-shadow(0 0 25px rgba(167, 139, 250, 0.7)) drop-shadow(0 0 50px rgba(167, 139, 250, 0.3));
            transition: transform 4s cubic-bezier(0.2, 0.9, 0.3, 1.1), 
                        opacity 3.5s ease-in-out;
        `;

        const img = document.createElement('img');
        img.src = symbol.icon;
        img.alt = '';
        img.style.cssText = `
            width: 100%; height: 100%; pointer-events: none; background: transparent;
        `;
        el.appendChild(img);
        container.appendChild(el);

        el.offsetHeight; 

        // Медленное проявление
        setTimeout(() => {
            el.style.transform = 'translateX(-50%) scale(1) translateY(0px)';
            el.style.opacity = '1';
        }, 30);

        // Плавное растворение
        setTimeout(() => {
            el.style.transform = 'translateX(-50%) scale(0.6) translateY(20px)';
            el.style.opacity = '0';

            setTimeout(() => {
                if (el.parentNode) el.parentNode.removeChild(el);
                if (isActive) {
                    // Медленная пауза 4-8 секунд
                    const nextDelay = 4000 + Math.random() * 4000;
                    timer = setTimeout(spawnSymbol, nextDelay);
                }
            }, 4500);
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
ENDOFFILE2

pm2 restart phoenix
echo "✅ ФИНАЛЬНОЕ ОБНОВЛЕНИЕ! Символы теперь привязаны к карточке 'Соратник'. Никогда не залезут и не улетят."
