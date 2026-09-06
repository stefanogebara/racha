const { withPage } = require('./shot');
withPage(async p => {
  await p.goto('http://127.0.0.1:8899/lab/sheet.html');
  await p.waitForSelector('[data-done]');
  await p.waitForTimeout(400);
  await p.screenshot({ path: __dirname + '/sheet.png', fullPage: true });
  console.log('ok');
}, { width: 1500, height: 1200, dpr: 2 });
