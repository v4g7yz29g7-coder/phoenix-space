'use strict';
/**
 * vision_capture.js
 * Puppeteer screenshot capture from FORMULA_URL (3D scene).
 * Default output: /tmp/formula_i1.png (1920x1080).
 */

const fs = require('fs');
const puppeteer = require('puppeteer');

const DEFAULT_OUT = '/tmp/formula_i1.png';

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Capture a screenshot of the 3D formula scene.
 * @param {object} opts { url, out, width, height, settleMs, waitForCanvas }
 * @returns {Promise<{path:string, size:number, width:number, height:number}>}
 */
async function capture(opts = {}) {
  const url = opts.url || process.env.FORMULA_URL || 'http://localhost:3020/3d/';
  const out = opts.out || DEFAULT_OUT;
  const width = opts.width || 1920;
  const height = opts.height || 1080;
  const settleMs = opts.settleMs != null ? opts.settleMs : 3500;
  const waitForCanvas = opts.waitForCanvas !== false;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--window-size=' + width + ',' + height,
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    if (waitForCanvas) {
      try {
        await page.waitForSelector('canvas', { timeout: 15000 });
        // Ждём пока WebGL реально отрисует сцену
        await page.waitForFunction(() => {
          const canvas = document.querySelector('canvas');
          return canvas && canvas.width > 100 && canvas.height > 100;
        }, { timeout: 10000 });
        // Даём WebGL 5 секунд на рендер сцены + snapshot
        await new Promise(r => setTimeout(r, 5000));
      } catch (_) {
        /* no canvas - still try screenshot */
      }
    }
    await _sleep(settleMs);

    // Nudge the scene so animation/render loops flush a frame.
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))).catch(() => {});
    await _sleep(300);

    await page.screenshot({ path: out, type: 'png' });
    const stat = fs.statSync(out);
    return { path: out, size: stat.size, width, height };
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  capture()
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(0);
    })
    .catch((e) => {
      console.error('capture failed:', e.message);
      process.exit(1);
    });
}

module.exports = { capture, DEFAULT_OUT };
