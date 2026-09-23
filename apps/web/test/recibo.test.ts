import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reciboVista } from '../src/recibo.ts';

test('mesma conta: progresso, e "pagar mais" só se ainda falta', () => {
  assert.deepEqual(reciboVista('c1', 'c1', 5000), { mostrarProgresso: true, oferecerMais: true, contaTrocou: false });
  assert.deepEqual(reciboVista('c1', 'c1', 0), { mostrarProgresso: true, oferecerMais: false, contaTrocou: false });
});

test('A CONTA TROCOU: nada de progresso alheio, nada de "pagar mais"', () => {
  // O caso que importa. Numa casa de verdade, `c2` é a conta da PRÓXIMA mesa no
  // mesmo QR — e `falta` é o que os OUTROS devem, com R$ 237,10 inteiros.
  // Oferecer "pagar mais" aqui era um toque até um Pix real pela comida dos
  // outros.
  assert.deepEqual(reciboVista('c1', 'c2', 23710), { mostrarProgresso: false, oferecerMais: false, contaTrocou: true });
});

test('antes de gravar a conta paga, o comportamento é o de sempre', () => {
  // O primeiro render depois do pagamento ainda não gravou a conta: não pode
  // esconder nada nem congelar — a conta é, por definição, a mesma.
  assert.deepEqual(reciboVista(null, 'c1', 5000), { mostrarProgresso: true, oferecerMais: true, contaTrocou: false });
});

test('conta viva ausente (404 no poll) não é "trocou"', () => {
  // O `catch` do poll mantém a view antiga; se algum dia ele passar a limpar,
  // ausência não pode virar troca — senão um 404 passageiro congelaria o recibo.
  assert.deepEqual(reciboVista('c1', null, 5000), { mostrarProgresso: true, oferecerMais: true, contaTrocou: false });
});
