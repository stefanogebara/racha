'use strict';

/**
 * "SERVIÇO DA EQUIPE (FOLHA)" É O DE HOJE — e nada afirmava isso.
 *
 * `today.tipsCents` é o número que o dono lê e distribui: a base da Lei
 * 13.419/2017 e do inegociável #2. Ele só quer dizer "hoje" por causa de UM
 * filtro (`doDia`, que compara `spDay(confirmedAt)` com `spDay(nowIso)`) — e
 * nenhum teste deste repositório afirmava esse filtro. Apagá-lo publica o total
 * de OITO DIAS sob o rótulo "hoje", com a suíte inteira verde, e o dono
 * distribui cerca de oito vezes o valor certo. Dinheiro de gorjeta entregue não
 * volta.
 *
 * É a regra que esta casa aplica em todo lugar — uma guarda que nunca é
 * afirmada é testada em produção — aplicada ao número mais caro da tela.
 * Achado pela revisão de compliance de 2026-09-16 (MEDIUM-D).
 *
 * ── POR QUE O DUBLÊ IMPORTA AQUI ────────────────────────────────────────────
 * Um dublê que faz `gte` virar no-op absolveria a janela e o corte do dia — o
 * teste passaria sobre um filtro que não rodou. O `test-helpers/postgrest-falso`
 * HONRA `gte`, e o último caso deste arquivo mede o próprio dublê pra provar
 * isso.
 */

const { createSupabaseStore } = require('../_lib/store/supabase');
const { postgrestFalso } = require('../../test-helpers/postgrest-falso');

const uuid = (n) => `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`;

/** Um instante em São Paulo (UTC-3), em ISO. */
const emSP = (dia, hora) => new Date(`${dia}T${hora}:00.000-03:00`).toISOString();

function casaCom(pagamentos) {
  const checks = [], check_events = [], payments = [];
  pagamentos.forEach((p, i) => {
    checks.push({ id: uuid(i), venue_id: 'v1', table_id: 't1', status: 'aberta', opened_at: p.quando, pos_ref: '[]' });
    check_events.push({ check_id: uuid(i), seq: 1, type: 'OPENED', payload: { totalCents: p.cents }, created_at: p.quando });
    payments.push({
      check_id: uuid(i), txid: `tx_${i}`, venue_id: 'v1', status: 'confirmado',
      amount_cents: p.cents, tip_cents: p.gorjeta,
      confirmed_amount_cents: p.cents, confirmed_tip_cents: p.gorjeta,
      refunded_amount_cents: 0, refunded_tip_cents: 0,
      method: 'pix', currency: 'BRL', confirmed_at: p.quando,
    });
  });
  return {
    venues: [{ id: 'v1', name: 'Casa', market: 'BR' }],
    venue_tables: [{ id: 't1', venue_id: 'v1', label: 'Mesa 1', training: false }],
    checks, check_events, payments,
  };
}

const painelEm = async (dados, agora) => {
  // `projetar: false`: o painel lê colunas embutidas (`venue_tables(label)`) que
  // a projeção simples do dublê não sabe montar. O que este arquivo mede é o
  // FILTRO de data, não o select.
  const { client } = postgrestFalso(dados, { projetar: false });
  const store = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client });
  return store.getPanelView('v1', agora);
};

describe('a gorjeta de HOJE é a de hoje', () => {
  const AGORA = emSP('2026-09-16', '20:00');

  test('o pagamento de ONTEM não entra na linha da folha', async () => {
    const dados = casaCom([
      { quando: emSP('2026-09-16', '13:00'), cents: 10000, gorjeta: 1000 },  // hoje
      { quando: emSP('2026-09-15', '13:00'), cents: 50000, gorjeta: 5000 },  // ontem
    ]);
    const painel = await painelEm(dados, AGORA);
    // Se o corte do dia sumir, isto vira 6000 — o total dos oito dias.
    expect(painel.today.tipsCents).toBe(1000);
    expect(painel.today.confirmedCents).toBe(10000);
  });

  test('e a JANELA de oito dias continua alimentando a série semanal', async () => {
    // O corte do dia é do `today`; a janela é da série. Confundir os dois nas
    // duas direções é o mesmo defeito, então as duas metades são afirmadas.
    const dados = casaCom([
      { quando: emSP('2026-09-16', '13:00'), cents: 10000, gorjeta: 1000 },
      { quando: emSP('2026-09-15', '13:00'), cents: 50000, gorjeta: 5000 },
    ]);
    const painel = await painelEm(dados, AGORA);
    const soma = painel.ativacao.semana.valorCents;
    expect(soma).toBeGreaterThanOrEqual(60000);
  });

  test('a virada do dia é a de SÃO PAULO, não a do UTC', async () => {
    // 2026-09-16 23:30 em SP é 2026-09-17 02:30 em UTC. Um corte feito em UTC
    // jogaria este pagamento pro "amanhã" e a gorjeta da noite sumiria da folha
    // do dia em que ela foi ganha — justamente no horário de pico de um bar.
    const dados = casaCom([{ quando: emSP('2026-09-16', '23:30'), cents: 10000, gorjeta: 1000 }]);
    const painel = await painelEm(dados, emSP('2026-09-16', '23:45'));
    expect(painel.today.tipsCents).toBe(1000);
  });

  test('o pagamento de uma mesa de TREINO não entra na folha', async () => {
    const dados = casaCom([{ quando: emSP('2026-09-16', '13:00'), cents: 10000, gorjeta: 1000 }]);
    dados.venue_tables[0].training = true;
    const painel = await painelEm(dados, AGORA);
    expect(painel.today.tipsCents).toBe(0);
  });

  test('e o falso FILTRA de verdade — senão tudo acima passaria sobre nada', async () => {
    // A metade que morre em silêncio: um falso que ignora `gte` faz toda
    // asserção de janela virar ✓ sobre um filtro que não rodou. Aqui se mede o
    // próprio falso.
    const dados = casaCom([{ quando: emSP('2026-01-01', '13:00'), cents: 10000, gorjeta: 1000 }]);
    const painel = await painelEm(dados, AGORA);
    // Nove meses atrás: fora da janela de oito dias, então nem no `today` nem na
    // série. Se o `gte` do falso fosse no-op, este número seria 1000.
    expect(painel.today.tipsCents).toBe(0);
  });
});

/**
 * O QUE O PAINEL CARREGA — e o que ele deixa de carregar.
 *
 * Paginar a lista de contas consertou o número e criou um custo: o painel
 * passou a ler TODA conta que a casa já teve, e todo evento de cada uma, a cada
 * volta do laço. Dez mil contas em três meses numa casa de 120/dia.
 *
 * O recorte não pode ser uma janela seca — conta ABERTA de qualquer idade tem
 * que aparecer, e obrigação de restituição (CC art. 876) não vence. São três
 * conjuntos, e este arquivo afirma os três mais o que fica de fora.
 * Compliance MEDIUM-C e segurança NEW-3, de 2026-09-16.
 */
describe('a lista de contas do painel tem recorte — e ele não perde nada que importa', () => {
  const AGORA = emSP('2026-09-16', '20:00');
  const ANTIGA = emSP('2026-01-10', '13:00');

  /** Uma casa com quatro contas de idades e estados diferentes. */
  function casaVariada() {
    const linha = (n, quando, status) => ({
      id: uuid(n), venue_id: 'v1', table_id: `t${n}`, status, opened_at: quando, pos_ref: '[]',
      venue_tables: { label: `Mesa ${n}` },
    });
    return {
      venues: [{ id: 'v1', name: 'Casa', market: 'BR' }],
      venue_tables: [0, 1, 2, 3].map((n) => ({ id: `t${n}`, venue_id: 'v1', label: `Mesa ${n}`, training: false })),
      checks: [
        linha(0, AGORA, 'aberta'),      // de hoje, aberta
        linha(1, ANTIGA, 'aberta'),     // VELHA e ABERTA — tem que ficar
        linha(2, ANTIGA, 'fechada'),    // velha, fechada, paga esta semana — tem que ficar
        linha(3, ANTIGA, 'fechada'),    // velha, fechada, sem movimento — SAI
      ],
      check_events: [0, 1, 2, 3].map((n) => ({
        check_id: uuid(n), seq: 1, type: 'OPENED', payload: { totalCents: 10000 },
        created_at: n === 0 ? AGORA : ANTIGA,
      })),
      payments: [{
        // O dinheiro que entrou HOJE numa conta VELHA e fechada: é dele que sai
        // o desconto de dívida da série semanal.
        check_id: uuid(2), txid: 'tx_velha', venue_id: 'v1', status: 'confirmado',
        amount_cents: 10000, tip_cents: 1000,
        confirmed_amount_cents: 10000, confirmed_tip_cents: 1000,
        refunded_amount_cents: 0, refunded_tip_cents: 0,
        method: 'pix', currency: 'BRL', confirmed_at: AGORA,
      }],
    };
  }

  test('fica: a de hoje, a VELHA E ABERTA, e a velha que recebeu dinheiro na janela', async () => {
    const painel = await painelEm(casaVariada(), AGORA);
    const ids = new Set(painel.checks.map((c) => c.checkId));
    expect(ids.has(uuid(0))).toBe(true);   // de hoje
    expect(ids.has(uuid(1))).toBe(true);   // VELHA e aberta: obrigação viva não vence
    expect(ids.has(uuid(2))).toBe(true);   // velha, mas o dinheiro é desta semana
  });

  test('sai: a velha, fechada e sem movimento — é ela que fazia a lista crescer pra sempre', async () => {
    const painel = await painelEm(casaVariada(), AGORA);
    expect(painel.checks.map((c) => c.checkId)).not.toContain(uuid(3));
    expect(painel.checks).toHaveLength(3);
  });

  test('e a gorjeta da conta VELHA continua entrando na folha do dia', async () => {
    // O recorte é da LISTA, não do dinheiro: quem pagou hoje numa conta velha
    // pagou hoje. Se o terceiro conjunto sumisse, este número iria a zero.
    const painel = await painelEm(casaVariada(), AGORA);
    expect(painel.today.tipsCents).toBe(1000);
  });

  /**
   * O BURACO CONHECIDO DO RECORTE, dito em voz alta.
   *
   * O terceiro conjunto sai de `confirmedRaw`, que filtra
   * `status='confirmado'` E `confirmed_at >= desde`. Uma conta VELHA e FECHADA
   * cujo único movimento na janela foi um ESTORNO não entra em conjunto
   * nenhum: `confirmed_at` é a data em que o dinheiro entrou, não a data da
   * devolução, e o `status` no banco não volta a `aberta` quando um estorno
   * reabre a conta (a 0004 só escreve `fechada`, no fechamento).
   *
   * Isso é ACEITO, e não ignorado. A obrigação continua visível pelo canal
   * ALTO: a conciliação não tem janela de data — ela varre a casa inteira — e
   * emite `reopened_by_refund` / `reopened_by_refund_mixed`, que o painel
   * desenha entre os achados e que vira `critical` depois de 48 h
   * (`reconcile.test.js`, `refund-partial.test.js`). O que se perde é a LINHA
   * da mesa numa lista de mesas; o que se mantém é o aviso de que há dinheiro
   * a resolver.
   *
   * Fica escrito aqui porque um recorte sem o seu próprio buraco documentado é
   * como alguém descobre o buraco tarde.
   */
  test('a conta velha, fechada e só ESTORNADA na janela sai da lista — e o aviso fica com a conciliação', async () => {
    const dados = casaVariada();
    // A conta 3 (velha, fechada, sem movimento) ganha um estorno de hoje no
    // razão — sem pagamento confirmado na janela.
    dados.check_events.push({
      check_id: uuid(3), seq: 2, type: 'PAYMENT_REFUNDED',
      payload: { txid: 'tx_antigo', amountCents: 5000, tipCents: 0 }, created_at: AGORA,
    });
    const painel = await painelEm(dados, AGORA);
    expect(painel.checks.map((c) => c.checkId)).not.toContain(uuid(3));
  });

  /**
   * A DISPUTA CHEGA SEMPRE TARDE — e por isso caía fora de tudo.
   *
   * Uma disputa não toca `confirmed_at` nem o `status` da conta: é um evento no
   * razão, e o cartão tem 120 dias pra abrir uma. Então a conta disputada é
   * sempre velha e fechada, e o quadro de chargebacks do painel ficava vazio
   * POR CONSTRUÇÃO — justo no caso em que há dinheiro saindo da casa. E o canal
   * alto não cobria: a conciliação só avisa numa faixa de sete dias antes do
   * prazo de evidência, e uma disputa PERDIDA não gera achado `dispute_*`
   * nenhum. Achado pela terceira revisão de segurança de 2026-09-16 (M3).
   */
  test('a conta VELHA com disputa nova volta pra lista — o quadro de chargeback depende disso', async () => {
    const dados = casaVariada();
    dados.check_events.push({
      check_id: uuid(3), seq: 2, type: 'PAYMENT_DISPUTED',
      payload: { txid: 'tx_antigo', amountCents: 5000, disputeId: 'dp_1' }, created_at: AGORA,
    });
    const painel = await painelEm(dados, AGORA);
    expect(painel.checks.map((c) => c.checkId)).toContain(uuid(3));
  });

  test('e a disputa VELHA não traz a conta de volta — a janela vale pros dois lados', async () => {
    const dados = casaVariada();
    dados.check_events.push({
      check_id: uuid(3), seq: 2, type: 'PAYMENT_DISPUTED',
      payload: { txid: 'tx_antigo', amountCents: 5000, disputeId: 'dp_1' }, created_at: ANTIGA,
    });
    const painel = await painelEm(dados, AGORA);
    expect(painel.checks.map((c) => c.checkId)).not.toContain(uuid(3));
  });

  /**
   * A DISPUTA DE OUTRA CASA NÃO ENTRA NESTE PAINEL.
   *
   * A leitura de eventos de disputa NÃO tem filtro de casa — `check_events` não
   * tem a coluna `venue_id`, então ela varre a janela inteira da plataforma. O
   * que segura o inquilino é o `.eq('venue_id')` da busca das CONTAS por id, e
   * essa guarda passou a ser carregada justamente por este conjunto novo: antes
   * dele, todo id vinha de uma consulta já filtrada por casa, e a revisão a
   * classificou como "não alcançável hoje". Agora é.
   *
   * Sem o filtro, o painel do dono A desenharia a mesa, os totais e a dívida de
   * uma conta do dono B — o `select` puxa `venue_tables(label)` junto.
   */
  test('a disputa de OUTRA casa não traz a conta dela pro meu painel', async () => {
    const dados = casaVariada();
    // Uma segunda casa, com a sua mesa, a sua conta e uma disputa de hoje.
    dados.venues.push({ id: 'v2', name: 'Casa Vizinha', market: 'BR' });
    dados.venue_tables.push({ id: 't9', venue_id: 'v2', label: 'Mesa da Vizinha', training: false });
    dados.checks.push({
      id: uuid(9), venue_id: 'v2', table_id: 't9', status: 'fechada', opened_at: ANTIGA,
      pos_ref: '[]', venue_tables: { label: 'Mesa da Vizinha' },
    });
    dados.check_events.push({
      check_id: uuid(9), seq: 1, type: 'PAYMENT_DISPUTED',
      payload: { txid: 'tx_vizinha', amountCents: 9999, disputeId: 'dp_9' }, created_at: AGORA,
    });

    const painel = await painelEm(dados, AGORA);
    expect(painel.checks.map((c) => c.checkId)).not.toContain(uuid(9));
    // E o rótulo da mesa dela não aparece em lugar nenhum da resposta.
    expect(JSON.stringify(painel)).not.toContain('Mesa da Vizinha');
  });

  test('a lista sai em ordem CRONOLÓGICA — a união dos conjuntos não decide a ordem', async () => {
    const painel = await painelEm(casaVariada(), AGORA);
    const datas = painel.checks.map((c) => c.checkId);
    // As duas velhas (1 e 2) antes da de hoje (0).
    expect(datas.indexOf(uuid(0))).toBe(datas.length - 1);
  });

  test('nenhuma conta aparece duas vezes — os três conjuntos se sobrepõem de propósito', async () => {
    const painel = await painelEm(casaVariada(), AGORA);
    const ids = painel.checks.map((c) => c.checkId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * OS DOIS STORES DESENHAM O MESMO PAINEL.
 *
 * O recorte nasceu só no store de produção. O de memória continuou devolvendo
 * TODA conta da casa — e é contra ele que quase todo teste de painel roda, o
 * que faria cada um deles provar um comportamento que a produção não tem
 * (`dispute-lifecycle.test.js` é o primeiro caso, e ele já está na árvore).
 * É a armadilha que o `memory.js` documenta sobre si mesmo em três lugares,
 * aplicada ao RECORTE em vez de a um campo. Achado pela terceira revisão de
 * compliance de 2026-09-16 (MEDIUM-C/M5).
 *
 * Medido antes de escrever isto: apagar o filtro do store de memória não
 * quebrava NADA na suíte inteira. Este teste é o que faz quebrar.
 */
describe('o recorte do painel é o MESMO nos dois stores', () => {
  const { createMemoryStore } = require('../_lib/store/memory');

  /**
   * `openCheck` devolve a PRÓPRIA linha guardada no Map (não uma cópia), então
   * envelhecer uma conta é mexer no `openedAt` dela. É seam de dublê, não de
   * produção — e é o mesmo campo que o store de produção lê.
   */
  const envelhecer = (linha, dias) => {
    linha.openedAt = new Date(Date.now() - dias * 86400000).toISOString();
  };

  async function casaNaMemoria() {
    const store = createMemoryStore();
    const venue = await store.seedVenue({ name: 'Casa', servicoBp: 1000, pspRecipientId: 're_x' });
    const mesaA = await store.seedTable(venue.id, 'Mesa A');
    const mesaB = await store.seedTable(venue.id, 'Mesa B');
    const velha = await store.openCheck(mesaA.qrToken, [{ id: 'i', name: 'X', priceCents: 1000 }]);
    envelhecer(velha, 60);
    const dehoje = await store.openCheck(mesaB.qrToken, [{ id: 'i', name: 'Y', priceCents: 2000 }]);
    return { store, venue, velha, dehoje };
  }

  test('a conta ABERTA de qualquer idade fica — obrigação viva não vence', async () => {
    const { store, venue, velha, dehoje } = await casaNaMemoria();
    const ids = (await store.getPanelView(venue.id)).checks.map((c) => c.checkId);
    expect(ids).toContain(dehoje.id);
    expect(ids).toContain(velha.id);
  });

  test('a conta velha, FECHADA e parada sai — como sai na produção', async () => {
    const { store, venue, velha, dehoje } = await casaNaMemoria();
    // O fechamento é um EVENTO no razão — não há `closeCheck` no store; quem
    // fecha é o serviço, pelo `appendEvent`. O recorte lê o estado derivado,
    // então é assim que a conta fica fechada de verdade.
    await store.appendEvent(velha.id, 'CLOSED', {});
    const ids = (await store.getPanelView(venue.id)).checks.map((c) => c.checkId);
    expect(ids).toContain(dehoje.id);
    expect(ids).not.toContain(velha.id);
  });
});
