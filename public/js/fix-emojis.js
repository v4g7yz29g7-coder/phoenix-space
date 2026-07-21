// Модуль замены эмодзи на SVG-иконки
(function() {
  const emojiMap = {
    '🕊️': '/icons/dove.svg',
    '💎': '/icons/gem.svg',
    '🌿': '/icons/leaf.svg',
    '✨': '/icons/star.svg',
    '📝': '/icons/book.svg',
    '🌳': '/icons/tree.svg',
    '🔥': '/icons/fire.svg',
    '💧': '/icons/water.svg',
    '⛰️': '/icons/mountain.svg'
  };

  function replaceEmojis() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    const nodesToReplace = [];
    let node;
    while (node = walker.nextNode()) {
      for (const [emoji, icon] of Object.entries(emojiMap)) {
        if (node.textContent.includes(emoji)) {
          nodesToReplace.push({ node, emoji, icon });
        }
      }
    }
    nodesToReplace.forEach(({ node, emoji, icon }) => {
      const img = document.createElement('img');
      img.src = icon;
      img.style.width = '1.1em';
      img.style.verticalAlign = 'middle';
      img.style.margin = '0 0.2em';
      const newText = node.textContent.replace(new RegExp(emoji, 'g'), '');
      const textNode = document.createTextNode(newText);
      node.parentNode.insertBefore(img, node);
      node.parentNode.insertBefore(textNode, node);
      node.parentNode.removeChild(node);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', replaceEmojis);
  } else {
    replaceEmojis();
  }
})();
