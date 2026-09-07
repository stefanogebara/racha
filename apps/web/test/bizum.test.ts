/**
 * O status do Bizum, e por que a lista é de fracasso.
 *
 * Este teste existe por causa de uma chamada real: confirmar uma cobrança
 * Bizum no sandbox da Stripe devolve `requires_action` com
 * `next_action: await_authorization`. O código original esperava `processing` e
 * mostrava "pagamento não concluído" pra quem estava justamente autorizando no
 * app do banco. Nenhum teste pegaria — a suposição errada estava nos dois lados.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bizumOutcome } from '../src/bizumStatus.ts';

test('requires_action é ESPERA, não erro — é o que a API real devolve', () => {
  assert.equal(bizumOutcome('requires_action'), 'waiting');
});

test('processing e succeeded também são espera — quem fecha a conta é o webhook', () => {
  assert.equal(bizumOutcome('processing'), 'waiting');
  // Até `succeeded` é espera pra ESTA tela: ela não declara pago, o razão declara.
  assert.equal(bizumOutcome('succeeded'), 'waiting');
});

test('só recusa e cancelamento são fracasso', () => {
  assert.equal(bizumOutcome('requires_payment_method'), 'failed');
  assert.equal(bizumOutcome('canceled'), 'failed');
});

test('um status que a Stripe inventar amanhã cai em espera, não em erro', () => {
  // O lado seguro: o poll da conta corrige a tela em segundos, enquanto um erro
  // falso manda a pessoa pagar duas vezes.
  assert.equal(bizumOutcome('requires_capture'), 'waiting');
  assert.equal(bizumOutcome('some_future_status'), 'waiting');
});

test('sem status não há cobrança pra esperar', () => {
  assert.equal(bizumOutcome(null), 'failed');
  assert.equal(bizumOutcome(undefined), 'failed');
  assert.equal(bizumOutcome(''), 'failed');
});
