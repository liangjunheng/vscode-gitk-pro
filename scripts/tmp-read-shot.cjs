
const fs = require('node:fs');
const { chromium } = require('playwright');
(async () => {
  const file = process.argv[2];
  const b64 = fs.readFileSync(file).toString('base64');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const out = await page.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const px = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
      // 背景色 = 四角众数
      const corners = [px(0, 0), px(c.width - 1, 0), px(0, c.height - 1), px(c.width - 1, c.height - 1)].map(p => p.join(','));
      const counts = {}; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const k = px(x, y).join(','); counts[k] = (counts[k] || 0) + 1; }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
      return { w: c.width, h: c.height, corners, top, rows: Array.from({ length: c.height }, (_, y) => Array.from({ length: c.width }, (_, x) => px(x, y))) };
    }, b64);
    const bg = out.top[0][0].split(',').map(Number);
    const dist = p => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
    console.log('size ' + out.w + 'x' + out.h + '  corners ' + JSON.stringify(out.corners));
    console.log('dominant colours (rgba → pixels): ' + JSON.stringify(out.top));
    console.log('ascii (. = background, ░▒▓█ = increasingly different from background):');
    for (const row of out.rows) console.log(row.map(p => { const k = dist(p); return k < 12 ? '.' : k < 60 ? '░' : k < 130 ? '▒' : k < 220 ? '▓' : '█'; }).join(''));
    // 非背景像素的包围盒与主要前景色
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1; const fg = {};
    out.rows.forEach((row, y) => row.forEach((p, x) => { if (dist(p) >= 12) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); const k = p.slice(0, 3).join(','); fg[k] = (fg[k] || 0) + 1; } }));
    console.log('ink bounding box: x ' + minX + '..' + maxX + '  y ' + minY + '..' + maxY);
    console.log('top foreground colours: ' + JSON.stringify(Object.entries(fg).sort((a, b) => b[1] - a[1]).slice(0, 6)));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
