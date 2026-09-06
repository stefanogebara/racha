/**
 * Parity + closure tests for the diner's split math.
 *
 * Run by `node --test` (Node 22 strips the types natively — no build step, no
 * new dependency), wired into `npm test` at the repo root.
 *
 * Why this file exists: split.ts is a SECOND implementation of money math that
 * already lives in api/_lib/checks/split-engine.js, and its own header promises
 * the two "agree to the centavo". Nothing checked that promise, and the diner
 * flow shipped for weeks dividing what was LEFT instead of the total — R$200
 * entre 4 collected R$136,73. A second implementation without a parity test is
 * just a divergence with a comment on it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { splitEqualLocal, shareBaseCents, servicoCents, computeShare } from '../src/split.ts';

const require = createRequire(import.meta.url);
const engine = require('../../../api/_lib/checks/split-engine.js');

/** Deterministic LCG — a seeded generator so a failure is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('splitEqualLocal(t, n, i) === splitEqual(t, n)[i] for every position', () => {
  const rnd = lcg(20260905);
  for (let k = 0; k < 4000; k++) {
    const total = Math.floor(rnd() * 5_000_00);
    const n = 1 + Math.floor(rnd() * 20);
    const parts = engine.splitEqual(total, n);
    for (let i = 0; i < n; i++) {
      assert.equal(splitEqualLocal(total, n, i), parts[i], `t=${total} n=${n} i=${i}`);
    }
  }
});

test('servicoCents matches the backend to the centavo', () => {
  const rnd = lcg(7);
  for (let k = 0; k < 4000; k++) {
    const base = Math.floor(rnd() * 2_000_00);
    const bp = Math.floor(rnd() * 3001);
    assert.equal(servicoCents(base, bp), engine.servicoCents(base, bp), `base=${base} bp=${bp}`);
  }
});

test('servicoCents is 0 when the diner unticks it (CDC: o serviço é removível)', () => {
  const s = computeShare({
    mode: 'igual', totalCents: 10_000, remaining: 10_000, people: 2,
    customCents: null, selectedCents: 0, servicoOn: false, servicoBp: 1000,
  });
  assert.equal(s.servico, 0);
  assert.equal(s.total, s.base);
});

/**
 * The one that matters: N people tapping "igual" one after another must close
 * the check EXACTLY — no centavo left, no centavo over. This is the property
 * the shipped code violated.
 */
test('N pagantes em "igual" fecham a conta exatamente', () => {
  const rnd = lcg(31337);
  for (let k = 0; k < 3000; k++) {
    const totalCents = 1 + Math.floor(rnd() * 1_000_00);
    const people = 1 + Math.floor(rnd() * 12);
    let paid = 0;
    const charged: number[] = [];
    for (let i = 0; i < people; i++) {
      const share = computeShare({
        mode: 'igual', totalCents, remaining: totalCents - paid, people,
        customCents: null, selectedCents: 0, servicoOn: false, servicoBp: 1000,
      });
      charged.push(share.base);
      paid += share.base;
    }
    const ceil = Math.ceil(totalCents / people);
    assert.equal(paid, totalCents, `total=${totalCents} people=${people} → ${charged.join(',')}`);
    assert.ok(charged.every((c) => c >= 0), 'nenhuma parte negativa');
    // Ninguém paga mais do que o número que a tela prometeu.
    assert.ok(charged.every((c) => c <= ceil), `cobrança acima do exibido: ${charged.join(',')}`);
    // E o desconto que sobra pro último é sempre menor que 1 centavo por pessoa
    // (< R$0,20 numa mesa de 20) — o preço de cada telefone calcular sozinho.
    assert.ok(ceil - Math.min(...charged) < people, `desvio grande demais: ${charged.join(',')}`);
  }
});

test('a divisão igual não encolhe conforme a conta é paga', () => {
  // R$200 entre 4: todo mundo vê R$50, inclusive quem abre o link por último.
  for (const paid of [0, 5_000, 10_000, 15_000]) {
    const s = computeShare({
      mode: 'igual', totalCents: 20_000, remaining: 20_000 - paid, people: 4,
      customCents: null, selectedCents: 0, servicoOn: false, servicoBp: 1000,
    });
    assert.equal(s.base, 5_000, `com ${paid} já pago`);
  }
});

test('o último pagante é limitado ao que falta, e isso é sinalizado', () => {
  const s = computeShare({
    mode: 'igual', totalCents: 20_000, remaining: 3_000, people: 4,
    customCents: null, selectedCents: 0, servicoOn: false, servicoBp: 1000,
  });
  assert.equal(s.base, 3_000);
  assert.equal(s.capped, true, 'a UI precisa explicar o número ajustado');
});

test('serviço é proporcional: quem come mais paga mais serviço', () => {
  const big = computeShare({
    mode: 'valor', totalCents: 10_000, remaining: 10_000, people: 2,
    customCents: 8_000, selectedCents: 0, servicoOn: true, servicoBp: 1000,
  });
  const small = computeShare({
    mode: 'valor', totalCents: 10_000, remaining: 10_000, people: 2,
    customCents: 2_000, selectedCents: 0, servicoOn: true, servicoBp: 1000,
  });
  assert.equal(big.servico, 800);
  assert.equal(small.servico, 200);
  assert.equal(big.servico + small.servico, engine.servicoCents(10_000, 1000));
});

test('modo item: a base é a soma exata do que foi tocado', () => {
  const base = shareBaseCents({
    mode: 'item', totalCents: 10_000, remaining: 10_000, people: 4,
    customCents: null, selectedCents: 4_237,
  });
  assert.equal(base, 4_237);
});

test('valor inválido (null) desarma o CTA em vez de virar 0 silencioso na cobrança', () => {
  const s = computeShare({
    mode: 'valor', totalCents: 10_000, remaining: 10_000, people: 2,
    customCents: null, selectedCents: 0, servicoOn: true, servicoBp: 1000,
  });
  assert.equal(s.total, 0); // App.tsx: disabled={totalToPay === 0}
});

test('conta já quitada: nada a pagar em nenhum modo', () => {
  for (const mode of ['igual', 'item', 'valor'] as const) {
    const s = computeShare({
      mode, totalCents: 10_000, remaining: 0, people: 3,
      customCents: 5_000, selectedCents: 5_000, servicoOn: true, servicoBp: 1000,
    });
    assert.equal(s.total, 0, mode);
  }
});
