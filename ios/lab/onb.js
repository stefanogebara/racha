const { withPage } = require('./shot');
withPage(async p => {
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://127.0.0.1:8899/lab/preview.html');
  await p.waitForSelector('[data-ready]');
  await p.waitForTimeout(600);
  const clip = await p.locator('.dev').boundingBox();
  const shot = n => p.screenshot({ path: `${__dirname}/o-${n}.png`, clip });

  await shot('0-abertura');
  await p.evaluate(()=>obShow(1)); await p.waitForTimeout(600);
  await p.fill('#obName','Stefano');
  await p.fill('#obPix','stefano@exemplo.com');
  await p.waitForTimeout(200);
  await shot('1-nome');
  await p.evaluate(()=>obShow(2)); await p.waitForTimeout(700);
  await shot('2-doors');
  console.log('errors:', errs.length?errs.join('|'):'none');
}, { width: 540, height: 1180, dpr: 2 });
