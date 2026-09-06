/* Frame audit. Captures each resting state plus the grid→card morph at
   intermediate progress values, so a glitch that only exists mid-flight
   cannot hide. */
const { withPage } = require('./shot');
const fs = require('fs');

const OUT = __dirname;
const shots = [];

withPage(async p => {
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  await p.goto('http://127.0.0.1:8899/lab/preview.html');
  await p.waitForSelector('[data-ready]');
  // First run covers the app; dismiss it the way a real user would.
  await p.evaluate(() => obFinish('exemplo'));
  await p.waitForTimeout(700);

  const dev = await p.locator('.dev').boundingBox();
  const clip = { x: dev.x, y: dev.y, width: dev.width, height: dev.height };
  const shot = async n => { await p.screenshot({ path: `${OUT}/f-${n}.png`, clip }); shots.push(n); };

  await shot('0-grid');

  // Freeze the morph at fixed progress values.
  for (const z of [0.25, 0.5, 0.75]) {
    await p.evaluate(v => { window.anim && window.anim.stop(); open('ze'); anim && anim.stop(); applyZ(v); }, z);
    await p.waitForTimeout(140);
    await shot('1-morph-' + String(z).replace('.', ''));
  }

  await p.evaluate(() => { anim && anim.stop(); applyZ(1); });
  await p.waitForTimeout(200);
  await shot('2-card');

  await p.evaluate(() => { renderThread(); anim && anim.stop(); applyZ(2); });
  await p.waitForTimeout(300);
  await shot('3-thread');

  await p.evaluate(() => openSheet('ledger'));
  await p.waitForTimeout(500);
  await shot('4-ledger');

  await p.evaluate(() => { document.querySelectorAll('.sh').forEach(s => s.classList.remove('on')); openSheet('settle'); });
  await p.waitForTimeout(500);
  await shot('5-settle');

  // A second racha, to check the grid tile → card for a different dish.
  await p.evaluate(() => { document.querySelectorAll('.sh').forEach(s => s.classList.remove('on'));
    applyZ(0); open('lx'); anim && anim.stop(); applyZ(1); });
  await p.waitForTimeout(300);
  await shot('6-card-lx');

  fs.writeFileSync(`${OUT}/errors.txt`, errs.join('\n') || '(none)');
  console.log('shots:', shots.join(' '));
  console.log('console errors:', errs.length ? errs.slice(0, 8).join(' | ') : 'none');
}, { width: 540, height: 1180, dpr: 2 });
