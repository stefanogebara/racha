import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A captura REAL de carteira chamava `/api/dev/confirm` depois de cobrar. O
// servidor só forja confirmação com o PSP de mentira, então era inócuo — mas a
// afordância de demo não tem lugar no caminho do dinheiro real (TASKS, MEDIUM).
const src = readFileSync(new URL('../src/WalletPay.tsx', import.meta.url), 'utf8');

test('WalletPay só chama devConfirm quando a cobrança é simulada', () => {
  const chamadas = src.match(/api\.devConfirm\(/g) || [];
  assert.equal(chamadas.length, 1);
  const i = src.indexOf('api.devConfirm(');
  const antes = src.slice(Math.max(0, i - 400), i);
  assert.match(antes, /if \(simulated\) \{\s*try \{\s*await $/);
});
