'use strict';

/**
 * O QUINTO INSTRUMENTO: VOCABULÁRIO ADVERSARIAL.
 *
 * Todo escape de palavra deste arquivo — `gar[çc]on` contra `garçom`, `time`
 * com o artigo embutido, `cai(em)?` que nunca casava, `gorjetinha`, `troco`,
 * `porcentagem` — é uma palavra que o autor do corpo não pensou. E não podia
 * pensar: o corpo, as listas de vocabulário e a regra foram escritos pela
 * MESMA mão, quase sempre no mesmo commit. Um corpo assim prova que o código
 * de hoje passa nas frases de hoje; ele não pode produzir a palavra que falta.
 *
 * Então a lista vem de FORA. Os substantivos abaixo são o vocabulário de
 * dinheiro do português do Brasil — incluindo os diminutivos, que são o
 * registro que o `SystemPrompt` pede e são a palavra que o CLIENTE digita (um
 * modelo espelha o vocabulário da pergunta que recebeu, e o texto julgado é só
 * o turno dele). Nenhum foi colhido lendo o `claims.json`.
 * Pedido pelas revisões de compliance e segurança de 2026-09-14, que
 * convergiram nele independentemente.
 *
 * O QUE ISTO NÃO MEDE: uma lista de fora continua sendo uma lista. Ela não
 * cobre entrada livre; o que ela faz é garantir que a próxima palavra que
 * faltar FALHE ALTO aqui em vez de passar calada no runtime.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const G = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;
const FONTE = fs.readFileSync(path.join(__dirname, 'claims.test.js'), 'utf8');

function carrega() {
  const corpo = FONTE.slice(0, FONTE.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');", 'const RAIZ = ' + JSON.stringify(RAIZ) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
      'require(' + JSON.stringify(path.join(RAIZ, 'scripts')) + " + '/");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-'));
  const arq = path.join(tmp, 'censo.js');
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  return require(arq);
}

/** [substantivo, gênero]. O gênero existe pro quadro sair em português: um
 *  `A agradinho` mede a gramática de quem escreveu a grade, não o guarda. */
const DINHEIRO = [
  ['gorjeta', 'f'], ['gorjetinha', 'f'], ['caixinha', 'f'], ['comissão', 'f'],
  ['comissãozinha', 'f'], ['agrado', 'm'], ['agradinho', 'm'], ['gratificação', 'f'],
  ['serviço', 'm'], ['taxa', 'f'], ['taxinha', 'f'], ['tarifa', 'f'], ['percentual', 'm'],
  ['percentualzinho', 'm'], ['porcentagem', 'f'], ['parcela', 'f'], ['fatia', 'f'],
  ['quinhão', 'm'], ['importância', 'f'], ['quantia', 'f'], ['montante', 'm'], ['soma', 'f'],
  ['dinheiro', 'm'], ['dinheirinho', 'm'], ['grana', 'f'], ['graninha', 'f'],
  ['trocado', 'm'], ['troco', 'm'], ['troquinho', 'm'], ['extra', 'm'], ['adicional', 'm'],
  ['acréscimo', 'm'], ['bônus', 'm'], ['prêmio', 'm'], ['recompensa', 'f'],
  ['contribuição', 'f'], ['colaboração', 'f'], ['ajuda', 'f'], ['ajudinha', 'f'],
  ['lembrança', 'f'], ['mimo', 'm'], ['cortesia', 'f'], ['propina', 'f'], ['verba', 'f'],
  ['renda', 'f'], ['salário', 'm'], ['remuneração', 'f'], ['repasse', 'm'], ['rateio', 'm'],
  ['vaquinha', 'f'], ['arrecadação', 'f'], ['gueltas', 'f'], ['valorzinho', 'm'],
  ['partezinha', 'f'],
];

/**
 * Os TRÊS quadros são as três relações que o arquivo já distingue: alativa
 * (`vai pro`), possessiva (`fica com`) e genitiva (`é do`). Um substantivo que
 * escapa num só não é menos escape que um que escapa nos três.
 */
const QUADROS = [
  (n, a) => `${a} ${n} vai pro garçom.`,
  (n, a) => `${a} ${n} fica com a equipe.`,
  (n, a) => `${a} ${n} é do garçom.`,
];
const ARTIGO = { m: 'O', f: 'A' };

/**
 * A gaveta: substantivo de dinheiro que o guarda deliberadamente NÃO trata
 * como a gorjeta, com o motivo escrito. Tem a disciplina das dispensas — a
 * razão é lida, e uma entrada que parar de ser necessária falha aqui.
 */
const FORA = G._dinheiro_fora || {};

describe('o vocabulário de dinheiro que veio de fora', () => {
  const { acusa } = carrega();

  test('todo substantivo de dinheiro é reconhecido nas três relações', () => {
    const fura = [];
    for (const [n, g] of DINHEIRO) {
      if (FORA[n]) continue;
      for (const q of QUADROS) {
        const t = q(n, ARTIGO[g]);
        if (!acusa(t)) fura.push(t);
      }
    }
    expect(fura).toEqual([]);
  });

  test('a gaveta do que ficou de fora é usada, e tem motivo escrito', () => {
    const nomes = new Set(DINHEIRO.map(([n]) => n));
    expect(Object.keys(FORA).filter((n) => !nomes.has(n))).toEqual([]);
    for (const [n, porque] of Object.entries(FORA)) {
      expect(`${n}: ${porque}`).toMatch(/.{80,}/);
      // Declarado fora, mas o guarda o reconhece? Então a declaração
      // envelheceu e sai — a mesma regra das dispensas do censo.
      const g = DINHEIRO.find(([x]) => x === n)[1];
      expect(QUADROS.some((q) => !acusa(q(n, ARTIGO[g])))).toBe(true);
    }
  });

  /**
   * O DIMINUTIVO É UMA CLASSE PRODUTIVA, não uma lista. Em português qualquer
   * substantivo ganha `-inho/-inha`, e o cliente usa: `gorjetinha`,
   * `dinheirinho`, `graninha`, `ajudinha`. Este teste DERIVA a forma a partir
   * de cada nome de dinheiro e exige que ela seja reconhecida — o mesmo
   * argumento que fez o `adverbio` tratar `-mente` como morfologia em vez de
   * enumerar advérbios.
   */
  test('o diminutivo de todo substantivo de dinheiro é reconhecido', () => {
    // A DERIVAÇÃO É CONSERVADORA DE PROPÓSITO. O diminutivo português só é
    // mecânico quando a palavra termina em `-o`/`-a` átono precedido de
    // CONSOANTE: `gorjeta→gorjetinha`, `troco→troquinho`,
    // `lembrança→lembrancinha`. Nasal (`-ão`), hiato (`fatia`, `prêmio`) e
    // final consonântico pedem `-zinho`, e aí a forma varia com o falante —
    // derivar essas produziria `comissãinho` e `fatiinha`, e o teste passaria
    // a medir a minha morfologia em vez do guarda. O que fica de fora fica
    // declarado, não esquecido.
    const diminutivo = (n) => {
      if (/inh[oa]$/.test(n)) return null;                 // já é diminutivo
      if (!/[bcdfgjlmnprstvxzç][oa]$/.test(n)) return null;  // hiato, nasal, consoante
      const raiz = n.slice(0, -1).replace(/c$/, 'qu').replace(/g$/, 'gu').replace(/ç$/, 'c');
      return raiz + (n.endsWith('a') ? 'inha' : 'inho');
    };
    const NAO_MECANICO = G._diminutivo_nao_mecanico || {};
    const fura = [];
    for (const [n, g] of DINHEIRO) {
      const d = diminutivo(n);
      if (d === null || FORA[n] || NAO_MECANICO[n]) continue;
      const t = QUADROS[0](d, ARTIGO[g]);
      if (!acusa(t)) fura.push(`${n} → ${d}: ${JSON.stringify(t)}`);
    }
    expect(fura).toEqual([]);
    // A gaveta do que a regra conservadora ainda derivaria errado: motivo
    // escrito, e ela não pode guardar um nome que a regra nem alcança.
    for (const [n, porque] of Object.entries(NAO_MECANICO)) {
      expect(`${n}: ${porque}`).toMatch(/.{80,}/);
      expect(diminutivo(n)).not.toBeNull();
    }
  });
});
