import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoDaCobranca, type CobrancaNaTela } from '../src/pix-vivo.ts';
import {
  guardarCobranca, lerCobranca, esquecerCobranca, varrerVencidas, VALIDADE_DA_COBRANCA_MS, VALIDADE_DO_RECIBO_MS,
} from '../src/cobranca-viva.ts';

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

// ---- a memória da cobrança -------------------------------------------------

function memoria() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}
const AGORA = Date.parse('2026-09-23T21:00:00Z');
const charge = { txid: 'tx1', checkId: 'c1', copiaECola: '000201…', expiresAt: '2026-09-23T21:15:00Z', amountCents: 11855, tipCents: 1186, method: 'pix' as const };
const pendente = { checkId: 'c1', charge, ownRef: 'r1', fase: 'pagar' as const, paidAt: null, guardadaEm: AGORA };

test('RECARREGOU no app do banco → a cobrança volta, com a marca, pra mesma mesa', () => {
  const a = memoria();
  guardarCobranca('mesa7', pendente, a);
  assert.deepEqual(lerCobranca('mesa7', AGORA + 60_000, a), { v: 1, ...pendente });
  assert.equal(lerCobranca('outra-mesa', AGORA + 60_000, a), null); // por MESA
});

test('cobrança vencida volta só MARCADA como vencida — e sai do armazenamento', () => {
  const a = memoria();
  guardarCobranca('mesa7', pendente, a);
  assert.equal(lerCobranca('mesa7', Date.parse(charge.expiresAt) + 1, a)?.vencida, true);
  assert.equal(a.m.size, 0);
  assert.equal(lerCobranca('mesa7', Date.parse(charge.expiresAt) + 2, a), null); // uma vez só
  guardarCobranca('mesa7', { ...pendente, charge: { ...charge, expiresAt: null } }, a);
  assert.equal(lerCobranca('mesa7', AGORA + VALIDADE_DA_COBRANCA_MS + 1, a)?.vencida, true);
  assert.equal(lerCobranca('mesa7', AGORA + 60_000, a), null);
});

test('o recibo volta pela noite, e não depois', () => {
  const a = memoria();
  const pago = { ...pendente, fase: 'pago' as const, paidAt: '2026-09-23T21:02:00Z' };
  guardarCobranca('mesa7', pago, a);
  assert.equal(lerCobranca('mesa7', AGORA + 3 * 3600_000, a)?.fase, 'pago');
  assert.equal(lerCobranca('mesa7', AGORA + VALIDADE_DO_RECIBO_MS + 1, a), null);
});

test('lixo no armazenamento é descartado, não consertado', () => {
  const a = memoria();
  a.setItem('racha-cobranca:mesa7', '{não é json');
  assert.equal(lerCobranca('mesa7', AGORA, a), null);
  a.setItem('racha-cobranca:mesa7', JSON.stringify({ v: 1, checkId: 'c1', charge: { txid: 'x', amountCents: 1.5, tipCents: 0 }, fase: 'pagar', guardadaEm: AGORA }));
  assert.equal(lerCobranca('mesa7', AGORA, a), null); // centavo fracionário
  assert.equal(a.m.size, 0);
});

test('armazenamento bloqueado → nada lança, a tela segue como antes', () => {
  const quebrado = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('cheio'); }, removeItem() { throw new Error('x'); } };
  assert.doesNotThrow(() => guardarCobranca('mesa7', pendente, quebrado));
  assert.equal(lerCobranca('mesa7', AGORA, quebrado), null);
  assert.doesNotThrow(() => esquecerCobranca('mesa7', quebrado));
});

// ---- o censo da ligação em App.tsx -----------------------------------------
// A decisão pura não protege ninguém se a tela não passar por ela. Foi assim
// que o `recibo.ts` quase saiu: progresso e botão passavam, os avisos não.
import { readFileSync } from 'node:fs';
const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const telaDoPix = APP.slice(APP.indexOf("if (step === 'pagar' && charge) {"), APP.indexOf("if (step === 'pago') {"));

test('a tela do Pix decide pela `avisoDaCobranca` — e o código, o copiar e o simular só existem no ramo "ok"', () => {
  assert.ok(telaDoPix.includes('avisoDaCobranca('), 'a tela do Pix não consulta a decisão');
  const ramoOk = telaDoPix.indexOf(") : (", telaDoPix.indexOf("aviso !== 'ok' ?"));
  assert.ok(ramoOk > 0, 'não achei o ramo "ok"');
  for (const peca of ['className="codebox', 'onCopy', 'onDevConfirm']) {
    const onde = telaDoPix.indexOf(peca);
    assert.ok(onde > ramoOk, `${peca} aparece fora do ramo "ok" — voltaria a se oferecer com a mesa paga`);
  }
});

test('a cobrança é guardada e restaurada pela memória, e o "pagar mais" a esquece', () => {
  assert.ok(APP.includes('lerCobranca(token'), 'nada restaura a cobrança num recarregar');
  assert.ok(APP.includes('guardarCobranca(token'), 'nada guarda a cobrança');
  const pagarMais = APP.slice(APP.lastIndexOf('setCharge(null);', APP.indexOf("t('paid.payMore')")), APP.indexOf("t('paid.payMore')"));
  assert.ok(pagarMais.includes('esquecerCobranca(token)'), '"pagar mais" deixaria o recibo velho voltar num recarregar');
});

// ---- a segunda leva: a revisão de compliance do PR #17 ----------------------

function memoriaComChaves() {
  const m = memoria();
  // `defineProperty`, não `Object.assign`: o assign lê o getter UMA vez e
  // congela o `length` em zero — a varredura não andaria e o teste mentiria.
  Object.defineProperty(m, 'length', { get: () => m.m.size });
  return Object.assign(m, { key: (i: number) => [...m.m.keys()][i] ?? null }) as typeof m & { length: number; key: (i: number) => string | null };
}

test('cobrança VENCIDA volta uma vez, marcada — quem pagou aos 10 min e voltou aos 25 não perde o recibo', () => {
  const a = memoria();
  guardarCobranca('mesa7', pendente, a);
  const lida = lerCobranca('mesa7', Date.parse(charge.expiresAt) + 60_000, a);
  assert.equal(lida?.vencida, true);
  assert.equal(lida?.ownRef, 'r1'); // a marca chega inteira, pra tela conferir
  assert.equal(a.m.size, 0);        // e já saiu do aparelho
});

test('a varredura apaga o vencido das OUTRAS mesas e deixa o da mesa aberta pra ser conferido', () => {
  const a = memoriaComChaves();
  guardarCobranca('mesa-velha', pendente, a);
  guardarCobranca('mesa7', pendente, a);
  guardarCobranca('mesa-viva', { ...pendente, guardadaEm: AGORA + 25 * 60_000, charge: { ...charge, expiresAt: '2026-09-23T21:40:00Z' } }, a);
  varrerVencidas(AGORA + 25 * 60_000, 'mesa7', a);
  assert.deepEqual([...a.m.keys()].sort(), ['racha-cobranca:mesa-viva', 'racha-cobranca:mesa7']);
});

test('a tela: recibo só volta na conta dele; vencida só volta se a marca caiu; sem marca, o aviso de não pagar duas vezes fica', () => {
  assert.ok(APP.includes("g.fase === 'pago' && g.checkId !== view.check.id"), 'o recibo de outra conta voltaria como beco sem saída');
  assert.ok(/if \(g\.vencida\) \{[\s\S]*?if \(!caiu\) return;/.test(APP), 'uma cobrança vencida e não paga voltaria');
  const aviso = telaDoPix.slice(telaDoPix.indexOf("aviso !== 'ok' ?"), telaDoPix.indexOf(") : (", telaDoPix.indexOf("aviso !== 'ok' ?")));
  assert.ok(aviso.includes("ownRef === null && <p className=\"muted small center\">{t('pix.noAutoConfirm')}"), 'o aparelho sem marca perderia o aviso');
  assert.ok(aviso.includes("t('pix.chargeId'"), 'sem o id, a equipe não acha o pagamento');
});
