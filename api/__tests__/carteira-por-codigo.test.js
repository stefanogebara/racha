'use strict';

/**
 * A CARTEIRA DA CASA RECUSA PELO CÓDIGO (0040), não pela frase.
 *
 * O store decidia por /saldo insuficiente/, /excede o que falta/ na mensagem
 * do banco; uma frase reformatada virava 500 e a frase em português ia crua
 * pra tela (inegociável #7; censo de RPC, 2026-09-25).
 */
const fs = require('node:fs');
const path = require('node:path');
const { createSupabaseStore } = require('../_lib/store/supabase');

const comErro = (error) => createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x', client: {
  from: () => { throw new Error('sem tabela neste teste'); },
  rpc: async () => ({ data: null, error }),
} });
const redeem = (s) => s.redeemHouse({ accountId: 'a', checkId: 'c', txid: 't', amountCents: 100, nowIso: 'n' });

test.each([
  ['RH010', 404, 'house_redeem_unknown'],
  ['RH008', 409, 'house_idempotency_mismatch'],
  ['RH007', 409, 'house_redeem_landed'],
  ['RH006', 409, 'house_redeem_reversed'],
  ['RH001', 409, 'house_insufficient_balance'],
  ['RH005', 404, 'house_account_not_found'],
  ['22023', 400, 'house_invalid_amount'],
])('redeem: %s → %i %s', async (codigo, statusCode, code) => {
  await expect(redeem(comErro({ code: codigo, message: 'qualquer coisa' }))).rejects.toMatchObject({ statusCode, code, message: code });
});

test('guarded: RH002, RH003 e RH004 são 409 — o redeem ESTORNA o débito no 409', async () => {
  for (const [codigo, code] of [['RH002', 'check_closed'], ['RH003', 'house_exceeds_remaining'], ['RH004', 'check_not_found']]) {
    await expect(comErro({ code: codigo, message: 'x' }).appendHousePaymentGuarded('c', 't', 100))
      .rejects.toMatchObject({ statusCode: 409, code });
  }
});

test('guarded: RH009 (0043, sem débito que pague) é 500 house_debit_missing — NÃO 409, que mandaria estornar', async () => {
  await expect(comErro({ code: 'RH009', message: 'x' }).appendHousePaymentGuarded('c', 't', 100))
    .rejects.toMatchObject({ statusCode: 500, code: 'house_debit_missing', message: 'house_debit_missing' });
});

test('a FRASE sozinha não decide: "saldo insuficiente" com código genérico não vira 409', async () => {
  const e = await redeem(comErro({ code: 'P0001', message: 'saldo insuficiente' })).catch((x) => x);
  expect(e.statusCode).toBeUndefined();
  expect(e.code).toBeUndefined();
  // E um código fora da lista não inventa status.
  const d = await redeem(comErro({ code: 'RH999', message: 'saldo insuficiente' })).catch((x) => x);
  expect(d.statusCode).toBeUndefined();
});

test('conta duplicada e rótulo de mesa duplicado: pelo 23505, não pela palavra "duplicate"', async () => {
  await expect(comErro({ code: '23505', message: 'x' }).createHouseAccount({ venueId: 'v', phone: '1', name: 'n' }))
    .rejects.toMatchObject({ code: 'house_duplicate_account' });
  const falso = await comErro({ code: '57014', message: 'duplicate key … statement timeout' })
    .createHouseAccount({ venueId: 'v', phone: '1', name: 'n' }).catch((x) => x);
  expect(falso.code).not.toBe('house_duplicate_account');
});

test('censo: nenhuma decisão sobre o TEXTO de um erro no código de produção', () => {
  const achados = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['__tests__', 'node_modules'].includes(e.name)) andar(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/\.test\(\s*(error|e|err)\.message\s*\)/g)) achados.push(`${path.relative(path.join(__dirname, '..'), p)}: ${m[0]}`);
    }
  };
  andar(path.join(__dirname, '..'));
  expect(achados).toEqual([]);
});

test('a 0040 dá código a TODO raise das três funções, e não cria sobrecarga', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '0040_carteira_por_codigo.sql'), 'utf8');
  const raises = [...sql.matchAll(/raise exception[^;]*;/g)].map((m) => m[0]);
  expect(raises.length).toBe(9);
  expect(raises.filter((r) => !/using errcode = '(RH00[1-5]|22023)'/.test(r))).toEqual([]);
  expect((sql.match(/create or replace function public\.(house_redeem|house_refund_principal|append_house_payment_guarded)\(/g) || []).length).toBe(3);
});


describe('o SERVIÇO com o store do Supabase: a recusa da conta estorna o débito de verdade', () => {
  // As revisões do PR #31 apontaram: os testes do serviço rodavam só sobre o
  // store em memória. Aqui a gravação guardada é a do SUPABASE (cliente falso
  // devolvendo o SQLSTATE), e o resto do mundo é o dublê — o que prova a
  // costura store→classificador→serviço, que é onde o estorno mora.
  const { createMemoryStore } = require('../_lib/store/memory');
  const { MockPsp } = require('../_lib/pay/mock-psp');
  const { createHouseService } = require('../_lib/house/house-service');

  async function mundo(codigoDaConta) {
    const store = createMemoryStore();
    const house = createHouseService({ store, psp: new MockPsp({ webhookSecret: 'x'.repeat(32) }), now: () => '2026-09-25T12:00:00.000Z' });
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000, pspRecipientId: 'rcpt_t' });
    await house.updateConfig(venue.id, { enabled: true, bonusBp: 0, validityDays: 30 });
    const table = store.seedTable(venue.id, 'Mesa 1');
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11911112222', name: 'B' });
    const load = await house.createLoad({ accountToken, amountCents: 5000 });
    await store.confirmHouseLoad({ txid: load.txid, confirmedAt: '2026-09-25T11:00:00.000Z' });
    await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 3000 }]);
    const guardada = comErro({ code: codigoDaConta, message: 'qualquer' }).appendHousePaymentGuarded;
    const estornos = [];
    const reverse = store.reverseHouseRedeem.bind(store);
    store.reverseHouseRedeem = async (args) => { estornos.push(args.txid); return reverse(args); };
    return { store, house, table, accountToken, guardada, estornos };
  }
  const saldo = async (house, token) => (await house.wallet(token)).account.principalCents;

  test.each(['RH002', 'RH003', 'RH004'])('%s na gravação guardada → débito estornado, saldo intacto, house_raced', async (codigo) => {
    const { store, house, table, accountToken, guardada, estornos } = await mundo(codigo);
    store.appendHousePaymentGuarded = guardada;
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-tentativa-1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'house_raced' });
    expect(estornos).toHaveLength(1);
    expect(await saldo(house, accountToken)).toBe(5000);
  });

  test('RETRY de um débito que ficou (duplicate) e a conta recusa → estorna também (compliance M-2)', async () => {
    const { store, house, table, accountToken, guardada, estornos } = await mundo('RH003');
    // 1ª tentativa: debita e a gravação cai por um erro que NÃO é recusa (rede).
    store.appendHousePaymentGuarded = async () => { throw new Error('fetch failed'); };
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-tentativa-2' })).rejects.toThrow(/fetch failed/);
    expect(await saldo(house, accountToken)).toBe(4000);   // débito ficou — a conciliação acusaria o par
    // 2ª, mesma chave: o débito volta `duplicate`, e a conta recusa com 409.
    store.appendHousePaymentGuarded = guardada;
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-tentativa-2' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'house_raced' });
    expect(estornos).toHaveLength(1);
    expect(await saldo(house, accountToken)).toBe(5000);
  });

  test('RETRY DEPOIS DO ESTORNO, com a mesma chave e a conta com espaço agora: recusa — a conta NÃO fica paga sem débito (0041)', async () => {
    const { store, house, table, accountToken, guardada } = await mundo('RH003');
    const gravacaoDeVerdade = store.appendHousePaymentGuarded.bind(store);
    // 1ª: a conta recusa (RH003) → o débito é estornado.
    store.appendHousePaymentGuarded = guardada;
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-do-estorno-1' }))
      .rejects.toMatchObject({ code: 'house_raced' });
    // A conta volta a ter espaço; o cliente toca de novo com a MESMA chave.
    store.appendHousePaymentGuarded = gravacaoDeVerdade;
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-do-estorno-1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'house_redeem_reversed' });
    const conta = await store.getCheckByQrToken(table.qrToken);
    expect(conta.state.paidCents).toBe(0);                            // a conta NÃO ficou paga
    expect((await house.wallet(accountToken)).account.principalCents).toBe(5000);   // o saldo intacto
    // E uma chave NOVA paga normalmente.
    await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-do-estorno-2' });
    expect((await store.getCheckByQrToken(table.qrToken)).state.paidCents).toBe(1000);
  });

  test('CORRIDA de dois pedidos com a mesma chave: o outro lançou o pagamento antes do nosso estorno → sucesso, débito mantido, conta paga uma vez (0042)', async () => {
    const { store, house, table, accountToken } = await mundo('RH003');
    const gravacaoDeVerdade = store.appendHousePaymentGuarded.bind(store);
    // A nossa gravação "perde": no instante da recusa, o pedido B (mesma chave,
    // mesmo txid) JÁ lançou o pagamento — é isso que o 409 esconde.
    store.appendHousePaymentGuarded = async (checkId, txid, amountCents) => {
      await gravacaoDeVerdade(checkId, txid, amountCents);   // B entrou
      throw Object.assign(new Error('house_exceeds_remaining'), { statusCode: 409, code: 'house_exceeds_remaining' });   // A leu a conta cheia
    };
    const r = await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-corrida-1' });
    expect(r.principalUsedCents + r.bonusUsedCents).toBe(1000);
    const conta = await store.getCheckByQrToken(table.qrToken);
    expect(conta.state.paidCents).toBe(1000);                                          // paga UMA vez
    expect((await house.wallet(accountToken)).account.principalCents).toBe(4000);   // o débito FICA — ele pagou
  });

  test('CORRIDA, a outra ordem: o nosso estorno entrou ANTES do lançamento do outro → o lançamento recusa, conta não paga, saldo intacto (0042)', async () => {
    const { store, house, table, accountToken } = await mundo('RH003');
    // Débito + estorno de uma tentativa anterior, com o MESMO txid.
    const acc = await store.getHouseAccountByToken(accountToken);
    const txid = 'ha_corrida_outra_ordem';
    const conta = await store.getCheckByQrToken(table.qrToken);
    await store.redeemHouse({ accountId: acc.id, checkId: conta.check.id, txid, amountCents: 1000, nowIso: '2026-09-25T12:00:00.000Z' });
    await store.reverseHouseRedeem({ accountId: acc.id, txid, nowIso: '2026-09-25T12:00:01.000Z' });
    // O lançamento do outro pedido chega agora.
    await expect(store.appendHousePaymentGuarded(conta.check.id, txid, 1000)).rejects.toMatchObject({ statusCode: 409, code: 'house_redeem_reversed' });
    expect((await store.getCheckByQrToken(table.qrToken)).state.paidCents).toBe(0);
    expect((await house.wallet(accountToken)).account.principalCents).toBe(5000);
  });

  // RH009 (0043) no lançamento: o serviço ESTORNA o débito deste txid e diz,
  // com certeza, que o saldo não foi debitado (compliance, PR #42, HIGH-1).
  const semDebito = () => Object.assign(new Error('house_debit_missing'), { statusCode: 500, code: 'house_debit_missing' });

  test('RH009 → o serviço estorna o débito e responde 409 house_debit_mismatch; o saldo volta inteiro', async () => {
    const { store, house, table, accountToken } = await mundo('RH003');
    store.appendHousePaymentGuarded = async () => { throw semDebito(); };
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-rh009-1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'house_debit_mismatch' });
    expect((await house.wallet(accountToken)).account.principalCents).toBe(5000);
    expect((await store.getCheckByQrToken(table.qrToken)).state.paidCents).toBe(0);
  });

  test('RH009 e o estorno diz RH010 (não havia débito): o mesmo 409 — nada foi debitado', async () => {
    const { store, house, table, accountToken } = await mundo('RH003');
    store.appendHousePaymentGuarded = async () => { throw semDebito(); };
    store.reverseHouseRedeem = async () => { throw Object.assign(new Error('house_redeem_unknown'), { statusCode: 404, code: 'house_redeem_unknown' }); };
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-rh009-2' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'house_debit_mismatch' });
  });

  test('RH009 e o estorno diz RH007 (entrou na conta que o DÉBITO nomeia — outra): NÃO é sucesso, sobe o 500 e nada de linha de pagamento', async () => {
    const { store, house, table, accountToken } = await mundo('RH003');
    store.appendHousePaymentGuarded = async () => { throw semDebito(); };
    store.reverseHouseRedeem = async () => { throw Object.assign(new Error('house_redeem_landed'), { statusCode: 409, code: 'house_redeem_landed' }); };
    let linhas = 0;
    const gravar = store.recordHousePaymentRow.bind(store);
    store.recordHousePaymentRow = async (a) => { linhas += 1; return gravar(a); };
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-rh009-3' }))
      .rejects.toMatchObject({ statusCode: 500, code: 'house_debit_missing' });
    expect(linhas).toBe(0);
    expect((await store.getCheckByQrToken(table.qrToken)).state.paidCents).toBe(0);
  });

  test('RH009 e o estorno FALHA: sobe o 500 house_debit_missing — e o código atravessa a resposta da rota', async () => {
    const { store, house, table, accountToken } = await mundo('RH003');
    store.appendHousePaymentGuarded = async () => { throw semDebito(); };
    store.reverseHouseRedeem = async () => { throw new Error('banco caiu'); };
    const e = await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-rh009-4' }).catch((x) => x);
    expect(e).toMatchObject({ statusCode: 500, code: 'house_debit_missing' });
    // A RESPOSTA, não só o erro lançado: um 5xx troca o código por `internal`,
    // a não ser que ele esteja na lista (segurança, PR #42, LOW-1).
    const { errorBody } = require('../_lib/http-error');
    expect(errorBody(e)).toMatchObject({ code: 'house_debit_missing' });
  });

  test('409 com estorno RH010 (conta recusou e não havia débito): house_raced, não erro cru', async () => {
    const { store, house, table, accountToken } = await mundo('RH003');
    store.appendHousePaymentGuarded = async () => { throw Object.assign(new Error('check_closed'), { statusCode: 409, code: 'check_closed' }); };
    store.reverseHouseRedeem = async () => { throw Object.assign(new Error('house_redeem_unknown'), { statusCode: 404, code: 'house_redeem_unknown' }); };
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-rh009-5' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'house_raced' });
  });

  test('CRÍTICO (PR #36): a mesma chave numa SEGUNDA mesa, ou com valor maior, não paga sem débito novo', async () => {
    const { store, house, table, accountToken } = await mundo('RH003');
    const acc = await store.getHouseAccountByToken(accountToken);
    const outraMesa = store.seedTable(acc.venueId, 'Mesa Y');
    await store.openCheck(outraMesa.qrToken, [{ id: 'y', name: 'Y', priceCents: 3000 }]);
    // 1) R$10 na mesa X com a chave K.
    await house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-reusada-K' });
    // 2) A MESMA chave K na mesa Y, R$30: é OUTRO pagamento — débito novo, não 'duplicate'.
    await house.redeem({ accountToken, tableQrToken: outraMesa.qrToken, amountCents: 3000, idempotencyKey: 'chave-reusada-K' });
    expect((await house.wallet(accountToken)).account.principalCents).toBe(5000 - 1000 - 3000);   // os DOIS debitados
    expect((await store.getCheckByQrToken(outraMesa.qrToken)).state.paidCents).toBe(3000);
  });

  test('guarda do banco (RH008): um "duplicado" de outra conta ou outro valor é recusado no store', async () => {
    const { store, table, accountToken } = await mundo('RH003');
    const acc = await store.getHouseAccountByToken(accountToken);
    const c = (await store.getCheckByQrToken(table.qrToken)).check.id;
    await store.redeemHouse({ accountId: acc.id, checkId: c, txid: 'ha_mesmo', amountCents: 1000, nowIso: '2026-09-25T12:00:00.000Z' });
    await expect(store.redeemHouse({ accountId: acc.id, checkId: '00000000-0000-4000-8000-00000000ffff', txid: 'ha_mesmo', amountCents: 1000, nowIso: 'n' }))
      .rejects.toMatchObject({ code: 'house_idempotency_mismatch' });
    await expect(store.redeemHouse({ accountId: acc.id, checkId: c, txid: 'ha_mesmo', amountCents: 3000, nowIso: 'n' }))
      .rejects.toMatchObject({ code: 'house_idempotency_mismatch' });
    // O MESMO pagamento repetido segue sendo duplicate.
    expect((await store.redeemHouse({ accountId: acc.id, checkId: c, txid: 'ha_mesmo', amountCents: 1000, nowIso: 'n' })).duplicate).toBe(true);
  });

  test('o EXTRATO mostra o estorno como linha própria, com o valor do débito desfeito — e sem frase do servidor (M-3)', async () => {
    const { store, house, table, accountToken, guardada } = await mundo('RH003');
    store.appendHousePaymentGuarded = guardada;
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-extrato-1' })).rejects.toMatchObject({ code: 'house_raced' });
    const extrato = (await house.wallet(accountToken)).account.ledger;
    expect(extrato.map((r) => [r.type, r.amountCents])).toEqual([['redeem_reversed', 1000], ['redeem', -1000], ['load', 5000]]);
    for (const r of extrato) expect(r).not.toHaveProperty('label');
  });

  test('erro que não é recusa provada → NÃO estorna (o débito fica e a conciliação acusa)', async () => {
    const { store, house, table, accountToken, estornos } = await mundo('RH003');
    store.appendHousePaymentGuarded = comErro({ code: 'P0001', message: 'excede o que falta pagar' }).appendHousePaymentGuarded;
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 1000, idempotencyKey: 'chave-tentativa-3' })).rejects.toThrow();
    expect(estornos).toHaveLength(0);
  });
});


describe('extrato e erros da carteira sem frase (compliance, PR #32)', () => {
  const { createMemoryStore } = require('../_lib/store/memory');
  const { MockPsp } = require('../_lib/pay/mock-psp');
  const { createHouseService } = require('../_lib/house/house-service');
  const mk = () => {
    const store = createMemoryStore();
    return { store, house: createHouseService({ store, psp: new MockPsp({ webhookSecret: 'x'.repeat(32) }), now: () => '2026-09-25T12:00:00.000Z' }) };
  };

  test('o extrato conta um débito e uma volta por txid, mesmo com o razão repetido (at-least-once)', async () => {
    const { store, house } = mk();
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000, pspRecipientId: 'rcpt_t' });
    await house.updateConfig(venue.id, { enabled: true, bonusBp: 0, validityDays: 30 });
    const table = store.seedTable(venue.id, 'Mesa 1');
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11911112222', name: 'B' });
    const acc = await store.getHouseAccountByToken(accountToken);
    const eventos = await store.loadHouseEvents(acc.id);
    const { ledgerView } = require('../_lib/house/house-service');
    const r = { type: 'REDEEMED', payload: { txid: 't1', at: 'a', principalCents: 500, bonusCents: 0 } };
    const v = { type: 'REDEEM_REVERSED', payload: { txid: 't1', at: 'b' } };
    expect(ledgerView([...eventos, r, r, v, v]).map((x) => [x.type, x.amountCents])).toEqual([['redeem_reversed', 500], ['redeem', -500]]);
  });

  test('cada erro do cliente na carteira tem código', async () => {
    const { store, house } = mk();
    await expect(house.publicConfig('nao-existe')).rejects.toMatchObject({ statusCode: 404, code: 'table_not_found' });
    const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000, pspRecipientId: 'rcpt_t' });
    await house.updateConfig(venue.id, { enabled: true, bonusBp: 0, validityDays: 30 });
    const table = store.seedTable(venue.id, 'Mesa 1');
    await expect(house.openAccount({ tableQrToken: table.qrToken, phone: 'x', name: 'B' })).rejects.toMatchObject({ statusCode: 400, code: 'house_phone_invalid' });
    await expect(house.wallet('token-que-nao-existe')).rejects.toMatchObject({ statusCode: 404, code: 'house_account_not_found' });
    const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11911112222', name: 'B' });
    await expect(house.createLoad({ accountToken, amountCents: 0 })).rejects.toMatchObject({ statusCode: 400, code: 'house_invalid_amount' });
    await expect(house.redeem({ accountToken, tableQrToken: table.qrToken, amountCents: 100 })).rejects.toMatchObject({ statusCode: 404, code: 'check_not_found' });
  });
});


test('a carteira manda o idioma da casa, como a conta (auditoria da carteira, ALTA C1)', async () => {
  const { createMemoryStore } = require('../_lib/store/memory');
  const { MockPsp } = require('../_lib/pay/mock-psp');
  const { createHouseService } = require('../_lib/house/house-service');
  const store = createMemoryStore();
  const house = createHouseService({ store, psp: new MockPsp({ webhookSecret: 'x'.repeat(32) }) });
  const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000, pspRecipientId: 'rcpt_t' });
  await house.updateConfig(venue.id, { enabled: true, bonusBp: 0, validityDays: 30 });
  const table = store.seedTable(venue.id, 'Mesa 1');
  const { accountToken } = await house.openAccount({ tableQrToken: table.qrToken, phone: '11911112222', name: 'B' });
  expect((await house.wallet(accountToken)).venue.defaultLang).toBe('pt');
});


test('censo: TODO erro do serviço da carteira sai com código (o painel e a tela traduzem; nada de frase crua)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '_lib', 'house', 'house-service.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const semCodigo = [];
  for (const m of src.matchAll(/\b(badRequest|httpError)\(([^;]*?)\);/g)) {
    const args = m[2];
    if (/^\s*(msg|status)\b|\bmsg, code\b/.test(args)) continue;   // a definição dos próprios helpers (repassam o código)
    // o código é um literal 'snake_case' ou uma expressão que já carrega um (live.code, nome.code…)
    if (!/'[a-z][a-z0-9_]+'\s*(,|$)|\b\w+\.code\b|CODIGO_/.test(args)) semCodigo.push(m[0].slice(0, 90));
  }
  expect(semCodigo).toEqual([]);
});
