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

function deps(pkgRelativo) {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, pkgRelativo), 'utf8'));
  return Object.keys(pkg.dependencies || {});
}

/** Arquivos de CÓDIGO — testes e docs ficam de fora: eles citam hosts de mentira. */
function fontes(dir, out = []) {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (/^(node_modules|dist|__tests__|test|DerivedData)$/.test(entrada.name)) continue;
      fontes(p, out);
    } else if (/\.(js|ts|tsx)$/.test(entrada.name) && !/\.test\./.test(entrada.name)) {
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
    const arquivos = [...fontes(path.join(RAIZ, 'api')), ...fontes(path.join(RAIZ, 'apps', 'web', 'src'))];
    const hosts = new Set();
    for (const f of arquivos) {
      const texto = fs.readFileSync(f, 'utf8');
      for (const m of texto.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
    }
    // O nosso próprio domínio e os exemplos de documentação não são
    // destinatários de dado de terceiro.
    const nossos = [/^racha-[a-z]+\.vercel\.app$/, /\.example$/, /^localhost$/];
    const externos = [...hosts].filter((h) => !nossos.some((re) => re.test(h))).sort();
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
