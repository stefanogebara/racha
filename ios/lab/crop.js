// crop.js <png> <x> <y> <w> <h> <out>  — crop via Playwright (no PIL here)
const { chromium } = require('playwright');
(async () => {
  const [src, x, y, w, h, out] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const pg = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
  const data = require('fs').readFileSync(src).toString('base64');
  await pg.setContent(`<body style="margin:0;background:#000"><img src="data:image/png;base64,${data}" style="position:absolute;left:${-x}px;top:${-y}px"></body>`);
  await pg.screenshot({ path: out });
  await b.close(); console.log('cropped', out);
})();
