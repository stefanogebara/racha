'use strict';

/**
 * O que acontece com um evento de dinheiro que o razão NÃO sabe lançar.
 *
 * A espécie existe: cancelamento parcial ("saiu dinheiro e não sabemos
 * quanto"), disputa aberta, estorno que falhou, alerta de conta. O portão do
 * webhook devolve cada uma como status e deixa o tratamento pro chamador — e o
 * chamador do trilho que está em PRODUÇÃO não tratava nada. 200, sem registro,
 * sem aviso: a linha e o razão seguiam dizendo o valor cheio, a conciliação
 * comparava os dois entre si, concordava, e reportava VERDE por cima de
 * dinheiro que saiu da conta do restaurante.
 *
 * O censo de espécies (webhook-kinds) não pegava: ele prova que cada espécie
 * está CLASSIFICADA, nunca que alguém age sobre ela.
 */

const { createNonLedgerHandler } = require('../_lib/pay/non-ledger');
const { createMemoryStore } = require('../_lib/store/memory');
const { reduce } = require('../_lib/checks/check-state');

async function cenario() {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 'rcpt_x' });
  const table = await store.seedTable(venue.id, 'Mesa 7');
  const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Picanha', priceCents: 3000 }]);
  await store.registerCharge({
    checkId: check.id, txid: 'ch_1', amountCents: 3000, tipCents: 300,
    payerLabel: 'Ana', method: 'pix',
  });
  const avisos = [];
  const handle = createNonLedgerHandler({
    store,
    notify: async (a) => { avisos.push(a); return { ok: true }; },
  });
  return { store, check, handle, avisos };
}

describe('evento de dinheiro sem lançamento', () => {
  test('cancelamento parcial deixa a conta VERMELHA — não só uma linha de log', async () => {
    const { store, check, handle, avisos } = await cenario();
    const r = await handle({
      status: 'unusable_money_event', type: 'charge.refunded', txid: 'ch_1',
      raw: { status: 'partial_canceled', amountCents: 1000 },
    });

    expect(r).toEqual({
      persisted: true, notified: true, quieto: false, found: true, lookupFailed: false,
    });

    // O DURÁVEL é o que importa: o aviso degrada pra stderr sem
    // RACHA_NOTIFY_SECRET, a anomalia não degrada.
    const st = reduce(await store.loadEvents(check.id));
    expect(st.anomalies.length).toBe(1);
    expect(st.anomalies[0].txid).toBe('ch_1');
    expect(st.anomalies[0].severity).toBe('critical');
    expect(st.anomalies[0].reason).toMatch(/unusable_money_event/);

    expect(avisos[0]).toMatchObject({ kind: 'unusable_money_event', checkId: check.id });
    expect(avisos[0].detail).toMatch(/status=partial_canceled/);
  });

  test('txid que não é nosso vai pra tabela de ÓRFÃOS — e ainda avisa', async () => {
    // 503 aqui seria pedir reenvio de um evento que não tem pra onde
    // convergir: nenhum estado pode mudar. Sem `RACHA_NOTIFY_SECRET` isso é
    // 503 em laço até o endpoint ser desabilitado — o que derruba TODA
    // confirmação de Pix. O evento vira linha na `orphan_money_events`.
    const { store, handle, avisos } = await cenario();
    const r = await handle({
      status: 'account_alert', type: 'payout.failed', txid: 'po_x',
      raw: { eventId: 'evt_o1', amountCents: 4200 },
    });
    expect(r.found).toBe(false);
    expect(r.persisted).toBe(true);       // guardado, em outro lugar
    expect(r.notified).toBe(true);
    expect(avisos[0].checkId).toBe(null);

    const orfaos = await store.listOrphanMoneyEvents();
    expect(orfaos).toHaveLength(1);
    expect(orfaos[0]).toMatchObject({ kind: 'account_alert', txid: 'po_x', amountCents: 4200 });

    // Reentrega do MESMO evento não duplica a linha.
    await handle({
      status: 'account_alert', type: 'payout.failed', txid: 'po_x',
      raw: { eventId: 'evt_o1', amountCents: 4200 },
    });
    expect(await store.listOrphanMoneyEvents()).toHaveLength(1);
  });

  test('estorno EM PROGRESSO não marca nem avisa — ele ainda vai terminar', async () => {
    const { store, check, handle, avisos } = await cenario();
    const r = await handle({ status: 'refund_progress', txid: 'ch_1' });
    expect(r).toEqual({
      persisted: false, notified: false, quieto: true, found: true, lookupFailed: false,
    });
    expect(avisos).toEqual([]);
    expect(reduce(await store.loadEvents(check.id)).anomalies).toEqual([]);
  });

  test('gravar a anomalia carrega o evento do PSP — reentrega não duplica a marca', async () => {
    const { store, check, handle } = await cenario();
    const evento = {
      status: 'unusable_money_event', type: 'charge.refunded', txid: 'ch_1',
      raw: { eventId: 'evt_1', status: 'partial_canceled' },
    };
    await handle(evento);
    await handle({ ...evento });
    expect(reduce(await store.loadEvents(check.id)).anomalies.length).toBe(1);
  });

  test('falha ao gravar AINDA avisa — e a rota tem que pedir reenvio', async () => {
    // Este teste dizia, em comentário, "→ a rota devolve 200, o evento não
    // sumiu". Sumiu: o aviso degrada pra stderr sem `RACHA_NOTIFY_SECRET`, a
    // marca durável é a que faz a conciliação ficar vermelha, e uma falha de
    // gravação (um CHECK recusando o tipo, uma permissão) é PERSISTENTE — todo
    // cancelamento parcial sairia 200 com o dinheiro fora da conta.
    //
    // O aviso continua saindo: os dois caminhos são independentes. O que mudou
    // é quem decide o 503 — `found` diz que HAVIA onde gravar.
    const { store } = await cenario();
    const avisos = [];
    const handle = createNonLedgerHandler({
      store,
      notify: async (a) => { avisos.push(a); return { ok: true }; },
      append: async () => { throw new Error('supabase 503'); },
    });
    const r = await handle({ status: 'unusable_money_event', txid: 'ch_1' });
    expect(r.persisted).toBe(false);
    expect(r.notified).toBe(true);
    expect(r.found).toBe(true);      // → a rota devolve 503 e o PSP reenvia
  });
});

describe('a ROTA do Pix trata a espécie inteira, não uma lista escrita à mão', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  /** O bloco da rota, do marcador até o começo da PRÓXIMA rota — e não uma
   *  janela de N caracteres, que envelhece junto com o arquivo. */
  const trecho = (marcador) => {
    const i = src.indexOf(marcador);
    expect(i).toBeGreaterThan(0);
    const fim = src.indexOf("url.pathname === '/api/webhooks/stripe'", i);
    return src.slice(i, fim > i ? fim : undefined);
  };

  test('/api/webhooks/psp chama o tratador e devolve 503 quando nada foi feito', () => {
    const rota = trecho("url.pathname === '/api/webhooks/psp'");
    // O conjunto, não uma enumeração: a próxima espécie inventada já entra.
    expect(rota).toMatch(/NON_LEDGER_KINDS\.has\(result\.status\)/);
    expect(rota).toMatch(/handleNonLedgerMoneyEvent\(result, \{ psp: 'pagarme' \}\)/);
    expect(rota).toMatch(/money_event_unrecorded/);
  });

  test('a resposta não ecoa o corpo cru do PSP', () => {
    // `raw` traz documento do pagador e payload do Pix. Só o Basic Auth vê a
    // resposta, mas o subconjunto mascarado é o que se devolve.
    const rota = trecho("url.pathname === '/api/webhooks/psp'");
    const eco = rota.match(/status: result\.status, type: result\.type[^}]*\}/);
    expect(eco).not.toBeNull();
    expect(eco[0]).not.toMatch(/\braw\b/);
  });
});

describe('a leitura PÚBLICA da conta é uma lista branca', () => {
  /**
   * `/api/check` é aberto: quem tem o QR da mesa lê. O token viaja em link
   * compartilhado e em foto de QR, e não gira sozinho. A rota devolvia o
   * estado reduzido INTEIRO — com motivo de disputa vindo do esquema, prazo de
   * prova, e a nota de texto livre que o dono escreve pra encerrar uma
   * pendência ("reembolsei o Pedro no Pix 11 98765-4321": dado pessoal de um
   * terceiro, servido a todo mundo que sentar na mesa depois).
   * LGPD art. 6º III. Achado pela revisão de segurança de 2026-09-08.
   */
  const { publicCheckState } = require('../_lib/checks/public-state');

  const estadoCheio = {
    status: 'parcial', totalCents: 6000, paidCents: 3000, tipCents: 300, overpaidCents: 0,
    payments: {
      pi_1: {
        amountCents: 3000, tipCents: 300, refundedAmountCents: 0, refundedTipCents: 0,
        late: false,
        disputeStatus: 'needs_response', disputeDueBy: '2026-10-18T00:00:00Z',
        disputedAmountCents: 3000,
      },
    },
    anomalies: [
      { seq: 4, type: 'PAYMENT_DISPUTED', severity: 'critical',
        reason: 'disputa aberta em pi_1 (fraudulent) — prova até 2026-10-18' },
      { seq: 6, type: 'PAYMENT_ISSUE_RESOLVED', severity: 'info',
        reason: 'pendência de pi_1 resolvida: reembolsei o Pedro no Pix 11 98765-4321' },
    ],
  };

  test('nada do vocabulário da disputa atravessa, nem o texto das anomalias', () => {
    const publico = publicCheckState(estadoCheio);
    const json = JSON.stringify(publico);
    for (const vazamento of ['fraudulent', '2026-10-18', 'Pedro', '98765-4321',
      'disputeStatus', 'disputeDueBy', 'disputedAmountCents', 'reason',
      'pi_1']) {   // nem o id da cobrança no adquirente
      expect(json).not.toContain(vazamento);
    }
    expect(publico.anomalies).toBe(2);   // a contagem, não o texto
  });

  test('o que a mesa precisa continua lá — a conta não fica ilegível', () => {
    const publico = publicCheckState(estadoCheio);
    expect(publico).toMatchObject({
      status: 'parcial', totalCents: 6000, paidCents: 3000, tipCents: 300, overpaidCents: 0,
    });
    // A chave é um ordinal da conta, não o id do adquirente.
    expect(Object.keys(publico.payments)).toEqual(['p1']);
    // `ref` entrou DE PROPÓSITO, e a lista branca continua branca: é o sha256 do
    // txid em doze hex — deixa o telefone reconhecer a PRÓPRIA cobrança sem
    // conhecer o id de ninguém (o ✓ confirmava o pagamento de outra pessoa da
    // mesa; auditoria de fluxo, CRITICAL-1). O teste de cima segue exigindo que
    // `pi_1` não apareça.
    expect(publico.payments.p1).toEqual({
      ref: require('node:crypto').createHash('sha256').update('pi_1').digest('hex').slice(0, 12),
      amountCents: 3000, tipCents: 300, refundedAmountCents: 0, refundedTipCents: 0, late: false,
    });
  });

  test('campo NOVO no redutor não vaza sozinho — a lista é branca', () => {
    const comCampoNovo = {
      ...estadoCheio,
      segredoDaCasa: 'o que for que alguém acrescente ao redutor amanhã',
      payments: { pi_1: { ...estadoCheio.payments.pi_1, notaInterna: 'cliente problemático' } },
    };
    const json = JSON.stringify(publicCheckState(comCampoNovo));
    expect(json).not.toContain('segredoDaCasa');
    expect(json).not.toContain('notaInterna');
  });

  test('a ROTA pública projeta — não é só o módulo que existe', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
    const i = src.indexOf("url.pathname === '/api/check'");
    expect(i).toBeGreaterThan(0);
    const rota = src.slice(i, src.indexOf("url.pathname === '/api/pay'", i));
    expect(rota).toMatch(/publicCheckState\(data\.state\)/);
  });
});

describe('avisos DO CLIENTE sobre o próprio dinheiro', () => {
  /**
   * Tirar o texto operacional do payload público fechou um vazamento. Mas duas
   * situações são do cliente que pagou, e ficar calado sobre elas é o outro
   * lado do mesmo problema (CDC art. 6º, III): o estorno que falhou — ele
   * continua credor e não sabe — e o dinheiro pago a mais, que a casa é
   * obrigada a restituir (CC art. 876) sem esperar ninguém reclamar.
   */
  const { publicCheckState } = require('../_lib/checks/public-state');

  test('pagou a mais: aviso com o código estável e os centavos', () => {
    const p = publicCheckState({
      status: 'paga', totalCents: 3390, paidCents: 4000, tipCents: 0, overpaidCents: 610,
      payments: {}, anomalies: [],
    });
    expect(p.notices).toEqual([{ code: 'overpaid_pending_restitution', amountCents: 610 }]);
  });

  test('estorno que falhou: o valor é o do ESTORNO, não o do pagamento', () => {
    // Um estorno de R$ 50 sobre um pagamento de R$ 100 que falha deixa o
    // cliente credor de R$ 50. O aviso derivava do saldo NÃO estornado — os
    // R$ 100 inteiros — e mandava a pessoa cobrar o dobro no caixa. Um número
    // errado é pior que nenhum.
    const p = publicCheckState({
      status: 'paga', totalCents: 10000, paidCents: 10000, tipCents: 0, overpaidCents: 0,
      payments: { pi_1: { amountCents: 10000, tipCents: 0, refundedAmountCents: 0, refundedTipCents: 0 } },
      anomalies: [{ seq: 5, type: 'PAYMENT_REFUND_REVERSED', txid: 'pi_1', severity: 'high',
        amountCents: 5000,
        reason: 'estorno de pi_1 FALHOU: dinheiro voltou pro restaurante e o cliente ficou sem' }],
    });
    expect(p.notices).toEqual([{ code: 'refund_reversed', amountCents: 5000 }]);
    // E o TEXTO da anomalia continua fora: só o código e o valor atravessam.
    expect(JSON.stringify(p)).not.toContain('FALHOU');
  });

  test('anomalia SEM valor não vira aviso — "algo a receber, não sei quanto" não ajuda', () => {
    const p = publicCheckState({
      status: 'paga', totalCents: 10000, paidCents: 10000, tipCents: 0, overpaidCents: 0,
      payments: { pi_1: { amountCents: 10000, tipCents: 0, refundedAmountCents: 0, refundedTipCents: 0 } },
      anomalies: [{ seq: 5, type: 'PAYMENT_REFUND_REVERSED', txid: 'pi_1', severity: 'high', reason: 'x' }],
    });
    expect(p.notices).toEqual([]);
    expect(p.anomalies).toBe(1);   // a casa continua vendo pelo painel
  });

  test('a postura da casa nunca vira aviso do cliente', () => {
    // Disputa aberta é assunto entre a casa e o adquirente. O cliente da mesa
    // não é parte, e contar a ele que há um chargeback em curso é o vazamento
    // que a projeção fechou.
    const p = publicCheckState({
      status: 'paga', totalCents: 3390, paidCents: 3390, tipCents: 0, overpaidCents: 0,
      payments: { pi_1: { amountCents: 3390, tipCents: 0, refundedAmountCents: 0, refundedTipCents: 0,
        disputeStatus: 'needs_response' } },
      anomalies: [{ seq: 4, type: 'PAYMENT_DISPUTED', txid: 'pi_1', severity: 'critical',
        reason: 'disputa aberta em pi_1 (fraudulent) — prova até 2026-10-18' }],
    });
    expect(p.notices).toEqual([]);
    expect(p.anomalies).toBe(1);   // a casa vê pelo painel; a mesa vê um número
  });

  test('conta normal não inventa aviso nenhum', () => {
    const p = publicCheckState({
      status: 'parcial', totalCents: 3390, paidCents: 1000, tipCents: 0, overpaidCents: 0,
      payments: {}, anomalies: [],
    });
    expect(p.notices).toEqual([]);
  });
});

describe('a busca do check que FALHA não é "não existe"', () => {
  /**
   * `findCheckByTxid` estourando (5xx do Supabase, `statement_timeout`, conexão
   * cortada) saía indistinguível de "este txid não tem conta" — e `found` era a
   * única entrada do portão da rota, onde `false` dispensava o registro durável
   * e aceitava um alerta. Um soluço do banco fazia a Pagar.me marcar como
   * entregue um cancelamento parcial que ninguém registrou, com a conciliação
   * verde por cima. Achado pela revisão de segurança de 2026-09-08.
   */
  test('não grava órfão, não finge que achou, e a rota tem que pedir reenvio', async () => {
    const { store } = await cenario();
    const avisos = [];
    const handle = createNonLedgerHandler({
      store: { ...store, findCheckByTxid: async () => { throw new Error('supabase 503'); } },
      notify: async (a) => { avisos.push(a); return { ok: true }; },
    });
    const r = await handle({
      status: 'unusable_money_event', type: 'charge.refunded', txid: 'ch_1',
      raw: { eventId: 'evt_x', status: 'partial_canceled' },
    });
    expect(r.lookupFailed).toBe(true);
    expect(r.found).toBe(false);
    expect(r.persisted).toBe(false);     // → 503, porque `naoConverge = !persisted`
    expect(r.notified).toBe(true);       // o alerta ainda sai, por outro caminho
    // E NÃO virou órfão: o evento provavelmente TEM conta, e gravá-lo na fila
    // global esconderia a anomalia da conta que devia ficar vermelha.
    expect(await store.listOrphanMoneyEvents()).toEqual([]);
  });

  test('a regra do reenvio existe em UMA cópia, e nenhuma rota tem a própria', () => {
    /**
     * O censo das ROTAS, não de uma delas.
     *
     * O teste que guardava esta regra recortava o router entre o marcador do
     * webhook do Pix e o do Stripe — então era estruturalmente incapaz de ver
     * a segunda cópia, que ficou com a versão antiga (`!persistido &&
     * !avisado`). Com `RACHA_NOTIFY_SECRET` configurado, aquele 503 nunca
     * podia disparar: um chargeback que não conseguiu ser gravado saía 200 e a
     * Stripe nunca reenviava. Achado pela revisão de segurança de 2026-09-08.
     */
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
    // Só CÓDIGO: os comentários contam a história do defeito, e proibir isso
    // proibiria documentar.
    const codigo = src.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

    // Todo lugar que devolve `money_event_unrecorded` decide pelo `needsRetry`.
    const sitios = [...codigo.matchAll(/money_event_unrecorded/g)];
    expect(sitios.length).toBeGreaterThanOrEqual(2);   // Pix e Stripe
    for (const m of sitios) {
      const antes = codigo.slice(Math.max(0, m.index - 600), m.index);
      expect(antes).toMatch(/needsRetry\(/);
    }
    // E nenhuma forma anterior sobreviveu como código.
    expect(codigo).not.toMatch(/found \? !persisted : !notified/);
    expect(codigo).not.toMatch(/!persistido && !avisado/);
    expect(codigo).not.toMatch(/const naoConverge/);
  });

  test('a regra: sem registro durável pede reenvio; quieto nunca pede', () => {
    const { needsRetry } = require('../_lib/pay/non-ledger');
    expect(needsRetry({ persisted: false })).toBe(true);
    // Um aviso que saiu NÃO substitui o registro: ele degrada pra stderr sem
    // `RACHA_NOTIFY_SECRET`, e a falha de gravação costuma ser persistente.
    expect(needsRetry({ persisted: false, notified: true })).toBe(true);
    expect(needsRetry({ persisted: true })).toBe(false);
    // `refund_progress` é estado intermediário: ele ainda vai terminar.
    expect(needsRetry({ persisted: false, quieto: true })).toBe(false);
  });

  test('store sem a fila de órfãos não constrói o tratador — falha alto e cedo', async () => {
    const { store } = await cenario();
    const semFila = { ...store };
    delete semFila.recordOrphanMoneyEvent;
    expect(() => createNonLedgerHandler({ store: semFila, notify: async () => ({ ok: true }) }))
      .toThrow(/recordOrphanMoneyEvent/);
  });
});

test('o adquirente é DITO pelo chamador, não adivinhado pelo prefixo', async () => {
  // A adivinhação errava justo no caso urgente: id de cobrança da Stripe
  // também começa com `ch_`, e um `payout.failed` chega sem txid nenhum. Um
  // repasse da Stripe que falhou ia pro log como Pagar.me, e o alerta mandava
  // abrir o painel errado no meio de um incidente.
  const { store } = await cenario();
  const handle = createNonLedgerHandler({ store, notify: async () => ({ ok: true }) });
  await handle(
    { status: 'account_alert', type: 'payout.failed', txid: null, raw: { eventId: 'evt_po' } },
    { psp: 'stripe' },
  );
  const [orfao] = await store.listOrphanMoneyEvents();
  expect(orfao.psp).toBe('stripe');
});
