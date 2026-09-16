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

  test('nenhuma conta aparece duas vezes — os três conjuntos se sobrepõem de propósito', async () => {
    const painel = await painelEm(casaVariada(), AGORA);
    const ids = painel.checks.map((c) => c.checkId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
