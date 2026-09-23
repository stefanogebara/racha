import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoDaCobranca, type CobrancaNaTela } from '../src/pix-vivo.ts';
import {
  guardarCobranca, lerCobranca, esquecerCobranca, varrerVencidas, restaurarNaTela, formaValida, pixCobraOValor, chaveDaMesa,
  VALIDADE_DA_COBRANCA_MS, VALIDADE_DO_RECIBO_MS, type CobrancaGuardada,
} from '../src/cobranca-viva.ts';
import { cobrancaNaTela, pagamentosPorMarca } from '../src/pix-vivo.ts';

const base: CobrancaNaTela = { faltaCents: 14880, cobrancaCents: 14879, minhaCaiu: false, contaDaCobranca: 'c1', contaViva: 'c1' };

test('a mesa ainda deve o que o código cobra → pode pagar', () => {
  assert.equal(avisoDaCobranca(base), 'ok');
  assert.equal(avisoDaCobranca({ ...base, faltaCents: 14879 }), 'ok'); // exatamente o que falta
});

test('O CASO MEDIDO: outra pessoa quitou a mesa → o código não se oferece mais', () => {
  // Auditoria de bordas, CB-1: A e B geram Pix juntos, A paga, B via o código
  // de R$ 148,79 com "Copiar" e pagava a mais.
  assert.equal(avisoDaCobranca({ ...base, faltaCents: 0 }), 'mesa_paga');
});

test('alguém pagou uma parte → o código agora passa do que falta', () => {
  assert.equal(avisoDaCobranca({ ...base, faltaCents: 5000 }), 'passa_do_que_falta');
});

test('a conta trocou embaixo → o código é da conta anterior', () => {
  assert.equal(avisoDaCobranca({ ...base, contaViva: 'c2', faltaCents: 23710 }), 'conta_trocou');
});

test('o MEU caiu → nunca é aviso, mesmo com a mesa zerada por mim', () => {
  // Quem fecha a mesa zera o "falta"; no quadro antes do ✓ a tela não pode dizer
  // a ele que "a mesa já foi paga".
  assert.equal(avisoDaCobranca({ ...base, faltaCents: 0, minhaCaiu: true }), 'ok');
  assert.equal(avisoDaCobranca({ ...base, contaViva: 'c2', minhaCaiu: true }), 'ok');
});

test('servidor antigo sem `checkId` → decide só pelo que falta', () => {
  assert.equal(avisoDaCobranca({ ...base, contaDaCobranca: null }), 'ok');
  assert.equal(avisoDaCobranca({ ...base, contaDaCobranca: null, faltaCents: 0 }), 'mesa_paga');
});

// ---- os argumentos da decisão, montados da conta viva ---------------------
// Montados no JSX, eram onde a guarda morria calada (segurança, PR #17, M-3).

const conta = (paid: number, refs: string[] = [], id = 'c1') => ({
  check: { id }, state: { totalCents: 21310, paidCents: paid, payments: Object.fromEntries(refs.map((r, i) => [`p${i}`, { ref: r }])) },
});

test('cobrancaNaTela: o "falta" é total − pago, e nunca negativo', () => {
  assert.equal(cobrancaNaTela(conta(5000), { amountCents: 100, tipCents: 10, checkId: 'c1' }, null).faltaCents, 16310);
  assert.equal(cobrancaNaTela(conta(30000), { amountCents: 100, tipCents: 10, checkId: 'c1' }, null).faltaCents, 0);
});

test('cobrancaNaTela: "a minha caiu" só com a MINHA marca entre os pagamentos', () => {
  const ch = { amountCents: 100, tipCents: 0, checkId: 'c1' };
  assert.equal(cobrancaNaTela(conta(0, ['aaa', 'bbb']), ch, 'bbb').minhaCaiu, true);
  assert.equal(cobrancaNaTela(conta(0, ['aaa']), ch, 'bbb').minhaCaiu, false);
  assert.equal(cobrancaNaTela(conta(0, ['aaa']), ch, null).minhaCaiu, false);
});

test('cobrancaNaTela: a conta da COBRANÇA e a conta VIVA chegam separadas — é o que liga o "conta trocou"', () => {
  const a = cobrancaNaTela(conta(0, [], 'c2'), { amountCents: 100, tipCents: 0, checkId: 'c1' }, null);
  assert.deepEqual([a.contaDaCobranca, a.contaViva, a.cobrancaCents], ['c1', 'c2', 100]);
  assert.equal(avisoDaCobranca(a), 'conta_trocou');
});

test('pagamentosPorMarca: as marcas públicas com o valor, sem os pagamentos sem marca', () => {
  const v = { check: { id: 'c' }, state: { totalCents: 1, paidCents: 0, payments: { p1: { ref: 'aa', amountCents: 100, tipCents: 10 }, p2: { amountCents: 5, tipCents: 0 }, p3: { ref: 'bb', amountCents: 7, tipCents: 0 } } } };
  assert.deepEqual([...pagamentosPorMarca(v)].sort(), [['aa', { amountCents: 100, tipCents: 10 }], ['bb', { amountCents: 7, tipCents: 0 }]]);
});

// ---- o BR Code ---------------------------------------------------------------

// Saída do PSP de mentira da demo (CRC `MOCK`), R$ 12,22 — com o campo 54 no tamanho certo.
const BRCODE = '00020126580014br.gov.bcb.pixmock9cbfc17122df7ed0021538cd7be6520400005303986540512.225802BR6009Sao PauloRacha6304MOCK';

// Um BR Code no formato do padrão do BCB, montado aqui (TLV de verdade; CRC
// não conferido). Ainda não há um `qr_code` real do sandbox do Pagar.me no
// repositório — é a continuação que a revisão de compliance pediu.
const tlv = (id: string, v: string) => `${id}${String(v.length).padStart(2, '0')}${v}`;
const emv = (conta: string, valor?: string) => tlv('00', '01') + tlv('01', '12') + tlv('26', conta)
  + tlv('52', '0000') + tlv('53', '986') + (valor !== undefined ? tlv('54', valor) : '')
  + tlv('58', 'BR') + tlv('59', 'Bar do Ze') + tlv('60', 'Sao Paulo') + tlv('62', tlv('05', '***')) + '6304ABCD';
const ESTATICO = emv(tlv('00', 'br.gov.bcb.pix') + tlv('01', 'chave@casa.com.br'), '148.79');
const DINAMICO = emv(tlv('00', 'br.gov.bcb.pix') + tlv('25', 'qr.adquirente.com.br/v2/cobv/abc123'));

test('pixCobraOValor: BR Code de verdade — com o campo 54 exige o valor exato; SEM ele (Pix dinâmico) aceita', () => {
  assert.equal(pixCobraOValor(ESTATICO, 14879), true);
  assert.equal(pixCobraOValor(ESTATICO, 14880), false);
  assert.equal(pixCobraOValor(emv(tlv('00', 'br.gov.bcb.pix') + tlv('01', 'k'), '148.7'), 14870), true); // 54 com uma casa
  // O caso que a revisão de compliance apontou: exigir o 54 descartaria esta
  // cobrança real no primeiro recarregar, em silêncio.
  assert.equal(pixCobraOValor(DINAMICO, 14879), true);
  assert.equal(pixCobraOValor(emv(tlv('00', 'br.gov.bcb.xxx') + tlv('01', 'k'), '148.79'), 14879), false); // campo 26 não é Pix
  // O domínio do Pix em OUTRO campo que não o 26 não conta como conta Pix.
  assert.equal(pixCobraOValor(emv(tlv('00', 'x') + tlv('01', 'k'), '148.79').replace('5802BR', '5802BR' + tlv('80', 'br.gov.bcb.pix')), 14879), false);
  // Último campo mais curto do que declara: não é TLV bem formado — e fora do
  // TLV, sem o 54 do valor, não passa.
  assert.equal(pixCobraOValor(DINAMICO.slice(0, -2) , 14879), false);
});

test('pixCobraOValor: casa acentuada — o tamanho contado em BYTES também lê, e o dinâmico sem 54 não é descartado', () => {
  const tlvBytes = (id: string, v: string) => `${id}${String(new TextEncoder().encode(v).length).padStart(2, '0')}${v}`;
  const dinAcento = tlvBytes('00', '01') + tlvBytes('26', tlvBytes('00', 'br.gov.bcb.pix') + tlvBytes('25', 'qr.adq.com.br/cobv/x'))
    + tlvBytes('52', '0000') + tlvBytes('53', '986') + tlvBytes('58', 'BR') + tlvBytes('59', 'Açaí da Praça')
    + tlvBytes('60', 'São Paulo') + '6304ABCD';
  assert.equal(pixCobraOValor(dinAcento, 14879), true);
  // E contado em caracteres, o mesmo código também lê.
  assert.equal(pixCobraOValor(emv(tlv('00', 'br.gov.bcb.pix') + tlv('25', 'qr.adq.com.br/cobv/x')).replace('Bar do Ze', 'Açaí 12'), 14879), true);
});

test('pixCobraOValor: o código da demo (fora do TLV) — o valor exato em qualquer lugar — e nada que não seja Pix', () => {
  assert.equal(pixCobraOValor(BRCODE, 1222), true);
  assert.equal(pixCobraOValor(BRCODE, 1221), false);                      // outro valor
  assert.equal(pixCobraOValor(BRCODE.replace('br.gov.bcb.pix', 'br.gov.bcb.xxx'), 1222), false);
  assert.equal(pixCobraOValor(BRCODE.replace('000201', '000202'), 1222), false); // não é o payload do BR Code
  assert.equal(pixCobraOValor(BRCODE, 122200), false);                    // o centavo não vira real
  assert.equal(pixCobraOValor('<img src=x onerror=alert(1)>', 1222), false);
  assert.equal(pixCobraOValor('', 0), false);
});

// ---- a forma, por lista fechada ------------------------------------------------

const AGORA = Date.parse('2026-09-23T21:00:00Z');
const charge = { txid: 'tx1', checkId: 'c1', copiaECola: BRCODE, expiresAt: '2026-09-23T21:15:00Z', amountCents: 1111, tipCents: 111, method: 'pix' as const };
const pendente = { checkId: 'c1', charge, fase: 'pagar' as const, paidAt: null, guardadaEm: AGORA };
const guardada = (x: Partial<CobrancaGuardada> & Record<string, unknown> = {}) => ({ v: 2, ...pendente, ...x });

test('formaValida: a entrada que esta tela grava passa', () => {
  assert.equal(formaValida(guardada(), AGORA), true);
  assert.equal(formaValida(guardada({ fase: 'pago', paidAt: '2026-09-23T21:02:00Z' }), AGORA), true);
  assert.equal(formaValida(guardada({ charge: { ...charge, copiaECola: null, method: 'bizum' } }), AGORA), true);
  assert.equal(formaValida(guardada({ fase: 'pago', charge: { ...charge, copiaECola: null, method: 'card', wallet: 'google_pay' } }), AGORA), true);
});

test('formaValida: cada adulteração que a revisão de segurança mediu é recusada', () => {
  const casos: Array<[string, unknown]> = [
    ['guardadaEm no futuro (nunca venceria)', guardada({ guardadaEm: AGORA + 10 * 365 * 86400_000 })],
    ['guardadaEm ausente (idade NaN)', { ...guardada(), guardadaEm: undefined }],
    ['expiresAt ilegível ("nunca")', guardada({ charge: { ...charge, expiresAt: 'nunca' } })],
    ['copiaECola objeto (derrubava o React)', guardada({ charge: { ...charge, copiaECola: { a: 1 } as unknown as string } })],
    ['copiaECola de outro valor', guardada({ charge: { ...charge, amountCents: 999999 } })],
    ['paidAt lixo ("Invalid Date" no recibo)', guardada({ fase: 'pago', paidAt: 'lixo' })],
    ['charge.checkId ausente', guardada({ charge: { ...charge, checkId: undefined } })],
    ['charge.checkId de outra conta', guardada({ charge: { ...charge, checkId: 'conta-velha' } })],
    ['method fora da lista', guardada({ charge: { ...charge, method: 'boleto' as 'pix' } })],
    ['centavo fracionário', guardada({ charge: { ...charge, amountCents: 1.5 } })],
    ['serviço fracionário (recibo de carteira, sem código que o recuse)', guardada({ fase: 'pago', charge: { ...charge, copiaECola: null, method: 'card', tipCents: 0.5 } })],
    ['consumo negativo (recibo de carteira)', guardada({ fase: 'pago', charge: { ...charge, copiaECola: null, method: 'card', amountCents: -1 } })],
    ['wallet fora da lista', guardada({ charge: { ...charge, wallet: 'paypal' as 'apple_pay' } })],
    ['Pix pendente sem código (caixa vazia + "Copiar")', guardada({ charge: { ...charge, copiaECola: null } })],
    ['centavo negativo', guardada({ charge: { ...charge, tipCents: -1 } })],
    ['txid com lixo', guardada({ charge: { ...charge, txid: '<script>' } })],
    ['versão antiga', { ...guardada(), v: 1 }],
    ['fase desconhecida', guardada({ fase: 'estornada' as 'pago' })],
  ];
  for (const [nome, d] of casos) assert.equal(formaValida(d, AGORA), false, nome);
});

// ---- a memória -------------------------------------------------------------------

function memoria() {
  const m = new Map<string, string>();
  const a = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, key: (i: number) => [...m.keys()][i] ?? null, m };
  // `defineProperty`, não `Object.assign`: o assign lê o getter UMA vez e
  // congela o `length` em zero — a varredura não andaria e o teste mentiria.
  Object.defineProperty(a, 'length', { get: () => m.size });
  return a as typeof a & { length: number };
}

test('a chave é o hash do token, não o token — a lista de chaves não é a lista de mesas', async () => {
  const k = await chaveDaMesa('6be31dbfa7534e6e9cbccc411cef1259');
  assert.match(k ?? '', /^racha-cobranca:[0-9a-f]{24}$/);
  assert.ok(!(k ?? '').includes('6be31dbf'));
  assert.notEqual(k, await chaveDaMesa('outra-mesa'));
});

test('RECARREGOU no app do banco → a cobrança volta, pra mesma mesa', () => {
  const a = memoria();
  guardarCobranca('k7', pendente, a);
  assert.deepEqual(lerCobranca('k7', AGORA + 60_000, a), { v: 2, ...pendente });
  assert.equal(lerCobranca('k-outra', AGORA + 60_000, a), null);
});

test('vencida volta UMA vez, marcada — e sai do aparelho', () => {
  const a = memoria();
  guardarCobranca('k7', pendente, a);
  assert.equal(lerCobranca('k7', Date.parse(charge.expiresAt) + 1, a)?.vencida, true);
  assert.equal(a.m.size, 0);
  assert.equal(lerCobranca('k7', Date.parse(charge.expiresAt) + 2, a), null);
  guardarCobranca('k7', { ...pendente, charge: { ...charge, expiresAt: null } }, a);
  assert.equal(lerCobranca('k7', AGORA + VALIDADE_DA_COBRANCA_MS + 1, a)?.vencida, true);
});

test('o recibo vale a noite, e não depois', () => {
  const a = memoria();
  guardarCobranca('k7', { ...pendente, fase: 'pago', paidAt: '2026-09-23T21:02:00Z' }, a);
  assert.equal(lerCobranca('k7', AGORA + 3 * 3600_000, a)?.fase, 'pago');
  assert.equal(lerCobranca('k7', AGORA + VALIDADE_DO_RECIBO_MS + 1, a), null);
});

test('fora da forma: apagado ao ler, não consertado', () => {
  const a = memoria();
  a.setItem('k7', '{não é json');
  assert.equal(lerCobranca('k7', AGORA, a), null);
  a.setItem('k7', JSON.stringify(guardada({ guardadaEm: AGORA + 86400_000 })));
  assert.equal(lerCobranca('k7', AGORA, a), null);
  assert.equal(a.m.size, 0);
});

test('a varredura apaga o vencido das OUTRAS mesas e deixa o da mesa aberta pra ser conferido', () => {
  const a = memoria();
  guardarCobranca('racha-cobranca:velha', pendente, a);
  guardarCobranca('racha-cobranca:aberta', pendente, a);
  guardarCobranca('racha-cobranca:viva', { ...pendente, guardadaEm: AGORA + 25 * 60_000, charge: { ...charge, expiresAt: '2026-09-23T21:40:00Z' } }, a);
  a.setItem('outra-coisa', 'x'); // chave de outro dono: intocada
  varrerVencidas(AGORA + 25 * 60_000, 'racha-cobranca:aberta', a);
  assert.deepEqual([...a.m.keys()].sort(), ['outra-coisa', 'racha-cobranca:aberta', 'racha-cobranca:viva']);
});

test('armazenamento bloqueado → nada lança', () => {
  const q = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('cheio'); }, removeItem() { throw new Error('x'); } };
  assert.doesNotThrow(() => guardarCobranca('k7', pendente, q));
  assert.equal(lerCobranca('k7', AGORA, q), null);
  assert.doesNotThrow(() => esquecerCobranca('k7', q));
});

// ---- o que volta pra tela: por tabela --------------------------------------------

test('restaurarNaTela, caso a caso', () => {
  const g = (x: Partial<CobrancaGuardada> = {}) => ({ v: 2 as const, ...pendente, ...x });
  const V = { amountCents: charge.amountCents, tipCents: charge.tipCents };
  const marcas = new Map([['m-minha', V], ['m-alheia', { amountCents: 5, tipCents: 0 }]]);
  const nada = new Map<string, { amountCents: number; tipCents: number }>();
  const casos: Array<[string, ReturnType<typeof restaurarNaTela>]> = [
    // pendente
    ['pendente, não caiu', restaurarNaTela(g(), 'c1', nada, 'm-minha')],
    ['pendente, caiu → recibo SEM data (não a hora do recarregar)', restaurarNaTela(g(), 'c1', marcas, 'm-minha')],
    ['pendente, conta trocou → volta pra mostrar o aviso', restaurarNaTela(g(), 'c2', nada, 'm-minha')],
    ['pendente, sem crypto.subtle', restaurarNaTela(g(), 'c1', marcas, null)],
    // recibo
    ['recibo, confirmado, mesma conta', restaurarNaTela(g({ fase: 'pago', paidAt: '2026-09-23T21:02:00Z' }), 'c1', marcas, 'm-minha')],
    ['recibo, outra conta (HIGH-2)', restaurarNaTela(g({ fase: 'pago' }), 'c2', marcas, 'm-minha')],
    ['recibo, o servidor não confirma (forjado, M-1)', restaurarNaTela(g({ fase: 'pago' }), 'c1', new Map([['m-alheia', V]]), 'm-minha')],
    ['recibo, marca real e VALOR inflado', restaurarNaTela(g({ fase: 'pago', charge: { ...charge, amountCents: 999999 } }), 'c1', marcas, 'm-minha')],
    ['recibo, mesmo consumo e SERVIÇO inflado', restaurarNaTela(g({ fase: 'pago', charge: { ...charge, tipCents: 50000 } }), 'c1', marcas, 'm-minha')],
    ['recibo, sem crypto.subtle', restaurarNaTela(g({ fase: 'pago' }), 'c1', marcas, null)],
    // vencida
    ['vencida, caiu → recibo sem data', restaurarNaTela(g({ vencida: true }), 'c1', marcas, 'm-minha')],
    ['vencida, não caiu', restaurarNaTela(g({ vencida: true }), 'c1', nada, 'm-minha')],
  ];
  const resumo = casos.map(([nome, r]) => [nome, r && [r.fase, r.paidAt, r.ownRef]]);
  assert.deepEqual(resumo, [
    ['pendente, não caiu', ['pagar', null, 'm-minha']],
    ['pendente, caiu → recibo SEM data (não a hora do recarregar)', ['pago', null, 'm-minha']],
    ['pendente, conta trocou → volta pra mostrar o aviso', ['pagar', null, 'm-minha']],
    ['pendente, sem crypto.subtle', ['pagar', null, null]],
    ['recibo, confirmado, mesma conta', ['pago', '2026-09-23T21:02:00Z', 'm-minha']],
    ['recibo, outra conta (HIGH-2)', null],
    ['recibo, o servidor não confirma (forjado, M-1)', null],
    ['recibo, marca real e VALOR inflado', null],
    ['recibo, mesmo consumo e SERVIÇO inflado', null],
    ['recibo, sem crypto.subtle', null],
    ['vencida, caiu → recibo sem data', ['pago', null, 'm-minha']],
    ['vencida, não caiu', null],
  ]);
});

// ---- o censo da ligação em App.tsx -------------------------------------------------
// O que sobra fora das funções puras: a tela TEM de passar por elas.
import { readFileSync } from 'node:fs';
const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const telaDoPix = APP.slice(APP.indexOf("if (step === 'pagar' && charge) {"), APP.indexOf("if (step === 'pago') {"));

test('a tela do Pix decide por `avisoDaCobranca(cobrancaNaTela(view, charge, ownRef))` — e código, copiar e simular só no ramo "ok"', () => {
  assert.ok(telaDoPix.includes('avisoDaCobranca(cobrancaNaTela(view, charge, ownRef))'), 'os argumentos voltaram a ser montados à mão');
  const ramoOk = telaDoPix.indexOf(') : (', telaDoPix.indexOf("aviso !== 'ok' ?"));
  assert.ok(ramoOk > 0);
  for (const peca of ['className="codebox', 'onCopy', 'onDevConfirm']) {
    assert.ok(telaDoPix.indexOf(peca) > ramoOk, `${peca} fora do ramo "ok"`);
  }
  const aviso = telaDoPix.slice(telaDoPix.indexOf("aviso !== 'ok' ?"), ramoOk);
  assert.ok(aviso.includes("{ownRef === null && <p className=\"muted small center\">{t('pix.noAutoConfirm')}"), 'sem marca, o aviso de não pagar duas vezes some');
  assert.ok(aviso.includes("t('pix.chargeId'"));
});

test('a restauração passa por `restaurarNaTela` com a marca RECALCULADA do txid, e nada guarda a marca', () => {
  assert.ok(/restaurarNaTela\(g, conta\.check\.id, pagamentosPorMarca\(conta\), marca\)/.test(APP), 'a restauração não passa pela decisão pura');
  assert.ok(/const marca = await refDoPagamento\(g\.charge\.txid\)/.test(APP), 'a marca não é recalculada do txid');
  assert.ok(!/guardarCobranca\([^)]*ownRef/.test(APP), 'a marca voltou a ser guardada — forjável');
});
