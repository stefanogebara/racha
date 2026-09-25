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
  ['RH001', 409, 'house_insufficient_balance'],
  ['RH005', 404, 'house_account_not_found'],
  ['22023', 400, 'house_invalid_amount'],
])('redeem: %s → %i %s', async (codigo, statusCode, code) => {
  await expect(redeem(comErro({ code: codigo, message: 'qualquer coisa' }))).rejects.toMatchObject({ statusCode, code, message: code });
});

test('guarded: RH002 e RH003 são 409 — o redeem ESTORNA o débito no 409', async () => {
  for (const [codigo, code] of [['RH002', 'check_closed'], ['RH003', 'house_exceeds_remaining']]) {
    await expect(comErro({ code: codigo, message: 'x' }).appendHousePaymentGuarded('c', 't', 100))
      .rejects.toMatchObject({ statusCode: 409, code });
  }
});

test('a FRASE sozinha não decide: "saldo insuficiente" com código genérico não vira 409', async () => {
  const e = await redeem(comErro({ code: 'P0001', message: 'saldo insuficiente' })).catch((x) => x);
  expect(e.statusCode).toBeUndefined();
  expect(e.code).toBeUndefined();
  // E código desconhecido da classe da carteira também não inventa status.
  const d = await redeem(comErro({ code: 'RH004', message: 'conta sem eventos' })).catch((x) => x);
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
