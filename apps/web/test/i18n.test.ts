/**
 * Testes do dicionário. O que eles protegem não é a tradução em si — é o
 * silêncio: uma chave torta ou um `{placeholder}` que só existe num dos lados
 * não quebra o build, não quebra o teste de renderização, e aparece como
 * "{amount}" cru na tela de pagamento de alguém, num bar, em português.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT, LANGS, asLang, money, tError, STRIPE_LOCALE, LANDING_MARKET } from '../src/i18n.ts';

const entries = Object.entries(DICT) as [string, { en: string; pt: string; es: string }][];

/**
 * As linhas de CÓDIGO de um arquivo — sem comentário nenhum.
 *
 * Precisa de estado porque um `{/* … *\/}` de várias linhas tem linhas do meio
 * sem marcador, e sem rastrear a abertura elas parecem texto de tela. Foi
 * exatamente o que aconteceu: um comentário que CITA "Copiar código Pix" como
 * exemplo do bug foi acusado de ser o bug.
 *
 * Compartilhado pelos dois testes de português de propósito — a lógica de
 * "isto é comentário" só pode existir num lugar, senão um dos dois vê fantasma.
 */
/**
 * A linha é PROSA de tela, e não código?
 *
 * Prosa de JSX que ocupa várias linhas tem linhas do meio sem `>` nem `<`, e é
 * por isso que este teste precisa reconhecê-las. Mas uma linha de código com
 * comentário no fim (`'x', // porquê`) também não tem tag nenhuma — foi um
 * falso positivo real, num arquivo cujo comentário explicava um bug de
 * pagamento. Então: tira o comentário do fim primeiro, e o que sobra só conta
 * como prosa se não tiver aspas nem vírgula, que é o que faz uma linha ser
 * código.
 */
function isProseLine(trimmed: string): boolean {
  const code = trimmed.replace(/\/\/.*$/, '').trim();
  if (code.length <= 12) return false;
  return /^[^<>{}()=;:`|&'"[\],]+$/.test(code);
}

function codeLines(text: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  let inBlock = false;
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    const opens = /\{?\/\*/.test(line);
    const closes = /\*\/\}?/.test(line);
    if (inBlock) { if (closes) inBlock = false; return; }
    if (opens && !closes) { inBlock = true; return; }
    if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed) || (opens && closes)) return;
    out.push({ line, n: i + 1 });
  });
  return out;
}

test('toda chave tem os três idiomas, não vazios', () => {
  for (const [key, pair] of entries) {
    for (const lang of LANGS) {
      assert.ok(pair[lang] !== undefined, `${key} não tem ${lang}`);
      assert.ok(pair[lang].trim().length > 0, `${key}.${lang} está vazio`);
    }
  }
});

test('os {placeholders} são os MESMOS nos dois idiomas', () => {
  // O modo de falha real: 'share.each' com {amount} em inglês e {valor} em
  // português. O inglês funciona, o português imprime "{valor}" literal.
  const holes = (s: string) => new Set(s.match(/\{(\w+)\}/g) ?? []);
  for (const [key, pair] of entries) {
    const en = holes(pair.en), pt = holes(pair.pt);
    assert.deepEqual([...en].sort(), [...pt].sort(),
      `${key}: placeholders diferentes — en ${[...en]} vs pt ${[...pt]}`);
  }
});

test('nenhuma tradução é só uma cópia da outra, exceto quando deve ser', () => {
  // Palavras que são MESMO iguais nas duas línguas. A lista é curta e nomeada
  // uma a uma de propósito: o jeito fácil de fazer este teste passar é inventar
  // uma tradução, e aí ele deixa de valer alguma coisa.
  // A lista é por PAR, não por chave: uma chave dispensada em `pt=es` continua
  // sendo checada em `en=pt`. Espanhol e português são línguas próximas e
  // dezenas de palavras coincidem de verdade — se a dispensa fosse por chave,
  // uma tradução inglesa esquecida passaria de carona.
  const same = new Set([
    'check.total:en=pt', 'check.total:en=es', 'check.total:pt=es',
    'share.item:en=pt',
    'gate.email:en=pt',
    'card.demoCard:en=pt', 'card.demoCard:en=es', 'card.demoCard:pt=es',
    'rcpt.statusOther:en=pt', // "status" é a mesma palavra
    // Espanhol e português: palavras que são MESMO iguais. Cada uma é uma
    // afirmação consciente, não um atalho.
    'lang.label:pt=es', 'lang.es:pt=es', 'common.optional:pt=es',
    'share.splitAmong:pt=es', 'pix.copy:pt=es', 'pix.copied:pt=es',
    'pix.simulating:pt=es', 'panel.tables:pt=es', 'panel.balOne:pt=es',
    'panel.balMany:pt=es', 'panel.status.parcial:pt=es', 'wallet.topUpEntry:pt=es',
    'gate.signIn:pt=es', 'admin.less:pt=es', 'admin.tablesN:pt=es',
    'wiz.stepTables:pt=es', 'wiz.connected:pt=es', 'wiz.marked:pt=es',
    'qrs.backTables:pt=es', 'stripe.connect:pt=es', 'admin.cpfOk:pt=es',
    'house.refund:pt=es', 'rcpt.idCopied:pt=es', 'rcpt.copyId:pt=es',
    'rcpt.holder:pt=es', 'rcpt.bankLabel:pt=es', 'rcpt.bankCodeKnown:pt=es',
    'rcpt.optionalPh:pt=es', 'rcpt.sending:pt=es', 'rcpt.cancel:pt=es',
    'ledger.load:pt=es', 'ledger.refund:pt=es', 'cat.carne:pt=es',
    'cat.massa:en=es', 'cat.cafe:pt=es', 'land.nav:pt=es',
    'qrs.print:pt=es', // "Imprimir" é igual nas duas
    // O nome do documento é o nome dele: "CNPJ" e "NIF" não se traduzem. O
    // inglês ganha "Tax ID (…)" porque um leitor de inglês não sabe o que a
    // sigla é; português e espanhol sabem, e repetir a sigla é o certo.
    'rcpt.taxIdCnpj:pt=es', 'rcpt.taxIdNif:pt=es',
  ]);
  // Compara TODOS os pares, não só en/pt: com três idiomas, uma cópia entre
  // espanhol e português passa tão fácil quanto passava entre inglês e
  // português — e espanhol e português se parecem MAIS, então o risco é maior.
  const copied = entries.flatMap(([k, p]) => {
    const dup: string[] = [];
    const check = (a: keyof typeof p, b: keyof typeof p) => {
      if (p[a] === p[b] && !same.has(`${k}:${a}=${b}`)) dup.push(`${k} (${a}=${b})`);
    };
    check('en', 'pt'); check('en', 'es'); check('pt', 'es');
    return dup;
  });
  assert.deepEqual(copied, [], `chaves não traduzidas: ${copied.join(', ')}`);
});

test('dinheiro: a moeda é sempre BRL, a separação segue o idioma', () => {
  // A conta é em reais nos dois casos — trocar de idioma não converte moeda.
  // Mas "R$ 1.234,56" lido por um falante de inglês vale mil vezes menos.
  const pt = money(123456, 'pt');
  const en = money(123456, 'en');
  assert.ok(pt.includes('R$'), pt);
  assert.ok(en.includes('R$'), en);
  assert.ok(pt.includes('1.234,56'), `pt-BR deveria usar . e , — veio ${pt}`);
  assert.ok(en.includes('1,234.56'), `en deveria usar , e . — veio ${en}`);
});

test('centavos exatos sobrevivem à formatação, nos três idiomas e nas duas moedas', () => {
  // Inglês usa ponto decimal; português e espanhol usam vírgula. O que este
  // teste protege é o centavo: 1 centavo nunca pode virar "0.0" nem desaparecer
  // no arredondamento de um `Intl` mal configurado.
  const decimal = (lang: string) => (lang === 'en' ? '0.01' : '0,01');
  const zero = (lang: string) => (lang === 'en' ? '0.00' : '0,00');
  for (const lang of LANGS) {
    for (const currency of ['BRL', 'EUR'] as const) {
      assert.ok(money(1, lang, currency).includes(decimal(lang)),
        `${lang}/${currency}: 1 centavo saiu "${money(1, lang, currency)}"`);
      assert.ok(money(0, lang, currency).includes(zero(lang)),
        `${lang}/${currency}: zero saiu "${money(0, lang, currency)}"`);
    }
  }
});

test('a moeda vem da casa, a separação vem do leitor', () => {
  // Trocar de idioma NÃO converte dinheiro (decisão #34) e trocar de país não
  // muda a separação: são dois eixos, e este teste é o que impede que alguém
  // volte a amarrar um no outro.
  assert.ok(money(123456, 'en', 'EUR').includes('1,234.56'));   // €1,234.56
  assert.ok(money(123456, 'pt', 'BRL').includes('1.234,56'));   // R$ 1.234,56

  // Espanhol NÃO agrupa quatro dígitos: "1234,56 €" é a forma certa e
  // "1.234,56 €" é a errada (regra da RAE, e é o que o ICU faz). Esta
  // asserção existe pra que ninguém "corrija" isso pra ficar parecido com o
  // português — a vírgula decimal é igual, o milhar não.
  assert.equal(money(123456, 'es', 'EUR'), '1234,56\u00a0€');
  // A partir de cinco dígitos o espanhol agrupa, e aí sim com ponto.
  assert.ok(money(1234567, 'es', 'EUR').includes('12.345,67'));

  // O símbolo segue a MOEDA; a posição dele segue o idioma (€ depois em
  // espanhol, antes em inglês).
  assert.ok(money(100, 'es', 'EUR').endsWith('€'));
  assert.ok(money(100, 'en', 'EUR').startsWith('€'));
  assert.ok(money(100, 'pt', 'BRL').startsWith('R$'));

  // O real LIDO EM ESPANHOL: o caso do turista numa mesa brasileira, que é
  // pra quem o seletor existe. O padrão do `Intl` em `es-ES` é o CÓDIGO —
  // "213,10 BRL" — e a mesma tela desenha "R$" no rótulo do campo de valor.
  // Duas grafias da mesma moeda numa tela de pagar é a pessoa procurando a
  // diferença entre elas. O símbolo é o do menu impresso; o que segue o
  // leitor é a separação e a posição.
  assert.ok(money(21310, 'es', 'BRL').includes('R$'), money(21310, 'es', 'BRL'));
  assert.ok(!money(21310, 'es', 'BRL').includes('BRL'), money(21310, 'es', 'BRL'));
  assert.ok(money(21310, 'es', 'BRL').startsWith('213,10'), money(21310, 'es', 'BRL'));
});

test('erro do servidor: traduz pelo código e cai no texto cru quando não conhece', () => {
  assert.equal(tError('en', 'check_closed', 'conta fechada'), 'This bill is already closed.');
  assert.equal(tError('pt', 'check_closed', 'conta fechada'), 'Esta conta já foi fechada.');
  // Servidor mais novo que o cliente: um código desconhecido NÃO pode virar
  // tela em branco nem "undefined" — o texto do servidor é melhor que nada.
  assert.equal(tError('en', 'codigo_que_nao_existe', 'mensagem crua'), 'mensagem crua');
  assert.equal(tError('en', undefined, 'mensagem crua'), 'mensagem crua');
});

test('erro com valor interpolado', () => {
  assert.equal(tError('en', 'amount_over', 'x', { left: 'R$ 23.00' }),
               'Amount is more than what is left (R$ 23.00).');
  assert.equal(tError('pt', 'amount_over', 'x', { left: 'R$ 23,00' }),
               'Valor acima do que falta (R$ 23,00).');
});

test('o padrão da plataforma é inglês', () => {
  // Pedido de produto. Se isto mudar, muda de propósito, não por acidente.
  assert.equal(LANGS[0], 'en');
});

/**
 * A componente que escreve português na mão.
 *
 * A decisão #34 diz que toda frase de tela passa pelo dicionário, e a #35
 * chama salada de idioma de defeito de design. Mesmo assim, 22 frases estavam
 * cravadas em português dentro dos componentes — no portão do painel, na
 * carteira, no pagamento com saldo — **com a chave já traduzida no dicionário,
 * ao lado, sem ninguém usando**. Em modo inglês o dono do restaurante lia
 * "painel do dono".
 *
 * Nada quebrava: compila, renderiza, passa nos outros testes. É o modo de
 * falha silencioso de sempre, então este teste tira o silêncio: se uma frase
 * portuguesa do dicionário aparece copiada num `.tsx`, o teste diz qual chave
 * já existia pra ela.
 */
test('nenhum componente escreve em português o que o dicionário já traduz', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = path.join(import.meta.dirname, '..', 'src');

  // Frases curtas ("Total", "item") aparecem legitimamente em nomes de variável
  // e em comentários; só frases de verdade são evidência.
  const phrases = entries
    .filter(([, pair]) => pair.pt.length >= 9 && pair.pt.includes(' '))
    .map(([key, pair]) => [key, pair.pt] as const);

  const offenders: string[] = [];
  for (const file of fs.readdirSync(src)) {
    if (!/\.(tsx|ts)$/.test(file) || file === 'i18n.ts') continue;
    for (const { line, n } of codeLines(fs.readFileSync(path.join(src, file), 'utf8'))) {
      for (const [key, pt] of phrases) {
        if (line.includes(pt)) {
          offenders.push(`${file}:${n} escreve "${pt}" — use t('${key}')`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});

/**
 * O inglês tem que ser inglês.
 *
 * Os testes acima provam que as duas línguas EXISTEM e que os placeholders
 * batem. Nenhum deles olha se o lado inglês está certo — e estava errado de
 * três jeitos que passam por qualquer teste de presença:
 *
 * - palavra portuguesa deixada no meio da frase inglesa ("centavo", "Couvert");
 * - tradução literal que vira idioma estrangeiro ("Discover the house balance",
 *   de "Conheça");
 * - termo inventado onde o inglês já tem o dele ("Staff service" pra aquilo que
 *   toda conta em inglês chama "service charge").
 *
 * A lista é pequena de propósito: é uma rede pra reincidência, não um corretor.
 */
test('o lado inglês não deixa palavra portuguesa nem tradução literal', () => {
  // Palavras que não existem em inglês corrente. "Pix", "Racha", "CPF" e
  // "couvert" no lado PT são nomes próprios e ficam.
  const untranslated = ['centavo', 'centavos', 'conta', 'mesa', 'gorjeta', 'saldo'];
  // Traduções literais que já apareceram no dicionário.
  const calques = ['discover the', 'staff service', 'realize the'];

  const offenders: string[] = [];
  for (const [key, pair] of entries) {
    const en = pair.en.toLowerCase();
    for (const w of untranslated) {
      if (new RegExp(`\\b${w}\\b`).test(en)) offenders.push(`${key}: en contém "${w}"`);
    }
    for (const c of calques) {
      if (en.includes(c)) offenders.push(`${key}: en tem tradução literal "${c}"`);
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});

test('o inglês não repete a mesma moeda com dois nomes', () => {
  // "cent" no título e "centavo" no corpo do mesmo bloco foi o caso real.
  const money = entries.filter(([, p]) => /\bcents?\b|\bcentavos?\b/i.test(p.en));
  const usesCentavo = money.filter(([, p]) => /\bcentavos?\b/i.test(p.en));
  assert.deepEqual(usesCentavo.map(([k]) => k), [],
    'o lado inglês chama a moeda de "centavo" em algumas chaves e de "cent" em outras');
});

/**
 * A frase portuguesa que nunca teve chave.
 *
 * O teste acima só acha o que o dicionário JÁ traduz. Uma frase escrita direto
 * no componente, sem chave nenhuma, é invisível pra ele — e era assim que o
 * lado do DONO (painel, gestão de mesas, assistente de implantação, cadastro
 * do recebedor) estava quase todo em português, com a plataforma se dizendo
 * bilíngue desde a decisão #34. Noventa e oito frases.
 *
 * A regra: texto em posição de JSX (entre `>` e `<`) e os atributos que o
 * usuário lê não podem conter palavra que só existe em português. Nomes de
 * variável, chaves de estado e comentários ficam de fora — é o que separa
 * `'conta'` como passo da máquina de estados de "conta" na tela.
 */
test('nenhum componente escreve texto de tela em português sem chave', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = path.join(import.meta.dirname, '..', 'src');

  // Palavras que não existem em inglês. Curta e específica de propósito: a
  // lista cresce quando alguém acha um caso novo, não por precaução.
  const ptOnly = ['conta', 'contas', 'mesa', 'mesas', 'pagamento', 'pagamentos',
    'semana', 'serviço', 'cartão', 'saldo', 'gorjeta', 'dono', 'treino',
    'fechar', 'abrir', 'adicionar', 'nenhuma', 'nenhum', 'cliente', 'clientes',
    'criar', 'criando', 'entrar', 'sair', 'confira', 'banco', 'titular',
    'recebedor', 'dígito', 'próximo', 'voltar', 'salvando', 'pronto',
    'carregando'];
  const re = new RegExp(`\\b(${ptOnly.join('|')})\\b`, 'i');

  const offenders: string[] = [];
  for (const file of fs.readdirSync(src)) {
    if (!/\.(tsx|ts)$/.test(file) || file === 'i18n.ts') continue;
    for (const { line, n } of codeLines(fs.readFileSync(path.join(src, file), 'utf8'))) {
      const trimmed = line.trim();
      const candidates = [
        ...[...line.matchAll(/>([^<>{}]{4,})</g)].map((m) => m[1]),
        ...[...line.matchAll(/(?:placeholder|title|aria-label)="([^"]{4,})"/g)].map((m) => m[1]),
        // Prosa de JSX que ocupa VÁRIAS linhas: as linhas do meio não têm `>`
        // nem `<`, então a regra de cima não as vê. Foi assim que o parágrafo
        // do AdminStripe — três linhas em português, mencionando o Pix numa
        // tela espanhola — passou pela primeira versão deste teste. Uma linha
        // que é só texto (sem tag, sem chave, sem código) é prosa de tela.
        ...(isProseLine(trimmed) ? [trimmed] : []),
      ];
      for (const c of candidates) {
        if (re.test(c)) offenders.push(`${file}:${n} texto de tela em português: ${JSON.stringify(c.trim().slice(0, 60))}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});

/* ── a escolha de idioma sobrevive ao recarregamento ───────────────────────── */

test('todo idioma que o seletor desenha é aceito de volta na leitura', () => {
  // O bug que este teste fecha, visto na tela em 2026-09-07: a pessoa tocava
  // ES, a escolha era GRAVADA como 'es', e o recarregamento voltava pra
  // inglês. `readStored` tinha uma lista escrita à mão que dizia
  // `v === 'en' || v === 'pt'` — o `?lang=` tinha ganhado o espanhol e o
  // localStorage não. O seletor prometia uma escolha que o produto esquecia.
  //
  // Não basta testar `asLang('es')`: o que importa é que a lista de LEITURA
  // não possa divergir da lista que DESENHA o seletor. Um quarto idioma passa
  // por aqui e quebra este teste se alguém esquecer uma das portas.
  for (const l of LANGS) assert.equal(asLang(l), l, `o seletor desenha ${l} mas a leitura recusa`);
  assert.equal(LANGS.length, Object.keys(DICT['lang.label']).length);
});

test('nada além de um idioma atendido entra', () => {
  // Vem de fora: `?lang=` na URL e localStorage, os dois editáveis por
  // qualquer pessoa. Um valor que não conhecemos tem que cair no padrão, não
  // virar uma chave de dicionário que não existe.
  for (const bad of ['ES', 'en-US', 'fr', '', ' es', 'es ', null, undefined, 42, {}, ['es']]) {
    assert.equal(asLang(bad), null, `aceitou ${JSON.stringify(bad)}`);
  }
});

/* ── o idioma atravessa a folha de pagamento ───────────────────────────────── */

test('todo idioma tem um código de locale que a Stripe conhece', () => {
  // Visto na tela contra a Stripe de verdade: sem `locale` no elemento, o
  // campo de telefone do Bizum, a lista de países e o aviso legal do Open Bank
  // saíam em INGLÊS numa conta espanhola com a tela em espanhol.
  //
  // E o mapa é SEPARADO do `LOCALE` de formatação de propósito: `es-ES` serve
  // pro `Intl` e NÃO está na lista da Stripe, que cai no idioma do navegador
  // em silêncio quando não reconhece o código. Um mapa só teria trocado um
  // bug visível por um bug calado.
  const KNOWN = new Set(['en', 'pt-BR', 'es']);
  for (const l of LANGS) {
    assert.ok(STRIPE_LOCALE[l], `${l} não tem locale de Stripe`);
    assert.ok(KNOWN.has(STRIPE_LOCALE[l]), `${STRIPE_LOCALE[l]} não é um locale da Stripe`);
  }
  assert.notEqual(STRIPE_LOCALE.es, 'es-ES');
});

test('o título do documento é traduzido — é a aba do navegador', () => {
  // Era uma linha fixa em inglês no `index.html`, então a única tela que nunca
  // obedecia ao seletor era a que o sistema operacional desenha por cima.
  for (const l of LANGS) assert.match(DICT['doc.title'][l], /^Racha — .+/);
});

/* ── um só formatador, num só lugar ────────────────────────────────────────── */

test('nenhuma tela formata número, data ou dinheiro com o idioma escrito na linha', async () => {
  // O teste estrutural que faltava, e que tinha cinco infratores quando foi
  // escrito. Todos passavam por todos os outros testes, porque o resultado
  // PARECE certo — só está na língua errada:
  //
  //   api.ts        um segundo `brl()`, com `currency: 'BRL'` fixo e uma lista
  //                 de idiomas que parava em 'pt'|'en'. Ninguém importava: um
  //                 formatador de dinheiro morto é uma armadilha esperando o
  //                 próximo `import`, numa casa que agora cobra em euro.
  //   api.ts        um segundo `dmy()`, idem — e uma data em `en-US` lida em
  //                 Madrid troca o dia pelo mês.
  //   Panel.tsx     a hora da conciliação em `'pt-BR'` pra todo mundo.
  //   Wallet.tsx    a porcentagem do bônus em `'pt-BR'` pra todo mundo.
  //   App.tsx       a porcentagem do bônus com `lang === 'pt' ? … : 'en-US'`,
  //                 o mesmo ternário que esqueceu o espanhol no `readStored`.
  //
  // A regra é a do CLAUDE.md aplicada dentro do cliente: quem sabe o idioma do
  // leitor é o hook, e ele é UM. Uma segunda implementação das regras é uma
  // divergência com um comentário em cima (lição da revisão #32).
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = path.join(import.meta.dirname, '..', 'src');

  // Os dois donos legítimos: o dicionário formata, o hook escolhe o idioma.
  const OWNERS = new Set(['i18n.ts', 'lang.tsx']);
  const BANNED = /'(pt-BR|en-US|es-ES)'|toLocale(String|DateString|TimeString)\(|style:\s*'currency'/;

  const offenders: string[] = [];
  for (const file of fs.readdirSync(src)) {
    if (!/\.(tsx|ts)$/.test(file) || OWNERS.has(file)) continue;
    for (const { line, n } of codeLines(fs.readFileSync(path.join(src, file), 'utf8'))) {
      const m = line.match(BANNED);
      if (m) offenders.push(`${file}:${n} formata sem o hook: ${JSON.stringify(line.trim().slice(0, 72))}`);
    }
  }
  assert.deepEqual(offenders, [], `\nuse o useT() — t/brl/dmy/hm/pct:\n${offenders.join('\n')}\n`);
});

test('nenhuma tela nova imprime dinheiro sem dizer a moeda', async () => {
  // `brl(cents)` sem segundo argumento cai no padrão BRL do hook. Isso está
  // certo no Brasil e errado numa casa em Madrid — e foi assim que o PAINEL
  // imprimia "R$" no faturamento do dia e na linha de GORJETA, que é o número
  // que o dono leva pra folha (revisão de compliance, 2026-09-07).
  //
  // Duas formas de estar certo, e o teste aceita as duas:
  //  1. amarrar a moeda uma vez no topo da tela (`const brl = (c) => money(c,
  //     currency)`), que é o que a conta e o painel fazem;
  //  2. estar na lista abaixo — telas que só existem no Brasil, uma a uma, com
  //     o motivo.
  const BR_ONLY = new Set([
    // A carteira da casa é fechada fora do Brasil pelo portão de mercado
    // (`house-service.createLoad`): a recarga é sempre Pix, a Espanha não
    // serve Pix, e a carteira coleta nome e telefone — o dado que a pendência
    // de residência do GDPR trava. Se algum dia a carteira abrir em Espanha, é
    // aqui que este teste avisa que faltam quatro telas.
    'Wallet.tsx', 'WalletPay.tsx', 'HousePay.tsx', 'AdminHouse.tsx',
  ]);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = path.join(import.meta.dirname, '..', 'src');

  const offenders: string[] = [];
  for (const file of fs.readdirSync(src)) {
    if (!file.endsWith('.tsx') || BR_ONLY.has(file)) continue;
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    // A tela amarrou a moeda uma vez? Então os `brl(x)` dela já a carregam.
    // Qualquer forma de amarrar serve — a conta usa `useCallback` e o painel
    // uma seta simples. O que o teste exige é que a definição LOCAL de `brl`
    // mencione `currency`; é isso que distingue "amarrado" de "padrão BRL".
    if (/const brl\b[^\n]*=[^\n]*currency/.test(text)) continue;
    for (const { line, n } of codeLines(text)) {
      // `brl(` com UM argumento: sem vírgula no nível de cima da chamada.
      for (const m of line.matchAll(/\bbrl\(([^;]*?)\)/g)) {
        const arg = m[1];
        const depth = (arg.match(/\(/g) || []).length - (arg.match(/\)/g) || []).length;
        if (depth !== 0) continue;                 // chamada partida em linhas
        if (!arg.includes(',')) offenders.push(`${file}:${n} ${m[0].slice(0, 40)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\ndinheiro sem moeda:\n${offenders.join('\n')}\n`);
});

test('todo código de erro que a API manda tem tradução', async () => {
  // Teste que atravessa os dois lados de propósito, porque o buraco é entre
  // eles: o servidor manda `code`, o cliente traduz, e ninguém quebra quando
  // um código novo aparece só num dos lados. Foi assim que `psp_market_mismatch`
  // nasceu sem tradução — a mensagem que a pessoa leria era a frase interna em
  // português, "psp so-brasil não emite em eur", numa tela em espanhol.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const api = path.join(import.meta.dirname, '..', '..', '..', 'api');

  // Códigos que NÃO são de tela: infraestrutura, alertas de conciliação e
  // canário. Nomeados um a um — a lista curta é o que faz o teste valer.
  const INTERNAL = new Set([
    'internal',                             // 500 mapeado, o cliente mostra o genérico
    'cron_secret_missing',                  // configuração do deploy
    'reconcile_threw', 'venue_reconcile_threw',
    'house_redeem_missing_payment_row', 'house_redeem_missing_payment_row_paid',
    'house_payment_row_without_redeem',     // achados de conciliação, vão pro fundador
    'br', 'es', 'racha',                    // `code` de mercado/marca, não de erro
  ]);

  const codes = new Set<string>();
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/code: '([a-z_]+)'/g)) codes.add(m[1]);
        for (const m of src.matchAll(/badRequest\([^;]*?'([a-z_]+)'\s*[,)]/g)) codes.add(m[1]);
      }
    }
  }(api));

  const missing = [...codes].filter((c) => !INTERNAL.has(c) && !(`err.${c}` in DICT)).sort();
  assert.deepEqual(missing, [], `\ncódigos sem tradução (a tela mostraria a frase interna):\n${missing.join('\n')}\n`);
});

/* ── a landing não pode se contradizer ─────────────────────────────────────── */

test('a landing de cada idioma promete UM trilho, e é o do mercado dela', () => {
  // Visto na tela em 2026-09-07: a landing espanhola dizia "PAGO EN LA MESA ·
  // ESPAÑA", prometia Bizum no herói, e duas linhas abaixo mostrava "Pix
  // directo a la cuenta del restaurante" — com a conta de exemplo em REAIS,
  // "237,10 R$", debaixo de "AL CÉNTIMO. SIEMPRE.". A página se contradizendo
  // três vezes na parte que é o argumento de venda.
  //
  // A landing não tem mesa, então não tem mercado do servidor: o idioma é o
  // único sinal. Este teste é o que impede que "o idioma decide" volte a
  // significar "cada frase decide sozinha".
  const RAILS = ['Pix', 'Bizum'] as const;
  const offenders: string[] = [];
  for (const lang of LANGS) {
    const mine = LANDING_MARKET[lang].rail;
    const theirs = RAILS.filter((r) => r.toLowerCase() !== mine);
    for (const [key, trio] of Object.entries(DICT)) {
      if (!/^(home|land)\./.test(key)) continue;
      // As chaves POR TRILHO existem justamente pra serem escolhidas em tempo
      // de render — `home.pixDirect` menciona Pix nos três idiomas de
      // propósito, e quem não é do trilho simplesmente não é renderizada.
      if (/(pix|bizum)Direct$/i.test(key)) continue;
      for (const other of theirs) {
        if (new RegExp(`\\b${other}\\b`).test((trio as Record<string, string>)[lang])) {
          offenders.push(`${key} (${lang}) promete ${other}, mas a landing ${lang} é ${mine}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});

test('a moeda da landing combina com o trilho dela', () => {
  // Um trilho e uma moeda que não se encontram no mundo real: Bizum só existe
  // em euro (a Stripe recusa qualquer outra — medido contra a API), e o Pix só
  // em real. Se a tabela algum dia disser "bizum + BRL", é aqui que quebra.
  const OK = { pix: 'BRL', bizum: 'EUR' } as const;
  for (const lang of LANGS) {
    const { rail, currency } = LANDING_MARKET[lang];
    assert.equal(currency, OK[rail], `landing ${lang}: ${rail} não cobra em ${currency}`);
  }
});
