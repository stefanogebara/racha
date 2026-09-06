/* One image, four screens, no annotations — the critic should judge the design,
   not a presentation of it. */
const { withPage } = require('./shot');
const N = process.argv[2] || '1';

withPage(async p => {
  await p.goto('http://127.0.0.1:8899/lab/critique.html?n=' + N);
  await p.waitForSelector('[data-done]', { timeout: 30000 });
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${__dirname}/critique-${N}.png` });
  console.log('captured critique-' + N + '.png');
}, { width: 1680, height: 980, dpr: 2 });
