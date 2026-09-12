'use strict';

/**
 * O que a Racha MANDA tem que ser o que a ponte ACEITA.
 *
 * Em 2026-09-12 a revisão de segurança leu o receptor — coisa que três rodadas
 * anteriores não fizeram, porque todas endureceram o TRANSPORTE deste lado (o
 * `AbortSignal.timeout`, os fallbacks pra stderr) sem nunca perguntar se o
 * outro lado aceita o corpo. O receptor roteia `activation_radar` e depois
 * exige um campo `status` que a Racha não manda em evento nenhum de fundador.
 * Resultado: todo `reconcile_drift`, todo `reconcile_heartbeat` e todo evento
 * de dinheiro voltavam 400.
 *
 * A batida noturna, cujo contrato declarado é "a ausência dela é o alarme",
 * nunca chegou uma vez — então o contrato estava satisfeito de forma vazia.
 *
 * Este teste é o censo que faltava nos dois repositórios: a lista de eventos
 * que a Racha emite, contra a lista que a ponte aceita. A lista da ponte vive
 * aqui como FIXTURE porque os dois lados deployam separado — e é por isso que
 * ela precisa ser conferida à mão quando a ponte mudar. O que o teste garante é
 * que nenhum evento NOVO nasça do lado de cá sem alguém olhar o outro lado.
 */

const fs = require('node:fs');
const path = require('node:path');

const NOTIFY = fs.readFileSync(path.join(__dirname, '..', '_lib', 'notify.js'), 'utf8');
const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

/**
 * O que `restaurant-ai-mcp/api/racha-notify.js` aceita hoje.
 *
 * `activation_radar` é roteado explicitamente. Tudo o mais cai na exigência de
 * `status`, que só o aviso de recebedor manda — daí ele estar aqui também.
 * QUALQUER outro evento volta 400.
 */
const A_PONTE_ACEITA = new Set([
  'activation_radar',
  'recipient_status',
  // Acrescentados na ponte em 2026-09-12, quando este censo mostrou que todos
  // voltavam 400. A lista do outro lado é `EVENTOS_DE_FUNDADOR`, em
  // `restaurant-ai-mcp/api/racha-notify.js`, e é nominal pelo mesmo motivo:
  // evento novo tem que passar por uma decisão sobre como é entregue.
  'reconcile_drift', 'reconcile_heartbeat',
  'retention_ok', 'retention_blocked', 'retention_late',
  'overpaid_pending_restitution', 'money_event_unrecorded',
  'dispute_close_unrecorded', 'dispute_evidence_due', 'dispute_evidence_overdue',
]);

describe('a ponte de avisos aceita o que a Racha manda', () => {
  test('todo `kind` de evento de dinheiro está na lista da ponte', () => {
    // Os `kind:` que o router passa pro `notifyFounderMoneyEvent`.
    const kinds = [...ROUTER.matchAll(/notifyFounderMoneyEvent\(\{\s*\n?\s*kind: '([a-z_]+)'/g)]
      .map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    const recusados = [...new Set(kinds)].filter((k) => !A_PONTE_ACEITA.has(k)).sort();
    expect(recusados).toEqual([]);
  });

  test('os eventos da conciliação estão na lista da ponte', () => {
    const eventos = [...NOTIFY.matchAll(/event: heartbeat \? '([a-z_]+)' : '([a-z_]+)'/g)]
      .flatMap((m) => [m[1], m[2]]);
    expect(eventos.length).toBeGreaterThan(0);
    const recusados = eventos.filter((e) => !A_PONTE_ACEITA.has(e)).sort();
    expect(recusados).toEqual([]);
  });

  test('uma entrega recusada nunca passa por silêncio — nem a batida', () => {
    // A batida recusada não escrevia nada, e é o sinal cujo contrato inteiro é
    // "a ausência é o alarme".
    const trecho = NOTIFY.slice(NOTIFY.indexOf('async function notifyFounderReconcile'));
    const corpo = trecho.slice(0, trecho.indexOf('async function notifyFounderMoneyEvent'));
    expect(corpo).toMatch(/if \(!res\.ok\) \{/);
    expect(corpo).not.toMatch(/if \(!res\.ok && !heartbeat\)/);
  });
});
