/* Screenshot harness. The container ships Chromium 1194; the npm playwright
   wants 1234, so we point it at the binary that is actually here. */
const { chromium } = require('playwright');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function withPage(fn, { width = 900, height = 1200, dpr = 2 } = {}) {
  const b = await chromium.launch({ executablePath: EXE, args: ['--font-render-hinting=none'] });
  const p = await b.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  try { await fn(p); } finally { await b.close(); }
}
module.exports = { withPage, EXE };

if (require.main === module) {
  withPage(async p => {
    await p.setContent('<h1 style="font:600 40px system-ui">ok</h1>');
    await p.screenshot({ path: 'lab/smoke.png' });
    console.log('CHROMIUM OK');
  });
}
