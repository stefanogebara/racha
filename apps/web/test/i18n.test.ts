/**
 * Testes do dicionário. O que eles protegem não é a tradução em si — é o
 * silêncio: uma chave torta ou um `{placeholder}` que só existe num dos lados
 * não quebra o build, não quebra o teste de renderização, e aparece como
 * "{amount}" cru na tela de pagamento de alguém, num bar, em português.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT, LANGS, money, tError } from '../src/i18n.ts';

const entries = Object.entries(DICT) as [string, { en: string; pt: string }][];

test('toda chave tem os dois idiomas, não vazios', () => {
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
  const same = new Set([
    'lang.pt',      // "Português" se escreve assim em inglês também
    'check.total',  // "Total" / "Total"
    'share.item',   // "item" / "item"
    'gate.email',   // "e-mail" nos dois
    'card.demoCard',// "•••• 4242 (demo)" — número, não frase
    'cat.couvert',  // "Couvert" é francês nas duas
  ]);
  const copied = entries.filter(([k, p]) => p.en === p.pt && !same.has(k)).map(([k]) => k);
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

test('centavos exatos sobrevivem à formatação, nos dois idiomas', () => {
  for (const lang of LANGS) {
    assert.ok(money(1, lang).includes(lang === 'pt' ? '0,01' : '0.01'));
    assert.ok(money(0, lang).includes(lang === 'pt' ? '0,00' : '0.00'));
  }
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
