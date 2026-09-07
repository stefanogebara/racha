/**
 * Testes do dicionário. O que eles protegem não é a tradução em si — é o
 * silêncio: uma chave torta ou um `{placeholder}` que só existe num dos lados
 * não quebra o build, não quebra o teste de renderização, e aparece como
 * "{amount}" cru na tela de pagamento de alguém, num bar, em português.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT, LANGS, money, tError } from '../src/i18n.ts';

const entries = Object.entries(DICT) as [string, { en: string; pt: string; es: string }][];

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
    'lang.pt:en=pt', 'lang.pt:en=es', 'lang.pt:pt=es', // "Português" nas três
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
    const lines = fs.readFileSync(path.join(src, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // Comentários são prosa pro próximo humano, e essa prosa é em português
      // de propósito no repositório inteiro.
      if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed)) return;
      for (const [key, pt] of phrases) {
        if (line.includes(pt)) {
          offenders.push(`${file}:${i + 1} escreve "${pt}" — use t('${key}')`);
        }
      }
    });
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
    'recebedor', 'dígito', 'próximo', 'voltar', 'salvando', 'pronto'];
  const re = new RegExp(`\\b(${ptOnly.join('|')})\\b`, 'i');

  const offenders: string[] = [];
  for (const file of fs.readdirSync(src)) {
    if (!/\.(tsx|ts)$/.test(file) || file === 'i18n.ts') continue;
    // Blocos de comentário são prosa pro próximo humano, e essa prosa é em
    // português de propósito no repositório inteiro. Precisa de ESTADO: um
    // `{/* … */}` de várias linhas tem linhas do meio sem marcador nenhum, e
    // sem rastrear a abertura elas parecem texto de tela.
    let inBlock = false;
    fs.readFileSync(path.join(src, file), 'utf8').split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      const opens = /\{?\/\*/.test(line);
      const closes = /\*\/\}?/.test(line);
      if (inBlock) {
        if (closes) inBlock = false;
        return;
      }
      if (opens && !closes) { inBlock = true; return; }
      if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed) || (opens && closes)) return;
      const candidates = [
        ...[...line.matchAll(/>([^<>{}]{4,})</g)].map((m) => m[1]),
        ...[...line.matchAll(/(?:placeholder|title|aria-label)="([^"]{4,})"/g)].map((m) => m[1]),
        // Prosa de JSX que ocupa VÁRIAS linhas: as linhas do meio não têm `>`
        // nem `<`, então a regra de cima não as vê. Foi assim que o parágrafo
        // do AdminStripe — três linhas em português, mencionando o Pix numa
        // tela espanhola — passou pela primeira versão deste teste. Uma linha
        // que é só texto (sem tag, sem chave, sem código) é prosa de tela.
        ...(/^[^<>{}()=;:`|&]+$/.test(trimmed) && trimmed.length > 12 ? [trimmed] : []),
      ];
      for (const c of candidates) {
        if (re.test(c)) offenders.push(`${file}:${i + 1} texto de tela em português: ${JSON.stringify(c.trim().slice(0, 60))}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});
