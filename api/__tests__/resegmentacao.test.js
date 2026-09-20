'use strict';

/**
 * O QUARTO EIXO: RE-SEGMENTAÇÃO. Mesmas palavras, outra pontuação.
 *
 * Os três eixos que já existiam seguram a pontuação FIXA. O fabricador injeta
 * uma palavra e nunca um sinal; a grade de preâmbulos acrescenta palavras na
 * frente; "os dois vereditos" é um seletor, não um eixo. E enquanto isso, TODA
 * decisão de escopo dos dois guardas é pontuação: o `oracoes` corta em
 * `.;!?:\n—`, o `segmentos` no `separador_de_clausula`, a janela do `nega` e o
 * `fimDoTrecho` no `separador_interno`. O corpo fixa UMA pontuação por caso —
 * a que o autor escolheu no minuto em que escreveu o caso — e um modelo de
 * linguagem escolhe pontuação livremente, no meio da frase, por ritmo.
 *
 * O caso que obrigou este arquivo a existir: `A caixinha, dos atendentes do
 * salão` estava APOSENTADO, e a nota dele dizia que a versão com dois-pontos
 * tinha escapado e fora reescrita com vírgula porque "um modelo escreveria com
 * vírgula". Um modelo escreve TRAVESSÃO com a mesma facilidade — e o travessão
 * tinha sido acrescentado ao `oracoes` no mesmo arquivo. A mitigação declarada
 * era uma escolha de pontuação que o adversário controla.
 * Pedido pela revisão de compliance de 2026-09-14.
 *
 * O QUE ISTO NÃO MEDE: troca UM sinal por vez, não dois; e não inventa
 * pontuação onde não havia, só troca a que está lá.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const F = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'afirmacoes.fixture.json'), 'utf8'));
const G = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;
const FONTE = fs.readFileSync(path.join(__dirname, 'claims.test.js'), 'utf8');

function carrega() {
  const corpo = FONTE.slice(0, FONTE.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');", 'const RAIZ = ' + JSON.stringify(RAIZ) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
      'require(' + JSON.stringify(path.join(RAIZ, 'scripts')) + " + '/");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reseg-'));
  const arq = path.join(tmp, 'censo.js');
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  return require(arq);
}

/**
 * Os sinais que um modelo troca por outro sem mudar o que quis dizer.
 *
 * Separar mais (`,` → `—`) e separar menos (`.` → `,`) são as duas direções, e
 * as duas importam: a primeira tira a promessa do alcance da regra 1, a
 * segunda junta duas frases inocentes numa oração só.
 */
const TROCAS = {
  ',': [' —', ':', '\n', ';', ' e'],
  '.': [',', ' —', ' ', ':'],
  '\n': [', ', ' — ', ' ', ': '],
  '?': ['.', ' —'],
  '!': ['.', ' —'],
};

function* reescritas(texto) {
  for (let i = 0; i < texto.length; i += 1) {
    const alvos = TROCAS[texto[i]];
    if (!alvos) continue;
    // Vírgula DECIMAL não é pontuação de frase: `R$ 12,00` partido ao meio não
    // é uma reescrita, é outro número. O guarda já sabe disso — o
    // `separador_interno` tem o mesmo lookaround — e o instrumento precisa
    // saber também, senão ele mede a própria ignorância.
    if (texto[i] === ',' && /\d/.test(texto[i - 1] || '') && /\d/.test(texto[i + 1] || '')) continue;
    for (const novo of alvos) {
      const v = `${texto.slice(0, i)}${novo}${texto.slice(i + 1)}`;
      // MAIÚSCULA DEPOIS DE UM SINAL QUE NÃO FECHA FRASE não é reescrita, é
      // outra frase. Trocar `.` por ` ` em `…o serviço. Chama o atendente…`
      // produz `…o serviço  Chama…`, que ninguém escreve: a maiúscula é ela
      // mesma o limite de oração que o sinal marcava. O instrumento estava
      // medindo a própria ignorância, e é o mesmo critério que já recusou
      // `Serviço: 10%, - da equipe` (marcador de lista no meio da linha).
      // Apontado pela revisão de compliance de 2026-09-14.
      const depois = v.slice(i + novo.length).replace(/^\s+/, '');
      if (!/[.?!]/.test(novo) && /^\p{Lu}/u.test(depois)) continue;
      yield [v, `${texto[i]}→${novo}`, i];
    }
  }
}

const TOLERADAS = G._reescritas_toleradas || {};
const chave = (v) => v.replace(/⏎/g, '\n');

describe('as tolerâncias da re-segmentação têm a disciplina das dispensas', () => {
  test('cada uma nomeia um caso do corpo, tem razão escrita, e é usada', () => {
    const { acusa } = carrega();
    const casos = new Map(F.casos.map((c) => [c.texto, c]));
    expect(Object.keys(TOLERADAS).filter((t) => !casos.has(t))).toEqual([]);
    let variantes = 0;
    const naoUsadas = [];
    for (const [caso, porVariante] of Object.entries(TOLERADAS)) {
      const c = casos.get(caso);
      const caem = new Set();
      for (const [v] of reescritas(caso)) if (acusa(v) !== c.recusa) caem.add(v);
      for (const [v, r] of Object.entries(porVariante)) {
        if (!caem.has(chave(v))) naoUsadas.push(v);
        expect(`${caso}: ${r}`).toMatch(/.{80,}/);
        variantes += 1;
      }
    }
    // Tolerância que não tolera nada é buraco esquecido — a mesma disciplina
    // das dispensas do censo e das injeções do fabricador.
    expect(naoUsadas).toEqual([]);
    expect(variantes).toBeLessThanOrEqual(40);
    // ESCAPE E FALSO POSITIVO SÃO CONTADOS SEPARADO, com tetos separados.
    // Uma gaveta que não distingue `recusamos algo inocente` de `deixamos
    // passar uma promessa` absorve um escape por rodada — e absorveu um, que a
    // revisão de segurança achou arquivado entre os falsos positivos com uma
    // razão que argumentava contra uma correção que ninguém tinha proposto.
    // Apontado pela revisão de segurança de 2026-09-14.
    const escapes = Object.keys(TOLERADAS)
      .filter((t) => casos.get(t).recusa)
      .reduce((n, t) => n + Object.keys(TOLERADAS[t]).length, 0);
    const fp = variantes - escapes;
    expect({ escapes, fp }).toEqual({ escapes: expect.any(Number), fp: expect.any(Number) });
    // O teto do ESCAPE é apertado de propósito: cada um tem que ser uma
    // decisão escrita, não um resto.
    expect(escapes).toBeLessThanOrEqual(4);
    expect(fp).toBeLessThanOrEqual(12);
  });
});

describe('outra pontuação não desfaz uma promessa', () => {
  const { acusa } = carrega();
  test.each(F.casos.map((c) => [c.texto.replace(/\n/g, ' ⏎ ').slice(0, 60), c]))(
    '%s', (_nome, c) => {
      const caiu = [];
      for (const [variante] of reescritas(c.texto)) {
        if (acusa(variante) !== c.recusa) caiu.push(variante.replace(/\n/g, '⏎'));
      }
      const naoDeclaradas = [...new Set(caiu)]
        .filter((v) => !(TOLERADAS[c.texto] || {})[v]);
      expect({ caso: c.texto.slice(0, 40), naoDeclaradas })
        .toEqual({ caso: c.texto.slice(0, 40), naoDeclaradas: [] });
    });
});
