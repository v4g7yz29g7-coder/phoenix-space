function renderCollage(photos, layout) {
  const container = document.getElementById('collage');
  if (!container) return;
  const config = getLayoutTemplate(layout || 'equal-cells');
  container.innerHTML = '';
  container.style.display = 'flex';
  container.style.flexWrap = 'wrap';
  container.style.gap = (config.gap || 10) + 'px';
  photos.forEach(function(file) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.style.width = '120px';
    img.style.height = '120px';
    img.style.objectFit = 'cover';
    img.style.borderRadius = '8px';
    container.appendChild(img);
  });
}
