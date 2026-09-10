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
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(import.meta.dirname, '..', 'dist', 'assets');

/** Os chunks de ENTRADA: o que carrega sem nenhuma navegação. */
function chunksDeEntrada(): string[] {
  return readdirSync(DIST).filter((f) => /^index-.*\.js$/.test(f));
}

/**
 * O guarda NÃO PODE PULAR.
 *
 * Era `{ skip: !temBuild }`: `dist/` é gitignored e o script de teste não
 * construía nada, então num clone limpo — que é o que a CI é — as duas
 * afirmações sobre terceiro reportavam PASSOU-POR-PULO. E o
 * `docs/compliance/data-map.md` cita este arquivo como a garantia de que "a
 * Stripe não é carregada em conta que não usa cartão". Um documento citando um
 * teste que pula é a mesma degradação-aberta que já custou doze dias no
 * Seatable, só que em compliance.
 *
 * Pior que o pulo: contra um `dist/` VELHO ele passa afirmando sobre um código
 * que não é mais o do repositório. Por isso a frescura também é asserção — e
 * por isso o `npm test` do app agora constrói antes. Achado da revisão de
 * segurança de 2026-09-10.
 */
function exigirBuildFresco(): void {
  assert.ok(existsSync(DIST) && chunksDeEntrada().length > 0,
    'sem build: `npm --prefix apps/web run build` antes do teste. Este guarda não pula.');
  const maisNovo = (dir: string): number => readdirSync(dir, { withFileTypes: true })
    .reduce((max, e) => {
      const p = join(dir, e.name);
      return Math.max(max, e.isDirectory() ? maisNovo(p) : statSync(p).mtimeMs);
    }, 0);
  const fonte = maisNovo(join(import.meta.dirname, '..', 'src'));
  const build = maisNovo(DIST);
  assert.ok(build >= fonte,
    `build velho (${new Date(build).toISOString()}) é mais antigo que o src `
    + `(${new Date(fonte).toISOString()}) — o que está sendo garantido não é o código que existe`);
}

test('o pacote de entrada não fala com terceiro nenhum', () => {
  exigirBuildFresco();
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

test('o `js.stripe.com` só existe atrás da chave publicável', () => {
  exigirBuildFresco();
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

/* ── o que a gente MANDA pro terceiro ────────────────────────────────────── */

/**
 * Os testes acima perguntam QUEM o cliente carrega. Este pergunta O QUE a gente
 * entrega — e era o eixo que faltava.
 *
 * `confirmParams.return_url` era `window.location.href`, e a página da conta é
 * `/?t=<qrToken>`. O token da mesa é capacidade ao portador sem segundo fator:
 * lê a conta inteira e CRIA COBRANÇA, os dois sem autenticação. Ele ia pra
 * Stripe como parâmetro e ficava guardado no PaymentIntent.
 *
 * O que torna isso um teste e não um conserto: no MESMO commit a gente tinha
 * acabado de pôr `<meta name="referrer" content="strict-origin">` com um
 * comentário afirmando que o token não sai daqui. Fechamos o canal do `Referer`
 * e mandamos o token pela porta da frente. Garantia escrita e falsa é pior que
 * vazamento não documentado, porque quem revisa depois lê a garantia e para de
 * olhar. Achado da revisão de segurança de 2026-09-10.
 */
test('nenhuma tela entrega a URL da conta a um SDK de terceiro', () => {
  const SRC = join(import.meta.dirname, '..', 'src');
  const suspeitas = [/window\.location\.href/, /location\.href/, /location\.search/];
  // Os pontos onde a gente ENTREGA string pra um SDK que a persiste.
  const entregas = /(return_url|returnUrl|redirect_uri|redirectUrl|success_url|cancel_url)\s*:/;
  const achados: string[] = [];
  for (const f of readdirSync(SRC).filter((f) => /\.tsx?$/.test(f))) {
    // `payReturn.ts` é o lugar que TEM que ler a URL — é ele quem a limpa.
    if (f === 'payReturn.ts') continue;
    const linhas = readFileSync(join(SRC, f), 'utf8').split('\n');
    linhas.forEach((linha, i) => {
      if (!entregas.test(linha)) return;
      if (suspeitas.some((re) => re.test(linha))) achados.push(`${f}:${i + 1} ${linha.trim()}`);
    });
  }
  assert.deepEqual(achados, [],
    `\n${achados.join('\n')}\nA URL da conta carrega o token da mesa. Use urlDeVolta().\n`);
});

test('o token da mesa não entra na URL de volta', () => {
  // O outro lado da mesma garantia: `urlDeVolta` é o único construtor da volta,
  // e ele não pode ganhar um `t` de volta num refactor distraído.
  const fonte = readFileSync(join(import.meta.dirname, '..', 'src', 'payReturn.ts'), 'utf8');
  const construtor = fonte.slice(fonte.indexOf('export function urlDeVolta'));
  assert.ok(!/\bt=|qrToken|token/.test(construtor.slice(0, construtor.indexOf('}'))),
    'urlDeVolta() voltou a carregar o token da mesa');
});

/**
 * TODO TERCEIRO QUE O CLIENTE CARREGA ESTÁ ATRÁS DE UMA BANDEIRA POR CASA.
 *
 * A regra que o incidente da Stripe produziu foi aplicada só na Stripe. O
 * Google Pay continuou ligado na chave de BUILD — que é propriedade do deploy,
 * não da casa — então toda conta brasileira injetava
 * `pay.google.com/gp/p/js/pay.js` e rodava `isReadyToPay`, uma sondagem de
 * aparelho e carteira, antes de a pessoa escolher qualquer coisa. Duas linhas
 * abaixo no mesmo arquivo, o cartão exigia chave de build E `venue.acceptsCard`
 * vindo do servidor.
 *
 * A assimetria não foi decidida: um trilho ganhou o conserto e o outro não
 * estava na tela quando o conserto foi feito. Este teste atravessa cliente e
 * servidor porque a garantia atravessa: a bandeira só vale se quem a emite
 * exigir recebedor de verdade.
 *
 * Achado das duas revisões obrigatórias de 2026-09-10.
 */
test('todo trilho de terceiro exige bandeira por casa, e o servidor só a emite com recebedor', () => {
  const SRC = join(import.meta.dirname, '..', 'src');
  const wallet = readFileSync(join(SRC, 'WalletPay.tsx'), 'utf8');
  const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
  const router = readFileSync(join(import.meta.dirname, '..', '..', '..', 'api', '_app', 'router.js'), 'utf8');

  // 1. O portão do componente é uma CONJUNÇÃO que inclui a bandeira da casa.
  const real = wallet.match(/const real = ([^;]+);/);
  assert.ok(real, 'WalletPay perdeu o `const real` — o portão do trilho');
  assert.match(real![1], /acceptsWallet/,
    'o Google Pay voltou a depender só da chave de build (que é do deploy, não da casa)');

  // 2. A tela repassa a bandeira DO SERVIDOR, não um literal otimista.
  assert.match(app, /acceptsWallet=\{venue\.acceptsWallet === true\}/,
    'App precisa passar a bandeira que o servidor declarou');
  assert.match(app, /STRIPE_READY && venue\.acceptsCard/,
    'o trilho da Stripe perdeu a bandeira por casa');

  // 3. E o servidor só a emite pra casa que tem recebedor DE VERDADE. Sem esta
  //    parte, a bandeira existiria e não significaria nada.
  const emissao = router.slice(router.indexOf('acceptsWallet: true') - 400,
                               router.indexOf('acceptsWallet: true'));
  assert.match(emissao, /\^re_/, 'acceptsWallet sai sem exigir recebedor real');
  assert.match(emissao, /DEMO_TABLE_TOKEN/, 'a mesa de demo tem que ficar de fora do trilho real');
});
