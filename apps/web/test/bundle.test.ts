/**
 * O CENSO DO PACOTE — o que o cliente BAIXA, não o que a gente pretendia.
 *
 * Dois defeitos desta série vieram da mesma causa e nenhum era visível lendo o
 * componente: `import` estático de um módulo com EFEITO COLATERAL no corpo.
 *
 *  - `@stripe/stripe-js` (9.12.0) tem `loadScript(null)` no topo do
 *    `dist/index.mjs`: importar já injeta o `js.stripe.com` e dispara a
 *    impressão digital, mesmo com o componente devolvendo `null`. Uma conta de
 *    Pix brasileira, sem chave publicável nenhuma, chamava a Stripe.
 *  - `./auth` faz `createClient(...)` contra o Supabase do SEATABLE no corpo do
 *    módulo, e `main.tsx` importava as telas do dono estaticamente: o chunk que
 *    todo cliente baixa levava 158 KB de auth de outro produto — e, em
 *    navegador que já entrou no painel, RENOVAVA a sessão a partir da conta.
 *
 * Os dois foram consertados por render (`lazy`) e por import inerte
 * (`/pure`). Nenhum dos dois é garantido por isso: um `import` descuidado
 * refaz qualquer um, em silêncio, e nenhum teste de unidade vê.
 *
 * Este olha o BUILD. É o único jeito de afirmar "o cliente não fala com
 * ninguém" — o resto é intenção.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(import.meta.dirname, '..', 'dist', 'assets');

/** Os chunks de ENTRADA: o que carrega sem nenhuma navegação. */
function chunksDeEntrada(): string[] {
  return readdirSync(DIST).filter((f) => /^index-.*\.js$/.test(f));
}

const temBuild = existsSync(DIST) && chunksDeEntrada().length > 0;

test('o pacote de entrada não fala com terceiro nenhum', { skip: !temBuild && 'sem build — rode `npm run build`' }, () => {
  const proibidos = [
    'js.stripe.com',          // injeção da Stripe (impressão digital)
    'm.stripe.com',
    'm.stripe.network',
    'ckforlwdhewexyqljsaf',   // o projeto Supabase do Seatable
  ];
  const achados: string[] = [];
  for (const arquivo of chunksDeEntrada()) {
    const src = readFileSync(join(DIST, arquivo), 'utf8');
    for (const p of proibidos) if (src.includes(p)) achados.push(`${arquivo}: ${p}`);
  }
  assert.deepEqual(achados, [],
    'um import estático trouxe um terceiro de volta pro chunk que todo cliente baixa');
});

test('o `js.stripe.com` só existe atrás da chave publicável', { skip: !temBuild && 'sem build' }, () => {
  // Ele pode existir no pacote — o trilho de cartão precisa dele. O que não
  // pode é estar num chunk que carrega sem alguém pedir o cartão.
  const comStripe = readdirSync(DIST)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => readFileSync(join(DIST, f), 'utf8').includes('js.stripe.com'));
  for (const f of comStripe) {
    assert.ok(!/^index-/.test(f), `js.stripe.com no chunk de entrada (${f})`);
  }
});

test('o comprovante nunca mostra número sem a cobrança que o gerou', () => {
  /**
   * Censo de FONTE, no espírito do "a rota do painel MANDA os centavos".
   *
   * Toda transição pra tela de pago tem que gravar a cobrança junto — senão o
   * comprovante sai sem quantia (carteira/cartão, o trilho em que existe uma
   * FATURA pra conferir), ou pior: mostra a quantia da cobrança ANTERIOR com a
   * data da atual, que é valor afirmativamente errado.
   */
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const sites = [...src.matchAll(/setStep\('pago'\)/g)].map((m) => m.index!);
  assert.ok(sites.length >= 3, `esperava ao menos 3 caminhos pra tela de pago, achei ${sites.length}`);
  for (const i of sites) {
    const janela = src.slice(Math.max(0, i - 400), i);
    // Ou GRAVA a cobrança agora (carteira/cartão), ou LÊ a que já está em mão
    // (`charge &&` no guarda, `charge.txid` na confirmação — o caminho do Pix,
    // onde o `onPay` já gravou). O que não pode é chegar em `pago` sem nenhuma
    // das duas: aí o comprovante sai sem quantia.
    assert.match(janela, /setCharge\(|\bcharge\b/,
      'uma transição pra `pago` sem cobrança em mão — o comprovante sairia sem quantia');
  }
  // E "pagar outra parte" LIMPA, senão a 2ª parte herda o recibo da 1ª.
  assert.match(src, /setCharge\(null\)[\s\S]{0,120}setPaidAt\(null\)/,
    '`pagar outra parte` precisa limpar a cobrança e a data anteriores');
});
