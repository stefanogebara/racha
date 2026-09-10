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

/** Os `.ts`/`.tsx` de `src`, DESCENDO — `src` é plana hoje, e a primeira
 *  subpasta tirava telas deste censo em silêncio (o mesmo conserto que os
 *  quatro censos de idioma ganharam; este ficou pra trás no mesmo commit). */
function arquivosTsx(raiz: string, sub = '', out: string[] = []): string[] {
  for (const e of readdirSync(join(raiz, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) arquivosTsx(raiz, rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

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
  // Com `:` e na forma ABREVIADA (`{ return_url }`), porque a abreviada não
  // tem valor na linha e escapava da regra.
  const entregas = /(return_url|returnUrl|redirect_uri|redirectUrl|success_url|cancel_url)\s*[:,}]/;
  const achados: string[] = [];
  for (const f of arquivosTsx(SRC)) {
    // `payReturn.ts` é o lugar que TEM que ler a URL — é ele quem a limpa.
    if (f === 'payReturn.ts') continue;
    const texto = readFileSync(join(SRC, f), 'utf8');
    const linhas = texto.split('\n');
    linhas.forEach((linha, i) => {
      if (!entregas.test(linha)) return;
      // O VALOR entregue, não a linha: `const volta = window.location.href` uma
      // linha acima e `return_url: volta` embaixo passava, porque a regra
      // exigia o par na MESMA linha. Aqui o valor tem que ser literalmente a
      // chamada que limpa.
      const valor = linha.split(/(?:return_url|returnUrl|redirect_uri|redirectUrl|success_url|cancel_url)\s*:/)[1] ?? '';
      if (!/urlDeVolta\(\)/.test(valor)) achados.push(`${f}:${i + 1} ${linha.trim()}`);
      if (suspeitas.some((re) => re.test(linha))) achados.push(`${f}:${i + 1} ${linha.trim()}`);
    });
  }
  assert.deepEqual(achados, [],
    `\n${achados.join('\n')}\nA volta de um PSP só pode ser urlDeVolta(): a URL da conta carrega o token da mesa.\n`);
});

test('o token da mesa não entra na URL de volta', () => {
  // O outro lado da mesma garantia: `urlDeVolta` é o único construtor da volta,
  // e ele não pode ganhar um `t` de volta num refactor distraído.
  //
  // A PRIMEIRA VERSÃO DESTE TESTE ERA VAZIA. Ela recortava até o primeiro `}`
  // do arquivo — que é o fecho de `${window.location.origin}`, dentro do
  // template — então inspecionava 73 caracteres e nunca via o resto do
  // `return`. Reescrever a função pra `...?r=1&t=${sessionStorage.getItem(...)}`
  // passava verde. Um portão escrito no mesmo commit do achado, com a forma do
  // achado dentro dele. Achado da revisão de segurança de 2026-09-10.
  //
  // Por isso agora é LISTA DE PERMISSÃO de uma forma só, e não busca de
  // palavra proibida — o mesmo argumento que o `KEEP` do `mask.js` faz.
  const fonte = readFileSync(join(import.meta.dirname, '..', 'src', 'payReturn.ts'), 'utf8');
  const corpo = fonte.slice(fonte.indexOf('export function urlDeVolta'));
  const linhas = corpo.slice(0, corpo.indexOf('\n}')).split('\n').slice(1)
    .map((l) => l.trim())
    // Comentário dentro do corpo não é mudança de comportamento, e é o jeito
    // mais provável de alguém derrubar isto sem querer — e daí "consertar"
    // afrouxando o casamento, que seria o bug de novo.
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*'));
  assert.deepEqual(linhas, ['return `${window.location.origin}${window.location.pathname}?${MARCA}=1`;'],
    'urlDeVolta() mudou de forma. Se a mudança é DELIBERADA, re-derive a garantia '
    + '(o token da mesa não pode ir pro PSP) e atualize o valor esperado. Nunca afrouxe o casamento: '
    + 'a versão frouxa deste teste passava com `&t=${sessionStorage.getItem(CHAVE)}` na volta.');
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
  // Da resolução da casa até a emissão da bandeira — não uma janela de N
  // caracteres, que muda de significado quando alguém move uma linha.
  const emissao = router.slice(router.indexOf('const casa ='), router.indexOf('acceptsWallet: true'));
  assert.ok(emissao.length > 0 && emissao.length < 2000, 'a emissão de acceptsWallet mudou de forma');
  // A MESMA forma que o resto do repositório usa pra recebedor (`pagarme-psp`,
  // `setupComplete`). Fixar `re_` aqui congelava uma cópia divergente.
  assert.match(emissao, /\^r\[ep\]_/, 'acceptsWallet sai sem exigir recebedor real, na forma canônica');
  assert.match(emissao, /DEMO_TABLE_TOKEN/, 'a mesa de demo tem que ficar de fora do trilho real');
});

/**
 * UMA tradução de resposta HTTP pra erro, não duas.
 *
 * Havia duas: `request` no `api.ts` e `authedReq` no `auth.ts`. Quando o
 * servidor parou de mandar frase e passou a mandar `code` + `vars`, só a
 * primeira foi atualizada — e como o `errorBody` OMITE `error` quando há
 * código, todo painel do dono passou a mostrar "HTTP 404". A metade que eu não
 * conferi. Achado da revisão de segurança de 2026-09-10.
 *
 * O modo de falha é geral: qualquer erro com código novo degrada do mesmo
 * jeito no lado que não decodifica. Então o teste não é "authedReq está certo",
 * é "só existe um lugar que pode estar errado".
 */
test('só um lugar no cliente transforma resposta HTTP em erro', () => {
  const SRC = join(import.meta.dirname, '..', 'src');
  // Censurar os LOCAIS QUE FALAM HTTP, não as frases que eles usam pra
  // detectar erro. A primeira versão procurava `body.success === false` e
  // `!res.ok` — duas grafias — e um terceiro decodificador escrito
  // `if (body.success !== true)` seria invisível. Mesma correção que o censo
  // da URL de volta acabou de receber: liste o que é permitido, não o que é
  // proibido. Achado da revisão de segurança de 2026-09-10.
  const PODEM_FALAR_HTTP = new Set([
    'api.ts',            // `request` → erroDaResposta
    'auth.ts',           // `authedReq` → erroDaResposta
    'App.tsx',           // farol de prospecção e config da casa: best-effort
    'useVenueAdmin.ts',  // busca o id da conta antes de fechar; trata ausência
  ]);
  const novos = arquivosTsx(SRC).filter((f) => /\bfetch\(/.test(readFileSync(join(SRC, f), 'utf8')))
    .filter((f) => !PODEM_FALAR_HTTP.has(f));
  assert.deepEqual(novos, [],
    `\n${novos.join('\n')}\nArquivo novo falando HTTP direto. Passe pelo \`api.ts\`/\`auth.ts\` — `
    + 'o `code` e os `vars` do servidor só atravessam por `erroDaResposta`.\n');

  // E quem decodifica tem que usar o decodificador — não montar o erro à mão.
  const donos: string[] = [];
  for (const f of ['api.ts', 'auth.ts']) {
    for (const [i, linha] of readFileSync(join(SRC, f), 'utf8').split('\n').entries()) {
      if (!/body\.success|!res\.ok|res\.status >=/.test(linha)) continue;
      if (!/erroDaResposta/.test(linha)) donos.push(`${f}:${i + 1} ${linha.trim()}`);
    }
  }
  assert.deepEqual(donos, [],
    `\n${donos.join('\n')}\nUse erroDaResposta(res, body): sem ela o \`code\` e os \`vars\` somem `
    + 'e a tela mostra "HTTP 4xx".\n');
});
