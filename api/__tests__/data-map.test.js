'use strict';

/**
 * O mapa de dados não pode envelhecer em silêncio.
 *
 * Em 2026-09-07 uma conta de Pix brasileira carregava `js.stripe.com`: o
 * `@stripe/stripe-js` injeta o script no IMPORT do módulo, então o componente
 * existir na árvore já bastava. O conserto foi de uma linha. O achado atrás do
 * achado é que **ninguém sabia que a Stripe era destinatária de dado porque
 * nada no repositório listava destinatários** — não havia onde olhar e
 * descobrir que estava errado.
 *
 * `docs/compliance/data-map.md` passou a ser essa lista. Um documento, porém,
 * é uma promessa, e promessa não roda. Este teste é o que a torna verificável:
 *
 *   1. toda DEPENDÊNCIA de runtime (api e web) tem que estar classificada lá;
 *   2. todo HOST literal escrito no código tem que estar nomeado lá.
 *
 * Uma dependência nova que fale com fora quebra o teste até alguém escrever o
 * que ela vê. É a pergunta que não tinha sido feita sobre o `stripe-js`.
 */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const MAPA = fs.readFileSync(path.join(RAIZ, 'docs', 'compliance', 'data-map.md'), 'utf8');

/**
 * DEPENDÊNCIAS E DEVDEPENDÊNCIAS.
 *
 * Lia só `dependencies`. O Vite empacota um import de devDependency no cliente
 * exatamente igual — mover o `@stripe/stripe-js` de uma seção pra outra tirava
 * ele do censo sem mudar um byte do que o cliente baixa. Um censo que se
 * desliga com uma edição de package.json não é um censo.
 */
function deps(pkgRelativo) {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, pkgRelativo), 'utf8'));
  return [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
}

/**
 * Onde o censo anda. A primeira versão andava em `api/` e `apps/web/src` e só
 * abria `.js/.ts/.tsx` — e **por isso não via a Google Fonts que o `/ios` da
 * produção servia**: marcação HTML, fora das duas pastas. O incidente que este
 * mapa existe pra registrar foi um terceiro entrando por import; o que o censo
 * deixou passar foi um terceiro entrando por `<link>`. Mesma forma.
 *
 * `ios/lab` fica de fora de propósito: é rascunho de design que não vai pro
 * deploy (o `embed-ios.mjs` copia de lá só as imagens). O que ANDA é o que
 * sobe: o servidor, o cliente, a casca do cliente, o protótipo publicado em
 * `/ios` e o app nativo.
 */
const ANDA_EM = ['api', 'apps/web/src', 'ios/Racha'];
const ARQUIVOS_SOLTOS = ['apps/web/index.html', 'ios/racha-ios.html', 'vercel.json'];
const EXTENSOES = /\.(js|mjs|ts|tsx|html|css|swift|json)$/;

function fontes(dir, out = []) {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (/^(node_modules|dist|build|Pods|__tests__|test|DerivedData)$/.test(entrada.name)) continue;
      fontes(p, out);
    } else if (EXTENSOES.test(entrada.name) && !/\.test\./.test(entrada.name)) {
      out.push(p);
    }
  }
  return out;
}

describe('o mapa de dados acompanha o código', () => {
  test('toda dependência de runtime está classificada no mapa', () => {
    const todas = [...new Set([...deps('package.json'), ...deps('apps/web/package.json')])];
    // Menos de dez hoje. Se um dia forem cinquenta, a lista continua sendo a
    // resposta certa — o problema não é o tamanho dela, é não existir.
    expect(todas.length).toBeGreaterThan(0);
    const faltando = todas.filter((d) => !MAPA.includes(`\`${d}\``));
    expect(faltando).toEqual([]);
  });

  test('todo host literal escrito no código está nomeado no mapa', () => {
    const arquivos = [
      ...ANDA_EM.flatMap((d) => fontes(path.join(RAIZ, ...d.split('/')))),
      ...ARQUIVOS_SOLTOS.map((f) => path.join(RAIZ, ...f.split('/'))),
    ];
    const hosts = new Set();
    for (const f of arquivos) {
      const texto = fs.readFileSync(f, 'utf8');
      // `http` também: um censo que só vê `https` deixa passar o pior caso.
      for (const m of texto.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
    }
    // LITERAIS, não padrões. Era `/^racha-[a-z]+\.vercel\.app$/`, e nomes de
    // projeto na Vercel são de quem chegar primeiro: `racha-exfil.vercel.app`
    // casava e o censo chamava de nosso.
    const nossos = new Set(['racha.app', 'racha-gray.vercel.app', 'localhost',
      'openapi.vercel.sh', 'menu.bardoze.com.br']);
    const externos = [...hosts]
      .filter((h) => !nossos.has(h) && !/\.example$/.test(h))
      .sort();
    expect(externos.length).toBeGreaterThan(0);
    const faltando = externos.filter((h) => !MAPA.includes(h));
    expect(faltando).toEqual([]);
  });

  test('o mapa nomeia as lacunas em vez de deixá-las implícitas', () => {
    // Um mapa que só lista o que está certo é um mapa que não serve pra
    // revisão. As lacunas são o motivo dele existir.
    expect(MAPA).toMatch(/##\s*4\.\s*Lacunas/);
    for (const obrigatoria of ['retenção', 'exclusão', 'aviso de privacidade', 'DPA', 'encarregado']) {
      expect(MAPA.toLowerCase()).toContain(obrigatoria.toLowerCase());
    }
  });
});
