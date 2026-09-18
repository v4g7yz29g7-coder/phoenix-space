#!/bin/bash
# Исправление страницы О проекте
cd ~/phoenix

# 1. Удалить все about-page если есть
sed -i '/about-page/d' public/index.html

# 2. Найти строку с "ЖИВОЕ ПОЛЕ"
LINE=$(grep -n "ЖИВОЕ ПОЛЕ" public/index.html | head -1 | cut -d: -f1)

# 3. Вставить about-page перед ЖИВЫМ ПОЛЕМ
head -n $((LINE-1)) public/index.html > /tmp/index_part1.html
tail -n +${LINE} public/index.html > /tmp/index_part2.html

cat /tmp/index_part1.html > public/index.html
cat >> public/index.html << 'PAGE'
  <div id="about-page" class="page">
    <span class="back-link" onclick="showPage('home')">← Вернуться к Залам</span>
    <h1>🐦‍🔥 О проекте</h1>
    <div id="about-content" style="width:100%;max-width:800px;display:flex;flex-direction:column;gap:1rem;margin-top:1rem"></div>
  </div>
PAGE
cat /tmp/index_part2.html >> public/index.html

# 4. Проверить что about.js подключен
grep -q "about.js" public/index.html || sed -i 's|<script src="/js/academy.js"></script>|<script src="/js/academy.js"></script>\n  <script src="/js/about.js"></script>|' public/index.html

pm2 restart phoenix
echo "Готово. Обнови страницу."
