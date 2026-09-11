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
 *
 * `apps/web/public` ANDA, e os artefatos COPIADOS pra lá ficam de fora — não
 * porque não importem, mas porque a FONTE deles já é censurada e um censo cujo
 * resultado depende de ter rodado build antes é um censo que responde
 * diferente na CI e na máquina de quem escreveu. O que sobra em `public/` é o
 * que alguém pôs à mão, e é exatamente aí que a Google Fonts do `/ios`
 * entraria de novo. Os nomes vêm do `embed-ios.mjs`.
 */
const ANDA_EM = ['api', 'apps/web/src', 'apps/web/public', 'ios/Racha'];
/** Copiados pelo `embed-ios.mjs` no prebuild; a fonte deles está em `ios/`. */
const COPIADOS = /^(ios\.html|img|carved|ios-fonts)$/;
const ARQUIVOS_SOLTOS = ['apps/web/index.html', 'ios/racha-ios.html', 'vercel.json'];
const EXTENSOES = /\.(js|mjs|ts|tsx|html|css|swift|json)$/;

function fontes(dir, out = []) {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (/^(node_modules|dist|build|Pods|__tests__|test|DerivedData)$/.test(entrada.name)) continue;
      if (COPIADOS.test(entrada.name)) continue;
      fontes(p, out);
    } else if (EXTENSOES.test(entrada.name) && !COPIADOS.test(entrada.name)
               && !/\.test\./.test(entrada.name)) {
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
    // `racha.app` SAIU: tem DNS na GoDaddy e o `www` num site do Wix — não é
    // nosso, e estava aqui declarado como se fosse. Ver `docs/domains.md`.
    const nossos = new Set(['racha-gray.vercel.app', 'localhost']);
    // NÃO são nossos — só não são destinatários de dado em runtime. Separado de
    // `nossos` de propósito: a primeira versão pôs o domínio de um CLIENTE
    // (`menu.bardoze.com.br`, de uma fixture) na lista de "nossos", que é
    // rótulo errado numa lista de permissão. Achado da revisão de segurança.
    const naoSaoDestinatarios = new Set([
      'openapi.vercel.sh',   // `$schema` do vercel.json, nunca buscado em runtime
    ]);
    const externos = [...hosts]
      .filter((h) => !nossos.has(h) && !naoSaoDestinatarios.has(h) && !/\.example$/.test(h))
      .sort();
    expect(externos.length).toBeGreaterThan(0);
    const faltando = externos.filter((h) => !MAPA.includes(h));
    expect(faltando).toEqual([]);
  });

  test('o host que o QR imprime é um host que o app aceita', () => {
    // O par atravessa dois idiomas e nada os obrigava a concordar. O
    // `allowedHosts` do iOS perdeu `racha-gray.vercel.app` por uma rodada — e
    // é justamente o host que o `Qrs.tsx` imprime no cartão da mesa e o padrão
    // do `CLIENT_URL`. Um build de release recusaria TODA mesa de verdade.
    // Falha fechada, então não era buraco de segurança: era o produto
    // quebrado, na forma "cópia divergente" pela quarta vez nesta série.
    //
    // Adesivo em mesa não se chama de volta, então a direção que importa é
    // esta: tudo que a gente IMPRIME tem que estar no que o app ACEITA. O
    // contrário não — a lista pode ser mais larga durante uma migração.
    const qrs = fs.readFileSync(path.join(RAIZ, 'apps', 'web', 'src', 'Qrs.tsx'), 'utf8');
    const router = fs.readFileSync(path.join(RAIZ, 'api', '_app', 'router.js'), 'utf8');
    const swift = fs.readFileSync(path.join(RAIZ, 'ios', 'Racha', 'Core', 'POS', 'TableQR.swift'), 'utf8');

    const host = (u) => new URL(u).host.toLowerCase();
    const impressos = new Set();
    const prod = qrs.match(/const PROD_ORIGIN = '([^']+)'/);
    expect(prod).toBeTruthy();
    impressos.add(host(prod[1]));
    const clientUrl = router.match(/process\.env\.CLIENT_URL \|\| '([^']+)'/);
    expect(clientUrl).toBeTruthy();
    impressos.add(host(clientUrl[1]));

    // A lista de RELEASE: a declaração literal, sem nada que `#if DEBUG` some.
    const decl = swift.match(/static let allowedHosts: Set<String> = \[([^\]]+)\]/);
    expect(decl).toBeTruthy();
    const aceitos = new Set((decl[1].match(/"([^"]+)"/g) || []).map((x) => x.replace(/"/g, '').toLowerCase()));

    const faltando = [...impressos].filter((h) => !aceitos.has(h)).sort();
    expect(faltando).toEqual([]);
  });

  test('todo host que o app confia está registrado como nosso em docs/domains.md', () => {
    // A última afirmação do repositório da forma "isto é nosso" sem nada que a
    // conferisse — e ela estava ERRADA: `racha.app` tem DNS na GoDaddy e o
    // `www` num site do Wix, e esteve na lista de origens confiáveis de um
    // cliente de pagamento. Hábito virou tabela, e tabela virou teste.
    const swift = fs.readFileSync(path.join(RAIZ, 'ios', 'Racha', 'Core', 'POS', 'TableQR.swift'), 'utf8');
    const decl = swift.match(/static let allowedHosts: Set<String> = \[([^\]]+)\]/);
    expect(decl).toBeTruthy();
    const hosts = (decl[1].match(/"([^"]+)"/g) || []).map((x) => x.replace(/"/g, '').toLowerCase());
    expect(hosts.length).toBeGreaterThan(0);

    const domains = fs.readFileSync(path.join(RAIZ, 'docs', 'domains.md'), 'utf8');
    // A linha do host tem que existir E dizer que é nosso — um host listado
    // como de TERCEIRO não passa a valer por estar no arquivo.
    const semDono = hosts.filter((h) => {
      const linha = domains.split('\n').find((l) => l.includes(`\`${h}\``));
      return !linha || !/\bnós\b/.test(linha);
    });
    expect(semDono).toEqual([]);

    // E o padrão do cliente nativo é um dos hosts confiados — ele alimenta o
    // `defaultOrigin` do "digitar o código", que foi por onde o host de
    // terceiro entrou.
    const env = fs.readFileSync(path.join(RAIZ, 'ios', 'Racha', 'Core', 'POS', 'RachaEnvironment.swift'), 'utf8');
    const padrao = env.match(/return URL\(string: "https:\/\/([^"/]+)"\)!/);
    expect(padrao).toBeTruthy();
    expect(hosts).toContain(padrao[1].toLowerCase());
  });

  test('o número de campos guardados do webhook é o do código', () => {
    // O mapa dizia "15 campos"; o `KEEP` tem 14, e nada conferia. Um número
    // pequeno e não testado dentro de um registro do art. 37 é a mesma coisa
    // que fez a primeira versão deste mapa estar errada sobre o `payer_hint`.
    const mask = fs.readFileSync(path.join(RAIZ, 'api', '_lib', 'pay', 'mask.js'), 'utf8');
    const bloco = mask.slice(mask.indexOf('const KEEP = ['), mask.indexOf('];', mask.indexOf('const KEEP = [')));
    const quantos = (bloco.match(/'[^']+'/g) || []).length;
    expect(quantos).toBeGreaterThan(0);
    // Na LINHA do `psp_payload_masked`, não em qualquer lugar do documento: um
    // "14 campos" solto noutro parágrafo faria o teste passar sobre a frase
    // errada.
    const linha = MAPA.split('\n').find((l) => l.includes('psp_payload_masked'));
    expect(linha).toBeDefined();
    expect(linha).toContain(`${quantos} campos`);
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
