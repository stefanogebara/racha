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
