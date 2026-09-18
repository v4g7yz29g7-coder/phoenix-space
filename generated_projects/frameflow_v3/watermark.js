function addWatermark(canvas, text) {
  const ctx = canvas.getContext('2d');
  const fontSize = Math.max(28, canvas.width * 0.03);
  ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';
  const padding = Math.round(canvas.width * 0.03);
  ctx.fillText(text, canvas.width - padding, canvas.height - padding);
  return canvas;
}
