/**
 * Renderiza um deck HTML (slides de 1280x720) em PDF.
 *
 *   node scripts/render-deck.js docs/outreach/racha-apresentacao-dinhos.html
 *
 * O PDF sai ao lado do HTML, com o mesmo nome. Requer Playwright — hoje ele vive
 * no repo do Seatable (restaurant-ai-mcp/node_modules), entao rode de la ou
 * instale aqui com `npm i -D playwright`.
 *
 * Alem de gerar o PDF, o script FALHA se algum elemento colidir com o rodape ou
 * vazar da caixa do slide. Conferir 8 slides no olho deixa isso passar — ja
 * deixou (deck do Dinho's, 07/08/2026: a caixa de destaque cobria o rodape em
 * dois slides).
 */
const path = require('path');
const { chromium } = require('playwright');

const SLIDE_W = 1280;
const SLIDE_H = 720;

async function renderDeck(htmlPath, { screenshotDir } = {}) {
  const abs = path.resolve(htmlPath);
  const out = abs.replace(/\.html?$/i, '.pdf');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: SLIDE_W, height: SLIDE_H } });
    await page.goto('file:///' + abs.replace(/\\/g, '/'), { waitUntil: 'networkidle' });

    // Sem isso o PDF cai pra serif do sistema e o Warm Glass morre.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);

    const fonts = await page.evaluate(() => ({
      serif: document.fonts.check('16px "Instrument Serif"'),
      sans: document.fonts.check('16px "DM Sans"'),
      mono: document.fonts.check('16px "JetBrains Mono"'),
    }));
    if (!fonts.serif || !fonts.sans) {
      throw new Error(`fontes nao carregaram: ${JSON.stringify(fonts)} — sem rede?`);
    }

    const collisions = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.slide').forEach((slide, i) => {
        const sb = slide.getBoundingClientRect();
        const foot = slide.querySelector('.foot');
        const footTop = foot ? foot.getBoundingClientRect().top - sb.top : sb.height;
        slide.querySelectorAll('.kicker, ul.clean, .grid, .lede, h1, h2').forEach((el) => {
          const bottom = el.getBoundingClientRect().bottom - sb.top;
          if (bottom > footTop - 6) {
            bad.push({ slide: i + 1, el: String(el.className || el.tagName), bottom: Math.round(bottom) });
          }
        });
      });
      return bad;
    });
    if (collisions.length) {
      throw new Error('colisao de layout:\n' + JSON.stringify(collisions, null, 1));
    }

    await page.pdf({
      path: out,
      width: `${SLIDE_W}px`,
      height: `${SLIDE_H}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    if (screenshotDir) {
      const slides = await page.$$('.slide');
      for (let i = 0; i < slides.length; i++) {
        await slides[i].screenshot({ path: path.join(screenshotDir, `slide-${i + 1}.png`) });
      }
    }

    return out;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  const [, , html, screenshotDir] = process.argv;
  if (!html) {
    console.error('uso: node scripts/render-deck.js <arquivo.html> [dir-screenshots]');
    process.exit(1);
  }
  renderDeck(html, { screenshotDir })
    .then((out) => console.log('pdf:', out))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { renderDeck };
