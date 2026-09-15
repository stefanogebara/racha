import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refDoPagamento } from '../src/pagamento-ref.ts';

// O ✓ do telefone esperava o total da MESA subir — qualquer pagamento servia
// (auditoria de fluxo, CRITICAL-1). Agora espera a marca da PRÓPRIA cobrança.

test('a marca do telefone é a MESMA do servidor (sha256 do txid, doze hex)', async () => {
  for (const txid of ['ch_abc123', 'pi_3NzQ', 'tx-éü-7']) {
    assert.equal(await refDoPagamento(txid), createHash('sha256').update(txid).digest('hex').slice(0, 12));
  }
  assert.equal(await refDoPagamento(''), null);
});

test('o ✓ espera a MINHA cobrança cair — não o total da mesa subir', () => {
  const app = readFileSync(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(app, /\.some\(\(p\) => p\.ref === ownRef\)/);
  assert.doesNotMatch(app, /paidCents > paidBaseline/);
  assert.match(app, /refDoPagamento\(result\.txid\)\.then\(setOwnRef\)/);
});
