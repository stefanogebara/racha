import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretDepoisDaMascara } from '../src/mascara-caret.ts';
import { maskCpfCnpj } from '../src/br.ts';

/**
 * O CURSOR DEPOIS QUE A MÁSCARA REESCREVE O CAMPO.
 *
 * Medido no navegador, com teclas de verdade, antes de existir este arquivo:
 * campo do CPF com `529.982.247-25`, cursor na posição 3, um Backspace. O valor
 * saía certo — `529.822.472-5` — e o cursor ia pra **13**, o fim. A tecla
 * seguinte caía no lugar errado, e a seguinte também: corrigir um dígito do
 * meio era impossível sem apagar tudo.
 *
 * Os casos abaixo são o que a pessoa FAZ, não posições abstratas: cada um diz a
 * tecla e o lugar.
 */

/** O que o navegador entrega ao `onChange`: o texto já editado e onde o cursor está. */
const digitar = (mascarado: string, pos: number, tecla: string) =>
  ({ editado: mascarado.slice(0, pos) + tecla + mascarado.slice(pos), pos: pos + tecla.length });
const apagar = (mascarado: string, pos: number) =>
  ({ editado: mascarado.slice(0, pos - 1) + mascarado.slice(pos), pos: pos - 1 });

const onde = (e: { editado: string; pos: number }) =>
  caretDepoisDaMascara(e.editado, e.pos, maskCpfCnpj(e.editado));

test('o caso medido: Backspace no meio do CPF não joga o cursor pro fim', () => {
  const e = apagar('529.982.247-25', 3);            // apaga o terceiro dígito
  assert.equal(maskCpfCnpj(e.editado), '529.822.472-5');
  assert.equal(onde(e), 2, 'o cursor tem que ficar onde o dígito estava, não no fim');
});

test('e a tecla seguinte cai no lugar certo — que é o que torna a correção possível', () => {
  const e = digitar('529.822.472-5', 2, '7');
  assert.equal(maskCpfCnpj(e.editado), '527.982.247-25');
  assert.equal(onde(e), 3);
});

test('digitar no fim continua no fim', () => {
  const e = digitar('529.98', 6, '2');
  assert.equal(maskCpfCnpj(e.editado), '529.982');
  assert.equal(onde(e), 7);
});

test('o dígito que ABRE um grupo pula a pontuação que a máscara acabou de pôr', () => {
  // `529` + `9` → `529.9`: o cursor vai DEPOIS do 9, não entre o ponto e o 9.
  const e = digitar('529', 3, '9');
  assert.equal(maskCpfCnpj(e.editado), '529.9');
  assert.equal(onde(e), 5);
});

test('apagar um SEPARADOR não come o dígito vizinho — gasta um Backspace e pára', () => {
  // A pessoa apaga o ponto de `529.982`. A máscara repõe o ponto e o cursor
  // volta pro mesmo lugar: o próximo Backspace apaga o 9. É o comportamento de
  // todo campo mascarado que se comporta; a alternativa (comer o dígito sem a
  // pessoa pedir) é pior.
  const e = apagar('529.982', 4);
  assert.equal(maskCpfCnpj(e.editado), '529.982');
  assert.equal(onde(e), 3);
});

test('cursor no começo fica no começo', () => {
  const e = digitar('29.982.247-25', 0, '5');
  assert.equal(onde(e), 1);
  assert.equal(caretDepoisDaMascara('', 0, ''), 0);
});

test('colar o número inteiro deixa o cursor no fim', () => {
  const e = digitar('', 0, '52998224725');
  assert.equal(maskCpfCnpj(e.editado), '529.982.247-25');
  assert.equal(onde(e), 14);
});

/**
 * CONTAR POSIÇÕES EM VEZ DE ALFANUMÉRICOS é o erro que esta conta existe pra
 * não cometer, e ele só aparece quando a máscara muda de TAMANHO. Este caso
 * separa as duas regras: sem ele, "devolva a posição que já estava" passaria em
 * quase tudo acima.
 */
test('a conta é por DÍGITO, não por posição — a máscara encolhe e o cursor acompanha', () => {
  const e = apagar('529.982.247-25', 13);        // apaga o penúltimo dígito
  assert.equal(maskCpfCnpj(e.editado), '529.982.247-5');
  assert.equal(e.pos, 12, 'a posição CRUA depois do Backspace');
  // A regra ingênua devolveria 12. A certa devolve 11: o cursor fica logo
  // depois do nono dígito, que é o último que a pessoa tinha à esquerda.
  assert.equal(onde(e), 11);
  // E a prova de que 11 é o lugar CERTO e não só um número diferente: a tecla
  // seguinte cai onde a pessoa está olhando.
  const depois = digitar('529.982.247-5', 11, '3');
  assert.equal(maskCpfCnpj(depois.editado), '529.982.247-35');
  assert.equal(onde(depois), 13);
});

test('apagar o hífen devolve o hífen, e o cursor não anda', () => {
  const e = apagar('529.982.247-25', 12);
  assert.equal(maskCpfCnpj(e.editado), '529.982.247-25', 'a máscara repõe a pontuação');
  assert.equal(onde(e), 11);
});

test('o NIF espanhol, que tem letra, conta a letra como conteúdo', () => {
  const e = digitar('X1234567', 8, 'L');
  const m = maskCpfCnpj(e.editado);
  assert.equal(m, 'X1.234.567/L');
  assert.equal(onde(e), 12, 'no fim: os nove caracteres que valem estão todos à esquerda');
  assert.equal([...m.slice(0, onde(e))].filter((c) => /[0-9A-Za-z]/.test(c)).length, 9);
});
