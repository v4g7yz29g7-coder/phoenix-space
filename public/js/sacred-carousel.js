(function() {
    const sacredData = [
        { icon: '/shapes/bg3.svg' },
        { icon: '/shapes/pyramid.svg' },
        { icon: '/shapes/ankh.svg' },
        { icon: '/shapes/flower-of-life.svg' },
        { icon: '/shapes/phoenix-key.svg' }
    ];
    let container = null, timer = null, isActive = false, lastIndex = -1;
    function createContainer() { if (document.getElementById('sacred-floating-layer')) return; container = document.createElement('div'); container.id = 'sacred-floating-layer'; container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;pointer-events:none;display:none;overflow:hidden;'; document.body.appendChild(container); }
    function getRandomSymbol() { let index; do { index = Math.floor(Math.random() * sacredData.length); } while (index === lastIndex && sacredData.length > 1); lastIndex = index; return sacredData[index]; }
    function getRandomPosition(size) { const padding = 20; const bottomOffset = 140 + Math.random() * 200; const x = padding + Math.random() * (window.innerWidth - size - padding * 2); const y = window.innerHeight - bottomOffset - size; return { x, y }; }
    function spawnSymbol() { if (!container || !isActive) return; const symbol = getRandomSymbol(); const duration = 4000 + Math.random() * 3000; const size = 50 + Math.random() * 30; const delay = 2000 + Math.random() * 3000; const pos = getRandomPosition(size); const el = document.createElement('div'); el.className = 'sacred-floating-symbol'; el.style.cssText = `position:absolute;top:${pos.y}px;left:${pos.x}px;width:${size}px;height:${size}px;opacity:0;transform:scale(0.5) translateY(20px);pointer-events:none;animation:sacred-emerge ${duration}ms ease-out forwards;`; const img = document.createElement('img'); img.src = symbol.icon; img.alt=''; img.style.cssText='width:100%;height:100%;pointer-events:none;display:block;'; el.appendChild(img); container.appendChild(el); const removeTimer = setTimeout(() => { el.style.animation='none'; el.style.transition='opacity 1.5s ease-in-out, filter 1.5s ease-in-out, transform 1.5s ease-in-out'; el.style.opacity='0'; el.style.transform='scale(0.6)'; el.style.filter='blur(10px)'; setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 1500); }, duration); el._removeTimer = removeTimer; timer = setTimeout(spawnSymbol, duration + delay); }
    function startFloating() { if (timer) return; isActive = true; container.style.display = 'block'; spawnSymbol(); }
    function stopFloating() { isActive = false; if (timer) { clearTimeout(timer); timer=null; } if (container) { const syms=container.querySelectorAll('.sacred-floating-symbol'); syms.forEach(el=>{ if(el._removeTimer) clearTimeout(el._removeTimer); el.remove(); }); container.style.display='none'; } }
    function init() { createContainer(); const homePage = document.getElementById('home-page'); if (!homePage) return; if (homePage.classList.contains('active')) startFloating(); setInterval(() => { const homeActive = homePage.classList.contains('active'); if (homeActive && !isActive) startFloating(); else if (!homeActive && isActive) stopFloating(); }, 100); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
