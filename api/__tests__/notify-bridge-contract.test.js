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

const { KINDS_DE_FUNDADOR } = require('../_lib/notify');

const NOTIFY = fs.readFileSync(path.join(__dirname, '..', '_lib', 'notify.js'), 'utf8');
const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

/**
 * O que `restaurant-ai-mcp/api/racha-notify.js` aceita hoje.
 *
 * FIXTURE à mão porque os dois lados deployam separado — e por isso ela precisa
 * ser conferida quando a ponte mudar. O que o teste garante é que nenhum evento
 * novo nasça deste lado sem alguém olhar o outro.
 */
const A_PONTE_ACEITA = new Set([
  'activation_radar',
  'recipient_status',
  'reconcile_drift', 'reconcile_heartbeat',
  'dispute_opened', 'dispute_updated', 'dispute_funds', 'dispute_lost',
  'account_alert', 'unusable_money_event', 'refund_failed',
  'retention_ok', 'retention_blocked', 'retention_late',
]);

describe('a ponte de avisos aceita o que a Racha manda', () => {
  test('todo kind de fundador está na lista da ponte — comparação de CONJUNTOS', () => {
    // A primeira versão disto era uma regex procurando
    // `notifyFounderMoneyEvent({ kind: '<literal>'` no router: primeira chave,
    // literal, logo depois da chave. Três dos seis call sites passam
    // `kind: parsed.kind` — os TRÊS de disputa e estorno — e sumiam. O censo
    // media a FORMA DA CHAMADA, não o conjunto de eventos emitidos, e por isso
    // certificou como coberto justamente o que voltava 400.
    //
    // Agora a lista é exportada pelo remetente e o teste compara conjuntos.
    expect(KINDS_DE_FUNDADOR.size).toBeGreaterThan(0);
    const recusados = [...KINDS_DE_FUNDADOR].filter((k) => !A_PONTE_ACEITA.has(k)).sort();
    expect(recusados).toEqual([]);
  });

  test('todo kind que os adaptadores produzem foi CLASSIFICADO', () => {
    // A direção que faltava. A comparação de subconjunto acima não vê uma
    // REMOÇÃO: tirar `dispute_opened` da lista mantém o subconjunto e passa
    // verde, enquanto o webhook passa a estourar em produção.
    //
    // Aqui a fonte é o que os adaptadores de PSP realmente normalizam. Todo
    // `kind` que eles produzem tem que estar num dos dois lados: vai pro
    // fundador, ou está nomeado aqui como coisa que não vai. Um adaptador que
    // invente um evento novo reprova até alguém decidir de que lado ele fica.
    const dir = path.join(__dirname, '..', '_lib', 'pay');
    const kinds = new Set();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const texto = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of texto.matchAll(/kind: '([a-z_]+)'/g)) kinds.add(m[1]);
      // A forma ternária: `kind: x ? 'refund_failed' : 'refund_progress'`.
      for (const m of texto.matchAll(/kind: [^,\n]*\? '([a-z_]+)' : '([a-z_]+)'/g)) {
        kinds.add(m[1]); kinds.add(m[2]);
      }
    }
    expect(kinds.size).toBeGreaterThan(5);

    // Os que NÃO viram aviso de fundador, um a um, com o motivo.
    const NAO_AVISAM = new Map([
      ['payment_confirmed', 'caminho feliz: vira evento de razão, não alerta'],
      ['payment_failed', 'o cliente vê na tela; não acorda ninguém'],
      ['refund', 'estorno normal, gravado no razão'],
      ['refund_progress', 'estado intermediário — o router exclui explicitamente'],
      ['dispute_won', 'desfecho bom: entra no razão, não alerta'],
      ['ignored', 'evento do PSP que não nos diz respeito'],
    ]);

    const semClassificacao = [...kinds]
      .filter((k) => !KINDS_DE_FUNDADOR.has(k) && !NAO_AVISAM.has(k))
      .sort();
    expect(semClassificacao).toEqual([]);
  });

  test('a lista da ponte não tem nome que não seja evento', () => {
    // O outro lado do mesmo erro: a lista tinha `dispute_evidence_due`,
    // `money_event_unrecorded` e três irmãos — códigos de achado da conciliação
    // e de erro HTTP, que só PARECEM nome de evento. Deixá-los lá faz o
    // próximo leitor acreditar que disputa está coberta.
    const naoSaoEventos = ['overpaid_pending_restitution', 'money_event_unrecorded',
      'dispute_close_unrecorded', 'dispute_evidence_due', 'dispute_evidence_overdue'];
    const intrusos = naoSaoEventos.filter((n) => A_PONTE_ACEITA.has(n));
    expect(intrusos).toEqual([]);
  });

  test('todo call site passa um kind que a lista conhece', () => {
    // O remetente ESTOURA num kind desconhecido, então o caminho dinâmico
    // (`kind: parsed.kind`) falha alto em vez de sumir. Aqui se garante que o
    // caminho literal também não escapa: todo literal escrito no router tem que
    // estar na lista.
    const literais = [...ROUTER.matchAll(/notifyFounderMoneyEvent\(\{[\s\S]{0,120}?kind: '([a-z_]+)'/g)]
      .map((m) => m[1]);
    expect(literais.length).toBeGreaterThan(0);
    const forasDaLista = [...new Set(literais)].filter((k) => !KINDS_DE_FUNDADOR.has(k)).sort();
    expect(forasDaLista).toEqual([]);

    // E TODO call site foi contabilizado: se um deles passar o kind por
    // variável sem que o remetente valide, isto denuncia a diferença.
    const chamadas = (ROUTER.match(/notifyFounderMoneyEvent\(/g) || []).length;
    const dinamicos = (ROUTER.match(/kind: parsed\.kind/g) || []).length;
    expect(literais.length + dinamicos).toBe(chamadas);
  });

  test('os eventos da conciliação estão na lista da ponte', () => {
    const eventos = [...NOTIFY.matchAll(/event: heartbeat \? '([a-z_]+)' : '([a-z_]+)'/g)]
      .flatMap((m) => [m[1], m[2]]);
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos.filter((e) => !A_PONTE_ACEITA.has(e)).sort()).toEqual([]);
  });

  test('entrega recusada OU vazia nunca passa por silêncio — nem a batida', () => {
    // Duas coisas: a batida recusada não escrevia nada (`!res.ok && !heartbeat`),
    // e 200 com zero canais entregues era tratado como sucesso. A ponte captura
    // toda falha de canal numa string e devolve 200 — então `res.ok` sozinho
    // trocava "400 alto no log" por "200 calado", que é o pior dos dois.
    expect(NOTIFY).not.toMatch(/if \(!res\.ok && !heartbeat\)/);
    expect((NOTIFY.match(/const entregue = Boolean\(data && data\.data/g) || []).length).toBe(2);
    expect((NOTIFY.match(/if \(!res\.ok \|\| !entregue\)/g) || []).length).toBe(2);
  });

  test('um kind fora da lista ESTOURA no remetente', async () => {
    const { notifyFounderMoneyEvent } = require('../_lib/notify');
    await expect(notifyFounderMoneyEvent({ kind: 'inventado_agora' }))
      .rejects.toThrow(/kind desconhecido/);
  });
});
