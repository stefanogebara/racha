'use strict';

/**
 * O CENSO das espécies de evento.
 *
 * As duas revisões de 2026-09-08 apontaram a mesma coisa por caminhos
 * diferentes: o portão do webhook endurecia a espécie inofensiva (`ignored`) e
 * deixava as perigosas passando pro aplicador, onde tudo que não é `refund` é
 * tratado como PAGAMENTO. Uma notificação de chargeback viraria
 * PAYMENT_CONFIRMED, a conta viraria `paga` e a mesa fecharia em cima dele.
 *
 * Um teste por caso pega o caso. Este pega a PRÓXIMA espécie que alguém
 * inventar: ele varre os adaptadores procurando `kind: '…'` e exige que cada
 * uma esteja classificada. Foi o que faltou quando eu acrescentei
 * `unusable_money_event` — ela não estava em conjunto nenhum, e sem este teste
 * teria caído no aplicador e virado um pagamento.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  createWebhookHandler, LEDGER_KINDS, NON_LEDGER_KINDS,
} = require('../_lib/pay/webhook-handler');

const ADAPTERS = ['mock-psp.js', 'pagarme-psp.js', 'stripe-psp.js'];

function kindsEmitidos() {
  const found = new Map();
  for (const file of ADAPTERS) {
    const src = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', file), 'utf8');
    for (const m of src.matchAll(/\bkind:\s*'([a-z_]+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push(file);
    }
    // `kind: cond ? 'a' : 'b'` — o ternário do refund/refund_failed.
    for (const m of src.matchAll(/\bkind:\s*[^,\n]*\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g)) {
      for (const k of [m[1], m[2]]) {
        if (!found.has(k)) found.set(k, []);
        found.get(k).push(file);
      }
    }
  }
  return found;
}

describe('censo das espécies de evento de webhook', () => {
  test('toda espécie que um adaptador emite está classificada', () => {
    const classificadas = new Set([...LEDGER_KINDS, ...NON_LEDGER_KINDS, 'ignored']);
    const emitidas = kindsEmitidos();
    const orfas = [...emitidas.keys()].filter((k) => !classificadas.has(k)).sort();
    expect(orfas).toEqual([]);
    // E o censo não pode estar vazio por um regex que parou de casar — se
    // isso acontecer, o teste passa sem olhar nada.
    expect(emitidas.size).toBeGreaterThanOrEqual(4);
    expect([...emitidas.keys()]).toContain('payment_confirmed');
    expect([...emitidas.keys()]).toContain('refund');
  });

  test('toda espécie do razão tem um tipo de evento, e o razão conhece o tipo', () => {
    const { EVENT_FOR_KIND } = require('../_lib/pay/webhook-handler');
    const { EVENT_TYPES } = require('../_lib/checks/check-state');
    expect(new Set(Object.keys(EVENT_FOR_KIND))).toEqual(LEDGER_KINDS);
    for (const [kind, tipo] of Object.entries(EVENT_FOR_KIND)) {
      // O mapa substituiu o ternário `kind === 'refund' ? … : PAYMENT_CONFIRMED`,
      // cujo `else` fazia qualquer espécie desconhecida virar PAGAMENTO.
      expect(EVENT_TYPES).toContain(tipo);
      expect(typeof kind).toBe('string');
    }
  });

  test('as duas listas são DISJUNTAS — nada move e não move o razão ao mesmo tempo', () => {
    for (const k of LEDGER_KINDS) expect(NON_LEDGER_KINDS.has(k)).toBe(false);
    expect(LEDGER_KINDS.has('ignored')).toBe(false);
    expect(NON_LEDGER_KINDS.has('ignored')).toBe(false);
  });

  test('cada espécie tem o desfecho certo no portão, e desconhecida ESTOURA', async () => {
    const aplicou = [];
    const handleWith = (parsed) => createWebhookHandler({
      psp: { async verifyAndParseWebhook() { return parsed; } },
      loadEvents: async () => [],
      appendEvent: async () => 1,
      findCheckByTxid: async (txid) => { aplicou.push(txid); return null; },
      fallback: async () => null,
    })('corpo', 'assinatura');

    // Ignorado: 200 barato, sem tocar no razão.
    expect(await handleWith({ kind: 'ignored', type: 'charge.updated' }))
      .toEqual({ status: 'ignored', type: 'charge.updated' });

    // Evento de dinheiro sem lançamento: para no portão, e diz qual é.
    for (const kind of NON_LEDGER_KINDS) {
      const r = await handleWith({ kind, txid: 'pi_x', amountCents: 3390 });
      expect(r.status).toBe(kind);
      expect(r.txid).toBe('pi_x');
    }
    // NENHUM deles chegou ao aplicador — é o ponto todo.
    expect(aplicou).toEqual([]);

    // Os do razão chegam. Aqui o txid é desconhecido, então é recusa alta,
    // que é o comportamento certo pra um txid que não emitimos.
    for (const kind of LEDGER_KINDS) {
      const r = await handleWith({ kind, txid: 'pi_y', amountCents: 3390, tipCents: 0 });
      expect(r.status).toBe('rejected');
    }
    // Uma entrada por espécie do razão — contagem derivada da lista, não
    // escrita à mão: `refund_failed` mudou de lado quando ganhou evento
    // próprio, e um número fixo aqui só teria dado trabalho.
    expect(aplicou).toEqual(new Array(LEDGER_KINDS.size).fill('pi_y'));

    // Espécie desconhecida não é ignorada nem aplicada: estoura.
    await expect(handleWith({ kind: 'especie_nova', txid: 'pi_z' }))
      .rejects.toThrow(/kind desconhecido/);
    await expect(handleWith({ txid: 'pi_z' })).rejects.toThrow(/sem `kind`/);
  });
});
