/**
 * Testes do dicionário. O que eles protegem não é a tradução em si — é o
 * silêncio: uma chave torta ou um `{placeholder}` que só existe num dos lados
 * não quebra o build, não quebra o teste de renderização, e aparece como
 * "{amount}" cru na tela de pagamento de alguém, num bar, em português.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { semComentarios } from './censo-taxid.ts';
import { join } from 'node:path';
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
/**
 * Os arquivos de `src`, DESCENDO. `readdirSync` não desce, e `src` é plana
 * hoje — mas a primeira pasta `src/components/` tirava metade das telas de
 * TODOS os quatro censos deste arquivo, em silêncio. O caminho volta relativo
 * pra mensagem de erro continuar legível.
 */
function arquivosDe(fs: typeof import('node:fs'), path: typeof import('node:path'),
                    raiz: string, sub = '', out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(raiz, sub), { withFileTypes: true })) {
    const rel = sub ? path.join(sub, e.name) : e.name;
    if (e.isDirectory()) arquivosDe(fs, path, raiz, rel, out);
    else out.push(rel);
  }
  return out;
}

function isProseLine(trimmed: string): boolean {
  const code = trimmed.replace(/\/\/.*$/, '').trim();
  if (code.length <= 12) return false;
  return /^[^<>{}()=;:`|&'"[\],]+$/.test(code);
}

/**
 * Apaga as interpolações da linha — `{...}` do JSX e `${...}` do template —
 * pondo `…` no lugar. O `…` não é `<`, `>`, `{` nem `}`, então a âncora
 * `>texto<` continua valendo com a prosa inteira em um pedaço só. Roda em
 * ponto fixo pra dar conta de chave dentro de chave.
 */
function maskExpr(line: string, re: RegExp = /\{[^{}]*\}/g): string {
  let out = line;
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(re, '…');
    if (next === out) break;
    out = next;
  }
  return out;
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
  //
  // Comparava só `en` com `pt`. O espanhol nunca entrava — e o modo de falha
  // descrito acima acontece igualzinho num `{table}` escrito `{mesa}` do lado
  // espanhol: chaves literais na tela de pagamento. Os TRÊS lados agora.
  const holes = (s: string) => new Set(s.match(/\{(\w+)\}/g) ?? []);
  for (const [key, pair] of entries) {
    const en = [...holes(pair.en)].sort();
    for (const lang of LANGS) {
      assert.deepEqual([...holes(pair[lang])].sort(), en,
        `${key}: placeholders diferentes — en ${en} vs ${lang} ${[...holes(pair[lang])]}`);
    }
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
    // A folha da carteira: "cancelar", "Pagar {amount}" e "autorizando…" são
    // cognatos exatos. Cada uma conferida à mão, como manda o comentário acima.
    'wallet.cancel:pt=es', 'wallet.payAmount:pt=es', 'wallet.authorizing:pt=es',
    // O saldo da casa: "pagando…" e "Mesa" se escrevem igual nas duas.
    'housepay.paying:pt=es', 'qrs.tableTitle:pt=es',
    // "Recarga mínima/máxima" se escreve igual nas duas.
    'house.cfgMinLoad:pt=es', 'house.cfgMaxLoad:pt=es',
    'rcpt.holder:pt=es', 'rcpt.bankLabel:pt=es', 'rcpt.bankCodeKnown:pt=es',
    'rcpt.optionalPh:pt=es', 'rcpt.sending:pt=es', 'rcpt.cancel:pt=es',
    'ledger.load:pt=es', 'ledger.refund:pt=es', 'cat.carne:pt=es',
    'cat.massa:en=es', 'cat.cafe:pt=es', 'land.nav:pt=es',
    'qrs.print:pt=es', // "Imprimir" é igual nas duas
    // "de {x} cobrados" e "a devolver a clientes" se escrevem igual nas duas
    // línguas — verificado palavra por palavra, não presumido pela semelhança.
    'panel.tipShort:pt=es', 'panel.toRefund:pt=es', 'panel.owedBack:pt=es',
    // "chargeback" é o termo usado em português no mercado de pagamentos
    // brasileiro — adquirente, bandeira e o próprio contrato do restaurante
    // dizem chargeback. Traduzir pra "estorno" seria PIOR: estorno é outra
    // coisa (devolução voluntária), e o dono precisa reconhecer a palavra que
    // vai ver na fatura do adquirente. O espanhol tem palavra própria.
    'panel.disputes:en=pt',
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

test('erro do servidor: código traduz; sem tradução vai o genérico; sem código vai o cru', () => {
  assert.equal(tError('en', 'check_closed', 'conta fechada'), 'This bill is already closed.');
  assert.equal(tError('pt', 'check_closed', 'conta fechada'), 'Esta conta já foi fechada.');

  // Este ramo MUDOU quando o servidor parou de mandar a frase junto do código.
  //
  // Antes, um código desconhecido caía no texto do servidor, e isso fazia
  // sentido enquanto havia texto. Agora um 4xx com código não manda mensagem —
  // porque a mensagem interna nomeava o adquirente da casa e servia de oráculo
  // de assinatura nos webhooks — então o "cru" que sobraria é o `HTTP 400` que
  // o `api.ts` inventa. Uma frase honesta em pé é melhor que isso.
  //
  // Um código sem tradução não deve existir: há um teste que varre a API e
  // exige `err.<code>` pra cada um. Este é o cinto, não a calça.
  assert.equal(tError('en', 'codigo_que_nao_existe', 'HTTP 400'), 'Something went wrong. Try again.');
  assert.equal(tError('es', 'codigo_que_nao_existe', 'HTTP 400'), DICT['err.generic'].es);

  // SEM código é um servidor mais velho, que ainda manda frase. Aí o texto dele
  // é melhor que um genérico: pode dizer algo específico e verdadeiro.
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
  for (const file of arquivosDe(fs, path, src)) {
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
    'carregando',
    // 2026-09-10: as três primeiras entraram porque o censo mais largo APONTOU
    // pras linhas certas — `Girar o QR da…`, `Desativar a…`, `Reembolsar…` — e
    // deixou passar assim mesmo. A ancoragem estava certa; o que falhava era a
    // lista. "Onze frases" era resultado do vocabulário, não do código, e é bom
    // dizer isso em voz alta: este teste é uma lista de negação, e uma lista de
    // negação só encontra o que alguém já pensou em escrever nela.
    'girar', 'desativar', 'reembolsar', 'reembolso', 'código', 'impresso',
    'funcionar', 'disponível', 'carteira', 'bônus', 'informe', 'equipe',
    'valor', 'valores', 'escanear', 'restaurante', 'idioma', 'enviar',
    // Segunda rodada, mesma lição: quatro rótulos do formulário do saldo
    // sobreviveram porque *validade*, *recarga*, *mínima* e *máxima* não
    // estavam aqui. O mecanismo vai continuar produzindo esses um lote por vez.
    'validade', 'recarga', 'mínima', 'máxima', 'mínimo', 'máximo'];
  const re = new RegExp(`\\b(${ptOnly.join('|')})\\b`, 'i');

  const offenders: string[] = [];
  for (const file of arquivosDe(fs, path, src)) {
    if (!/\.(tsx|ts)$/.test(file) || file === 'i18n.ts') continue;
    for (const { line, n } of codeLines(fs.readFileSync(path.join(src, file), 'utf8'))) {
      const trimmed = line.trim();
      // A linha SEM as interpolações e sem o comentário de fim de linha.
      //
      // `>...<` excluía `{` e `}` da classe, então prosa interrompida por
      // interpolação — `>inclui {brl(tip)} de serviço<` — não casava em pedaço
      // nenhum: o primeiro fragmento não fecha e o segundo não começa com `>`.
      // Foi assim que a folha da carteira ficou em português cru NO MOMENTO DA
      // AUTORIZAÇÃO, e a busca por substring do dicionário também não a via,
      // porque a fonte escreve `{brl(tipCents)}` onde o dicionário escreve
      // `{amount}`. Mascarar (em vez de partir a linha em pedaços soltos)
      // mantém a âncora `>...<`: sem ela o teste passa a ler atributo e código
      // como se fosse tela. Achado da revisão de 2026-09-10.
      const semComentario = line.replace(/(^|[^:])\/\/.*$/, '$1');
      const masked = maskExpr(semComentario);
      // Para os LITERAIS, só o `${...}` do template é apagado: o mascaramento
      // em ponto fixo come a chave de JSX inteira — `{busy ? '…' : `…`}` vira
      // um `…` só — e com ela o literal que se quer ler.
      const semTpl = maskExpr(semComentario, /\$\{[^{}]*\}/g);
      const candidates = [
        ...[...masked.matchAll(/>([^<>{}]{4,})</g)].map((m) => m[1]),
        ...[...masked.matchAll(/(?:placeholder|title|aria-label)="([^"]{4,})"/g)].map((m) => m[1]),
        // Prosa de JSX que ocupa VÁRIAS linhas: as linhas do meio não têm `>`
        // nem `<`, então a regra de cima não as vê. Foi assim que o parágrafo
        // do AdminStripe — três linhas em português, mencionando o Pix numa
        // tela espanhola — passou pela primeira versão deste teste. Uma linha
        // que é só texto (sem tag, sem chave, sem código) é prosa de tela.
        ...(isProseLine(trimmed) ? [trimmed] : []),
        // FRASE dentro de literal de string. `{busy ? 'pagando…' : `Pagar
        // ${brl(x)} com saldo`}` está em posição de JSX mas some no mascaramento
        // — e era o botão que o cliente aperta pra gastar o saldo. Só literais
        // com ESPAÇO entram: `setStep('conta')` é chave de máquina de estados,
        // não tela, e é essa diferença que a lista de palavras sozinha não faz.
        ...[...semTpl.matchAll(/'([^']{4,})'|"([^"]{4,})"|`([^`]{4,})`/g)]
             .map((m) => m[1] ?? m[2] ?? m[3]).filter((x) => /\s/.test(x)),
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

test('o título ESTÁTICO não tem idioma — senão a aba pisca', () => {
  // O `index.html` trazia "Racha — pay at the table". O idioma real só se sabe
  // depois que o `/api/check` devolve o `defaultLang` da casa, então numa mesa
  // brasileira a aba mostrava inglês e depois virava português. A marca não tem
  // idioma; a frase entra quando o idioma se resolve. Achado testando no
  // navegador, 2026-09-13.
  // SEM os comentários: um comentário HTML não é renderizado, e o desta linha
  // cita justamente o título antigo pra explicar por que ele saiu. A regra é
  // sobre o que o navegador MOSTRA.
  const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const titulo = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
  assert.equal(titulo.trim(), 'Racha');
  // E nenhuma das frases traduzidas pode estar no HTML estático — em lugar
  // nenhum dele, não só no `<title>`: escondê-la num `<meta description>` é o
  // mesmo defeito com outra tag.
  for (const lang of LANGS) {
    assert.ok(!html.includes(DICT['doc.title'][lang]),
      `o index.html traz a frase de ${lang} — a aba vai piscar`);
  }
});

test('o `lang` estático é o padrão do produto — não um idioma qualquer', () => {
  // `<html lang="pt-BR">` com o app montando em `en`. O documento declarava
  // uma língua, o leitor de tela era avisado dela, e a primeira coisa
  // renderizada era outra. O teste de cima dizia "nenhum idioma no HTML
  // estático" e não olhava o atributo que É uma declaração de idioma.
  // Achado pela revisão de segurança de 2026-09-13.
  const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const lang = html.match(/<html[^>]*\slang="([^"]*)"/)?.[1] ?? '';

  // O ACOPLAMENTO, não o literal. A primeira versão afirmava `lang === 'en'`
  // com a mensagem "tem que casar com o padrão de lang.tsx" e nunca abria o
  // `lang.tsx`: trocar o padrão de lá pra 'pt' deixava este teste verde com o
  // `index.html` errado de novo. Uma asserção que descreve um acoplamento sem
  // ler as duas pontas é uma frase, não um guarda — é literalmente o achado
  // que o `docs/decisions/2026-09-10-frase-escrita-do-guarda-que-eu-olhava.md`
  // registra. Achado pela revisão de segurança de 2026-09-13.
  const langTsx = readFileSync(join(import.meta.dirname, '..', 'src', 'lang.tsx'), 'utf8');
  const padrao = langTsx.match(/return \{ lang: '(\w+)', escolhido: false \}/)?.[1];
  assert.ok(padrao, 'não achei o padrão do produto em lang.tsx — o acoplamento deixou de ser legível');
  const mapa = langTsx.match(/const HTML_LANG[^=]*=\s*\{([^}]*)\}/)?.[1] ?? '';
  const esperado = mapa.match(new RegExp(`\\b${padrao}:\\s*'([^']+)'`))?.[1];
  assert.ok(esperado, `HTML_LANG não tem entrada pra '${padrao}'`);
  assert.equal(lang, esperado,
    `o \`lang\` do index.html (${lang}) tem que ser o padrão do lang.tsx mapeado por HTML_LANG (${esperado})`);
});

test('o manifesto do PWA fala a língua padrão, e o censo sabe que ele existe', () => {
  // O `manifest.webmanifest` tem uma frase em inglês que o SISTEMA mostra na
  // hora de instalar — fora do `DICT`, então o laço de frases traduzidas não
  // podia vê-la. Ela NÃO é um defeito: o manifesto é buscado antes de existir
  // app, idioma escolhido ou casa conhecida, e não há como trocá-lo sem
  // negociação no servidor. O que seria defeito é ele falar uma língua que não
  // é o padrão do produto — aí a instalação prometeria noutra língua o que a
  // tela abre dizendo. Fica anotado aqui pra que a próxima pessoa ache o
  // arquivo, em vez de descobri-lo numa revisão.
  const manifest = JSON.parse(readFileSync(
    join(import.meta.dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Racha');
  for (const lang of LANGS) {
    if (lang === 'en') continue;
    assert.ok(!manifest.description.includes(DICT['doc.title'][lang]),
      `o manifesto traz a frase de ${lang}, mas o produto abre em inglês`);
  }
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
  for (const file of arquivosDe(fs, path, src)) {
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
  for (const file of arquivosDe(fs, path, src)) {
    if (!file.endsWith('.tsx') || BR_ONLY.has(file)) continue;
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    // A tela amarrou a moeda uma vez? Então os `brl(x)` dela já a carregam.
    // Qualquer forma de amarrar serve — a conta usa `useCallback` e o painel
    // uma seta simples. O que o teste exige é que a definição LOCAL de `brl`
    // mencione `currency`; é isso que distingue "amarrado" de "padrão BRL".
    if (/const brl\b[^\n]*=[^\n]*currency/.test(text)) continue;
    // `useCallback((c) => money(c, lang, currency))` também amarra — é a forma
    // que a conta usa. O que o teste exige é que a definição LOCAL de `brl`
    // mencione `currency`, em qualquer forma.

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
    'retention_unavailable',                // store sem o método: defeito de deploy, não tela
    'retention_no_dry_run',                 // inspeção manual do cron; nenhum cliente vê
    'reconcile_threw', 'venue_reconcile_threw',
    'house_redeem_missing_payment_row', 'house_redeem_missing_payment_row_paid',
    'house_payment_row_without_redeem',
    'mixed_currency', 'dispute_evidence_due', 'dispute_evidence_overdue',
    'webhook_invalid', 'money_event_unrecorded', 'dispute_close_unrecorded',
    // Achados de conciliação sobre valor recebido ≠ pedido: vão pro relatório
    // do restaurante e pro alerta do fundador, nunca pra tela de quem paga.
    // (O `overpaid_pending_restitution` é a exceção: é achado E aviso do
    // cliente, e por isso tem tradução `notice.`.)
    'underpayment', 'overpayment', 'tip_mismatch',
                                            // webhook: nenhum diner vê
                                            // achados de conciliação, vão pro fundador
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
        // `httpError(404, 'venue not found', 'venue_not_found')` — a terceira
        // forma. Dois dos seis códigos novos do saldo da casa estavam fora do
        // guarda e passaram só porque eu escrevi as traduções à mão. O
        // próximo `httpError(…, 'novo')` sairia verde mostrando `err.generic`.
        for (const m of src.matchAll(/httpError\([^;]*?'([a-z_]+)'\s*[,)]/g)) codes.add(m[1]);
        // A forma POSICIONAL da conciliação: `add('critical', 'ledger_drift', …)`.
        //
        // O censo só via `code: '…'`, e é assim que TODO achado de conciliação
        // é escrito — então a família inteira estava invisível pra ele. Ficou
        // aparente quando um código novo (`payables_unchecked`, escrito na
        // outra forma) foi pego sozinho enquanto quatro irmãos dele passavam.
        // Um censo com ponto cego é a coisa que ele existe pra impedir.
        // Primeiro argumento QUALQUER (sem vírgula): a severidade também vem
        // como ternário — `add(delta <= 1 ? 'info' : 'critical', 'codigo', …)`
        // — e exigir o literal deixava esses passarem também.
        for (const m of src.matchAll(/\badd\(([^,]*),\s*'([a-z_]+)'/g)) codes.add(m[2]);
      }
    }
  }(api));

  // Duas famílias traduzíveis: `err.` (deu errado) e `notice.` (aconteceu algo
  // com o SEU dinheiro que a casa te deve — pagou a mais, estorno que falhou).
  // As duas chegam ao cliente como código estável + centavos, e as duas têm
  // que ter frase nos três idiomas.
  // TRÊS famílias traduzíveis: `err.` (deu errado), `notice.` (o SEU dinheiro,
  // na tela de quem pagou) e `find.` (achado da conciliação, na tela do dono).
  // Todas chegam como código estável + centavos; todas precisam das três
  // línguas.
  const missing = [...codes]
    .filter((c) => !INTERNAL.has(c)
      && !(`err.${c}` in DICT) && !(`notice.${c}` in DICT) && !(`find.${c}` in DICT))
    .sort();
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

test('todo achado com {amount} na frase tem um campo de centavos que o painel lê', () => {
  // A cadeia do `textoDoAchado` no Panel é
  // `overpaidCents ?? deltaCents ?? driftCents ?? amountCents`. Uma frase com
  // `{amount}` cujo achado não carrega nenhum desses renderiza "{amount}"
  // literal na tela do dono — pior que não ter frase.
  //
  // O par (chave, campo) é conferido aqui porque ele atravessa dois arquivos:
  // a frase mora no dicionário e o número, no achado da conciliação.
  const CAMPOS = ['overpaidCents', 'deltaCents', 'driftCents', 'amountCents'];
  const comValor: Record<string, string> = {
    'find.custody_leak': 'amountCents',
    'find.payable_amount_mismatch': 'deltaCents',
    'find.overpaid_pending_restitution': 'overpaidCents',
    'find.ledger_drift': 'driftCents',
    'find.underpayment': 'deltaCents',
    'find.overpayment': 'deltaCents',
    'find.paid_after_close': 'amountCents',
  };
  for (const [chave, campo] of Object.entries(comValor)) {
    assert.ok(chave in DICT, `${chave} não está no dicionário`);
    for (const lang of ['en', 'pt', 'es'] as const) {
      assert.match(DICT[chave as keyof typeof DICT][lang], /\{amount\}/,
        `${chave}.${lang} deveria usar {amount}`);
    }
    assert.ok(CAMPOS.includes(campo), `${campo} não está na cadeia do Panel`);
  }
  // E toda frase `find.*` que usa {amount} tem que estar declarada acima —
  // senão alguém acrescenta uma frase com placeholder e nenhum número.
  const semDeclaracao = Object.keys(DICT)
    .filter((k) => k.startsWith('find.') && /\{amount\}/.test(DICT[k as keyof typeof DICT].en))
    .filter((k) => !(k in comValor));
  assert.deepEqual(semDeclaracao, [],
    `frases com {amount} sem campo de centavos declarado:\n${semDeclaracao.join('\n')}`);
});

test('a rota do painel MANDA os centavos que o painel formata', async () => {
  // O par (frase, campo) já era conferido; o que faltava era o pedaço do meio.
  // A projeção de `/api/panel` mandava só `severity`, `code` e `message`, e o
  // painel traduz pelo código formatando os centavos — então toda frase com
  // `{amount}` saía LITERAL na tela do dono. Dois arquivos conferidos cada um
  // por si, e o defeito no espaço entre eles.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const router = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', '..', 'api', '_app', 'router.js'), 'utf8');
  const panel = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'Panel.tsx'), 'utf8');

  // A cadeia que o painel lê pra preencher {amount}.
  const cadeia = panel.match(/const valor = ([^;]+);/);
  assert.ok(cadeia, 'não achei a cadeia de centavos no Panel');
  const campos = [...cadeia[1].matchAll(/f\.(\w+)/g)].map((m) => m[1]);
  assert.ok(campos.length >= 4, `cadeia curta demais: ${campos.join(', ')}`);

  // A projeção da rota, onde os achados são mapeados.
  // A projeção mora em `projetarAchados`, e a rota chama a função.
  const i = router.indexOf('function projetarAchados(');
  assert.ok(i > 0 && router.includes('findings: projetarAchados(r.findings)'), 'não achei a projeção dos achados na rota');
  const projecao = router.slice(i, i + 2400);
  const faltando = campos.filter((c) => !projecao.includes(c));
  assert.deepEqual(faltando, [], `campos que o painel lê e a rota não manda:\n${faltando.join('\n')}`);
});

test('nenhuma tela põe o texto CRU do erro no estado — o servidor manda código', () => {
  // `lang.tsx:156` conta que vinte e uma telas faziam
  // `setError((e as Error).message)` e foram convertidas. A conversão não
  // deixou guarda nenhum atrás de si, e três chamadores ficaram pra trás —
  // achados quando duas chaves novas do dicionário (`tax_id_invalid`,
  // `recipient_doc_mismatch`) chegavam ao dono como "HTTP 400": o 4xx vem só
  // com `code`, o `api.ts` cai no status quando não há `error`, e a tela
  // mostrava o status cru. Dicionário preenchido, frase nunca exibida.
  // Achado pela revisão de segurança de 2026-09-13.
  const src = join(import.meta.dirname, '..', 'src');
  function anda(dir: string, base = dir): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...anda(p, base));
      else if (/\.tsx?$/.test(e.name)) out.push(p.slice(base.length + 1));
    }
    return out;
  }
  // ALLOWLIST, não denylist. A versão anterior casava UMA grafia
  // (`set…((e as Error).message)`) e deixava passar `catch (error)`, o cast
  // pra `ApiError` — a classe DESTE repositório —, o apelido em duas linhas,
  // o `instanceof`, o objeto de estado e o sink com outro nome. O último
  // estava VIVO: `StripeWalletPay` mandava `error.message` do SDK da Stripe,
  // em inglês, pra tela de pagamento de quem janta no Brasil.
  //
  // Agora: nenhuma leitura de `.message` no `src/`, em forma nenhuma, fora dos
  // tradutores. Uma regra, todas as grafias.
  const TRADUTOR = /\b(tErr|tError)\s*\(/;
  /**
   * As dispensas, com razão escrita — dispensa é a afirmação de que alguém
   * leu. Duas famílias, e nenhuma delas é "exibir texto de terceiro":
   *
   *  · `asMessage` (WalletPay) LÊ a mensagem pra reconhecer uma CHAVE do
   *    nosso dicionário que o SDK carregou como texto de erro, e traduz. É o
   *    contrário de exibir cru.
   *  · `auth.ts` re-LANÇA o erro do Supabase; quem exibe é a tela, e lá o
   *    `tErr` entra. Apagar a mensagem aqui apagaria o diagnóstico do
   *    desenvolvedor sem melhorar nada pro leitor.
   */
  const DISPENSAS = [
    { arquivo: 'WalletPay.tsx', trecho: "const raw = (e as Error).message || '';" },
    { arquivo: 'auth.ts', trecho: 'throw new Error(error.message);' },
  ];
  // Comentários somem ESTRUTURALMENTE, com o mesmo removedor do censo de
  // `taxId`. A versão anterior adivinhava por indentação — "linha indentada
  // que começa com palavra e não tem `;(){}`" — e isso dispensava
  // `      e.message`, que é exatamente o que o prettier produz ao quebrar
  // uma chamada longa: a mesma forma de sink que pôs o inglês da Stripe na
  // tela de pagamento. Uma allowlist com heurística de prosa dentro volta a
  // depender de grafia.
  const ofensores: string[] = [];
  for (const f of anda(src)) {
    semComentarios(readFileSync(join(src, f), 'utf8')).split('\n').forEach((linha, i) => {
      const sem = linha;
      if (!/\.message\b/.test(sem)) return;
      if (TRADUTOR.test(sem)) return;              // a reserva do tradutor é o contrato
      if (DISPENSAS.some((d) => f.endsWith(d.arquivo) && sem.includes(d.trecho))) return;
      ofensores.push(`${f}:${i + 1} ${sem.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(ofensores, [], `\n${ofensores.join('\n')}\n`);
});

/**
 * O CENSO DE MARCADORES — todo `{x}` de uma chave de erro tem que ser servido.
 *
 * Duas vezes o mesmo defeito: uma chave de erro ganha um marcador novo, os dois
 * mapeadores de `vars` continuam servindo o trio de dinheiro (`left`, `min`,
 * `max`), e o `fill` — que deixa marcador desconhecido VERBATIM — põe `{max}`,
 * e depois `{limit}`, na tela de pagamento. A segunda vez foi o teto de
 * cobranças vivas: a mensagem que diz ao cliente o que fazer chegava dizendo
 * "({limit} em {windowMinutes} min)". Achado pela revisão de compliance de
 * 2026-09-15 (HIGH-3).
 *
 * O censo lê os DOIS mapeadores como fonte da verdade: marcador que nenhum
 * deles serve é marcador que vai chegar literal a alguém.
 */
test('todo marcador de toda chave err.* é servido pelos DOIS mapeadores', () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8');
  /** As chaves servidas por um mapeador de `vars`, lidas do próprio código. */
  const servidos = (texto: string): Set<string> => {
    // `err.vars ?` no App.tsx e `err?.vars ?` no lang.tsx — o encadeamento
    // opcional é ortografia, não identidade, e ancorar na literal cegava o
    // censo num dos dois lados (medido: zero servidos, ✓ sobre nada).
    const m = /err\??\.vars \?/.exec(texto);
    const bloco = m ? texto.slice(m.index, m.index + 1400) : '';
    return new Set([...bloco.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]));
  };
  const deApp = servidos(src('App.tsx'));
  const deLang = servidos(src('lang.tsx'));
  // O censo tem que ACHAR os mapeadores: zero servidos daria ✓ sobre nada.
  assert.ok(deApp.size >= 3, `App.tsx: ${[...deApp]}`);
  assert.ok(deLang.size >= 3, `lang.tsx: ${[...deLang]}`);

  const i18n = src('i18n.ts');
  const orfaos: string[] = [];
  for (const m of i18n.matchAll(/'(err\.[a-z_0-9.]+)':\s*\{([\s\S]{0,700}?)\n\s{2}'/g)) {
    const [, chave, corpo] = m;
    for (const ph of new Set([...corpo.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((x) => x[1]))) {
      if (!deApp.has(ph)) orfaos.push(`${chave}: {${ph}} não servido pelo App.tsx`);
      if (!deLang.has(ph)) orfaos.push(`${chave}: {${ph}} não servido pelo lang.tsx`);
    }
  }
  assert.deepEqual(orfaos, []);
});
