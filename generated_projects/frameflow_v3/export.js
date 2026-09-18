async function exportCollage(dataUrls, layoutName, canvasSize) {
  try {
    const size = canvasSize || 1080;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    const padding = Math.round(size * 0.03);
    const gap = Math.round(size * 0.015);

    const drawCover = (img, x, y, w, h) => {
      const aPhoto = img.width / img.height;
      const aCell = w / h;
      let sw, sh, sx, sy;
      if (aPhoto > aCell) {
        sh = img.height; sw = sh * aCell; sx = (img.width - sw) / 2; sy = 0;
      } else {
        sw = img.width; sh = sw / aCell; sx = 0; sy = (img.height - sh) / 2;
      }
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    };
    const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });

    if (layoutName === 'carousel') {
      const pageH = Math.floor((size - padding * 2 - gap * (dataUrls.length - 1)) / dataUrls.length);
      for (let i = 0; i < dataUrls.length; i++) {
        const img = await load(dataUrls[i]);
        if (!img) continue;
        const y = padding + i * (pageH + gap);
        const x = padding;
        const w = size - padding * 2;
        drawCover(img, x, y, w, pageH);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 48px Arial';
        ctx.fillText('Кадр ' + (i + 1), x + 20, y + pageH - 20);
      }
    } else if (layoutName === 'before-after') {
      let y = padding;
      for (let i = 0; i < dataUrls.length; i += 2) {
        const img1 = await load(dataUrls[i]);
        const img2 = await load(dataUrls[i + 1]);
        if (!img1) continue;
        const w = (size - padding * 2 - gap) / 2;
        const h = w * 1.2;
        drawCover(img1, padding, y, w, h);
        if (img2) drawCover(img2, padding + w + gap, y, w, h);
        y += h + gap;
      }
    } else if (layoutName === 'moodboard') {
      const bigW = size * 0.6;
      const bigH = size * 0.6;
      const img = await load(dataUrls[0]);
      if (img) drawCover(img, padding, padding, bigW, bigH);
      const smallW = (size - padding * 2 - gap) / 2;
      const smallH = smallW;
      let x = padding + bigW + gap;
      let y = padding;
      for (let i = 1; i < dataUrls.length && i < 5; i++) {
        const im = await load(dataUrls[i]);
        if (!im) continue;
        drawCover(im, x, y, smallW, smallH);
        if ((i - 1) % 2 === 0) { y += smallH + gap; } else { x += smallW + gap; }
      }
    } else if (layoutName === 'filmstrip') {
      const h = size * 0.4;
      const w = h * 1.5;
      const totalW = dataUrls.length * (w + gap) - gap;
      let x = (size - totalW) / 2;
      const y = (size - h) / 2;
      for (let i = 0; i < dataUrls.length; i++) {
        const img = await load(dataUrls[i]);
        if (!img) continue;
        drawCover(img, x, y, w, h);
        x += w + gap;
      }
    } else if (layoutName === 'polaroid-stack') {
      const w = size * 0.45;
      const h = w * 1.2;
      for (let i = 0; i < dataUrls.length; i++) {
        const img = await load(dataUrls[i]);
        if (!img) continue;
        const x = (size - w) / 2 + i * 8;
        const y = (size - h) / 2 + i * 8;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur = 10;
        ctx.fillRect(x, y, w, h);
        ctx.shadowColor = 'transparent';
        const pad = w * 0.06;
        drawCover(img, x + pad, y + pad, w - pad * 2, h - pad * 2);
      }
    }

    addWatermark(canvas, 'FrameFlow');
    const link = document.createElement('a');
    link.download = 'frameflow_collage.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}
