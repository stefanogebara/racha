'use strict';

/**
 * O TETO DE COBRANÇAS VIVAS — terceira forma, e estes testes fazem o que o
 * ATACANTE faz.
 *
 * As duas formas anteriores foram testadas do ponto de vista de quem PAGA:
 * todo caso esperava cada cobrança antes da próxima, e as duas passaram verdes
 * enquanto a revisão de segurança de 2026-09-15 media:
 *
 *  · 300 pedidos simultâneos → 300 cobranças, zero recusas;
 *  · 60 cobranças de um centavo → a mesa inteira trancada;
 *  · três instâncias, um IP → a mesa trancada de novo;
 *  · 90 corpos INVÁLIDOS do wi-fi do salão → a mesa trancada com zero cobrança;
 *  · pedidos em fluxo com latência no banco → 214 e 228 contra teto 200.
 *
 * Todos moravam na memória da função. Agora a contagem e a reserva são UMA
 * instrução no banco (`claim_slots`, migração 0033; `claimSlots` no gêmeo em
 * memória), chamada depois da validação. Cada forma de ataque acima tem um
 * teste aqui.
 */

// A PONTE DE AVISO é um endereço que recusa na hora: nenhum teste deste arquivo
// fala com a ponte de verdade, e o da ponte que FALHA precisa de uma que falhe.
process.env.RACHA_NOTIFY_URL = 'http://127.0.0.1:1';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { MockPsp } = require('../_lib/pay/mock-psp');
const {
  createChargeService, TETO_PENDENTES, JANELA_VIVA_MS,
  MAX_PESSOAS_NA_DIVISAO, TENTATIVAS_POR_PESSOA, geracaoDoQr,
} = require('../_lib/pay/create-charge');
const { createMemoryStore } = require('../_lib/store/memory');
const { createHouseService } = require('../_lib/house/house-service');

const SECRET = 'test-webhook-secret-0123456789';
const RAIZ = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ler = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8');

beforeAll(() => { jest.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterAll(() => { jest.restoreAllMocks(); });

/**
 * Um mundo com latência opcional no PSP e AO REDOR da reivindicação — a
 * latência do banco que a forma anterior não tinha e que a revisão pôs.
 */
function mundo({ pspMs = 0, claimMs = 0, store = createMemoryStore() } = {}) {
  if (claimMs) {
    const orig = store.claimSlots.bind(store);
    store.claimSlots = async (a) => { await sleep(claimMs / 2); const r = await orig(a); await sleep(claimMs / 2); return r; };
  }
  const base = new MockPsp({ webhookSecret: SECRET });
  const psp = Object.create(base);
  if (pspMs) psp.createPixCharge = async (a) => { await sleep(pspMs); return base.createPixCharge(a); };
  const venue = store.seedVenue({ name: 'Boteco Teto', servicoBp: 1000 });
  const table = store.seedTable(venue.id, `Mesa ${Math.random()}`);
  return { store, psp, venue, table, charge: createChargeService({ store, psp }) };
}

// Conta grande: o teto medido é o de CONTAGEM, não o de VALOR.
const contaAberta = (store, table) => store.openCheck(table.qrToken, [{ id: 'i1', name: 'Rodízio', priceCents: 900000 }]);
const pendentes = async (store, checkId) => (await store.listPendingCharges({ checkId, limit: 99999 })).length;
// Valores DISTINTOS: repetidos colapsam no `txid` do mock e mediriam o mock.
const nova = (charge, checkId, i) => charge({ checkId, amountCents: 100 + i, tipCents: 0 });

describe('o número', () => {
  test('cabe a mesa inteira que o produto permite, com folga', () => {
    // A primeira versão era um palpite descrito como medida ("uma mesa de dez
    // pessoas") contra uma UI que divide entre VINTE. O teste prende a UI.
    const m = /Math\.min\((\d+), people \+ 1\)/.exec(ler('apps', 'web', 'src', 'App.tsx'));
    expect({ achou: !!m }).toEqual({ achou: true });
    // A derivação lê UM cliente. No dia em que o app iOS ganhar um fluxo de
    // pagamento com teto próprio de pessoas, o teto tem que ler o MAIOR dos
    // dois — este teste continuaria verde. (Revisão de segurança, LOW-5.)
    expect(Number(m[1])).toBe(MAX_PESSOAS_NA_DIVISAO);
    expect(TETO_PENDENTES).toBeGreaterThanOrEqual(3 * MAX_PESSOAS_NA_DIVISAO * TENTATIVAS_POR_PESSOA);
    expect(JANELA_VIVA_MS).toBe(15 * 60 * 1000);
  });

  test('a mesa cheia paga — vinte pessoas, três tentativas cada', async () => {
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < MAX_PESSOAS_NA_DIVISAO * TENTATIVAS_POR_PESSOA; i += 1) {
      await expect(nova(charge, check.id, i)).resolves.toBeTruthy();
    }
  });
});

describe('a recusa é uma resposta, não uma frase', () => {
  test('cheio: 429 com código estável e números crus, e o PSP nem é chamado', async () => {
    const { store, psp, table } = mundo();
    let chamadas = 0;
    const espiao = Object.create(psp);
    espiao.createPixCharge = async (a) => { chamadas += 1; return psp.createPixCharge(a); };
    const charge = createChargeService({ store, psp: espiao });
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES; i += 1) await nova(charge, check.id, i);
    const antes = chamadas;
    const err = await nova(charge, check.id, 99999).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 429, code: 'too_many_pending_charges', vars: { limit: TETO_PENDENTES } });
    // Sem prazo: com a janela deslizante a espera não tem fim, e `windowMinutes`
    // virava `Retry-After`. (Compliance, L2.)
    expect(err.vars.windowMinutes).toBeUndefined();
    expect(chamadas).toBe(antes);
  });

  test('toda chave de teto existe nas três línguas — até a PRÓXIMA chave, não 700 caracteres', () => {
    // A janela fixa vazava pras entradas vizinhas: apagar o `pt:` de uma chave
    // deixava as asserções verdes. (Revisão de segurança, LOW-2.)
    const i18n = ler('apps', 'web', 'src', 'i18n.ts');
    for (const codigo of ['too_many_pending_charges', 'too_many_pending_loads', 'too_many_pending_loads_venue',
      'payer_label_invalid', 'demo_busy']) {
      const ini = i18n.indexOf(`'err.${codigo}'`);
      expect({ codigo, existe: ini >= 0 }).toEqual({ codigo, existe: true });
      const fim = i18n.indexOf("\n  '", ini + 1);
      const bloco = i18n.slice(ini, fim === -1 ? undefined : fim);
      for (const l of ['en', 'pt', 'es']) expect({ codigo, l, tem: bloco.includes(`${l}:`) }).toEqual({ codigo, l, tem: true });
    }
  });
});

describe('o atacante que o teto existe pra parar', () => {
  test('rajada CONCORRENTE: exatamente o teto passa', async () => {
    const { store, table, charge } = mundo({ pspMs: 40 });
    const check = await contaAberta(store, table);
    const n = TETO_PENDENTES + 150;
    const rs = await Promise.allSettled(Array.from({ length: n }, (_, i) => nova(charge, check.id, i)));
    const criadas = rs.filter((r) => r.status === 'fulfilled').length;
    const recusadas = rs.filter((r) => r.status === 'rejected' && r.reason.code === 'too_many_pending_charges').length;
    expect({ criadas, recusadas }).toEqual({ criadas: TETO_PENDENTES, recusadas: n - TETO_PENDENTES });
    expect(await pendentes(store, check.id)).toBe(TETO_PENDENTES);
  });

  test('FLUXO com latência no banco e no PSP — a forma que furou a reserva em memória (214, 228)', async () => {
    const { store, table, charge } = mundo({ pspMs: 60, claimMs: 30 });
    const check = await contaAberta(store, table);
    const ps = [];
    for (let i = 0; i < TETO_PENDENTES + 150; i += 1) {
      const p = nova(charge, check.id, i); p.catch(() => {}); ps.push(p);
      await sleep(0.5);
    }
    const criadas = (await Promise.allSettled(ps)).filter((r) => r.status === 'fulfilled').length;
    expect(criadas).toBe(TETO_PENDENTES);
  });

  test('DUAS instâncias sobre o mesmo banco não somam tetos', async () => {
    // A forma anterior tinha estado de módulo por instância; com a reivindicação
    // no banco, "instância" não existe pro teto. Dois serviços, um store.
    const um = mundo({ pspMs: 20 });
    const outro = createChargeService({ store: um.store, psp: um.psp });
    const check = await contaAberta(um.store, um.table);
    const rs = await Promise.allSettled([
      ...Array.from({ length: 150 }, (_, i) => nova(um.charge, check.id, i)),
      ...Array.from({ length: 150 }, (_, i) => nova(outro, check.id, 1000 + i)),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(TETO_PENDENTES);
  });

  test('pedido INVÁLIDO não ocupa vaga — lixo do wi-fi do salão não tranca a mesa', async () => {
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES + 50; i += 1) {
      await expect(charge({ checkId: check.id, amountCents: -1 })).rejects.toMatchObject({ statusCode: 400 });
    }
    // Se o lixo tivesse ocupado alguma vaga, a última destas seria recusada.
    for (let i = 0; i < TETO_PENDENTES; i += 1) await expect(nova(charge, check.id, i)).resolves.toBeTruthy();
  });

  test('PSP que estoura GUARDA a vaga — depois de chamado, o adquirente pode ter criado algo', async () => {
    // Timeout e 5xx: a cobrança pode existir lá. Devolver a vaga aqui é o que
    // abria o laço sem fim (ver o teste do registro abaixo). O preço é que uma
    // noite instável do adquirente gasta vagas — e uma mesa legítima gasta
    // sessenta de duzentas, então cabe.
    const { store, psp, table } = mundo();
    const instavel = Object.create(psp);
    instavel.createPixCharge = async () => { throw new Error('gateway 502'); };
    const charge = createChargeService({ store, psp: instavel });
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES; i += 1) await expect(nova(charge, check.id, i)).rejects.toThrow('gateway 502');
    await expect(nova(charge, check.id, 9999)).rejects.toMatchObject({ code: 'too_many_pending_charges' });
    expect(TETO_PENDENTES).toBeGreaterThanOrEqual(3 * MAX_PESSOAS_NA_DIVISAO * TENTATIVAS_POR_PESSOA);
  });

  test('o registro estoura DEPOIS do PSP: a vaga FICA — senão o chamador controla o teto', async () => {
    /**
     * A PROPRIEDADE que faltava: todo pedido que CHEGA ao PSP ocupa uma vaga.
     *
     * A regra da rodada anterior devolvia a vaga quando o registro falhava, e
     * quem faz o registro falhar é o CHAMADOR: um rótulo com um NUL passa a
     * validação em JS e o Postgres recusa guardar (22P05). O store em memória
     * aceita o NUL — por isso nenhum teste via. A revisão de segurança
     * (stand-in) de 2026-09-15 mediu: mil pedidos, mil e uma cobranças na
     * Stripe, zero 429. Aqui o registro falha como o Postgres falharia.
     */
    const { store, psp, table } = mundo();
    let noPsp = 0;
    const contador = Object.create(psp);
    contador.createPixCharge = async (a) => { noPsp += 1; return psp.createPixCharge(a); };
    const charge = createChargeService({ store, psp: contador });
    const check = await contaAberta(store, table);
    store.registerCharge = async () => { const e = new Error('invalid byte sequence for encoding'); e.code = '22P05'; throw e; };
    // EM SÉRIE, não em rajada. Numa rajada as mil reivindicações acontecem
    // antes de qualquer devolução, e a regra furada passava VERDE — a prova de
    // mutação mostrou. O ataque medido é um laço: pede, o registro estoura, a
    // vaga volta, pede de novo.
    let peloTeto = 0;
    for (let i = 0; i < 1000; i += 1) {
      const r = await nova(charge, check.id, i).catch((e) => e);
      if (r && r.code === 'too_many_pending_charges') peloTeto += 1;
    }
    expect({ noPsp, peloTeto }).toEqual({ noPsp: TETO_PENDENTES, peloTeto: 1000 - TETO_PENDENTES });
  });

  /**
   * O QUE O POSTGRES NÃO GUARDA NÃO CHEGA NELE — e agora por LIMPEZA, não por
   * recusa.
   *
   * A versão anterior RECUSAVA o NUL, o tab e o DEL. O perigo que ela fechava
   * era real e está documentado logo acima: o Postgres recusa um NUL (22P05), o
   * registro estourava DEPOIS de a Stripe criar o intent, a vaga voltava, e mil
   * pedidos viravam mil e uma cobranças no adquirente com zero 429.
   *
   * Agora o rótulo passa pelo mesmo normalizador das palavras da casa
   * (segurança MEDIUM-3 de 2026-09-16: era o único texto livre de quem NÃO está
   * autenticado, e era o que tinha a regra mais fraca). O invisível é REMOVIDO
   * antes de chegar ao banco, então o 22P05 deixa de ser alcançável — o perigo
   * some pela raiz em vez de por um portão. E quem colou um caractere estranho
   * junto com o nome consegue pagar, em vez de levar um erro que não explica.
   *
   * O que CONTINUA recusado é o que não dá pra limpar: UTF-16 mal formado (um
   * surrogate solto, 22P02) e tamanho. Esses ainda precisam do código de erro.
   */
  test('o rótulo LIMPA o que o Postgres não guarda, e recusa o que não dá pra limpar', async () => {
    const { payerLabelValido, normalizarRotuloDoPagador } = require('../_lib/pay/create-charge');
    const C = String.fromCharCode;
    // O que é limpo e passa — com o valor que de fato vai pro banco.
    for (const [nome, v, valor] of [
      ['nome comum', 'Ana', 'Ana'],
      ['sessenta', 'x'.repeat(60), 'x'.repeat(60)],
      ['ausente', null, null],
      ['NUL', `x${C(0)}`, 'x'],
      ['tab vira espaço', `a${C(9)}b`, 'a b'],
      ['DEL', `x${C(127)}`, 'x'],
      ['largura-zero — o sósia da lista de pagantes', `Ana${C(0x200B)}`, 'Ana'],
      ['RLO', `${C(0x202E)}Ana`, 'Ana'],
      ['só invisível vira anônimo', C(0x200B).repeat(3), null],
    ]) expect({ nome, r: normalizarRotuloDoPagador(v) }).toEqual({ nome, r: { ok: true, valor } });

    // O que não dá pra limpar continua recusado.
    for (const [nome, v] of [
      ['sessenta e um', 'x'.repeat(61)],
      ['surrogate solto', C(0xD800)],
      ['não-string', 42],
    ]) expect({ nome, ok: payerLabelValido(v) }).toEqual({ nome, ok: false });

    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    // O trilho Pix respondia a frase interna em inglês, sem código. (Compliance, M1.)
    await expect(charge({ checkId: check.id, amountCents: 100, payerLabel: C(0xD800) }))
      .rejects.toMatchObject({ statusCode: 400, code: 'payer_label_invalid' });
  });

  test('e é o rótulo LIMPO que chega ao store — validar o cru e gravar o cru deixaria a limpeza inerte', async () => {
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    let visto;
    const registrar = store.registerCharge.bind(store);
    store.registerCharge = async (p) => { visto = p.payerLabel; return registrar(p); };
    await charge({ checkId: check.id, amountCents: 100, payerLabel: `Ana${String.fromCharCode(0x200B)}` });
    expect(visto).toBe('Ana');
  });

  test('a janela DESLIZA: passados quinze minutos a mesa volta a ter vaga', async () => {
    // Janela fixa deixava uma origem atravessar três janelas numa vida de
    // cobrança. Aqui cada vaga carrega o próprio instante.
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    const t0 = Date.now();
    const relogio = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      for (let i = 0; i < TETO_PENDENTES; i += 1) await nova(charge, check.id, i);
      await expect(nova(charge, check.id, 9000)).rejects.toMatchObject({ code: 'too_many_pending_charges' });
      relogio.mockReturnValue(t0 + JANELA_VIVA_MS - 1000);
      await expect(nova(charge, check.id, 9001)).rejects.toMatchObject({ code: 'too_many_pending_charges' });
      relogio.mockReturnValue(t0 + JANELA_VIVA_MS + 1000);
      await expect(nova(charge, check.id, 9002)).resolves.toBeTruthy();
    } finally {
      relogio.mockRestore();
    }
  });

  test('geração do QR NULA é recusada — nunca cai na chave sem geração', async () => {
    // A segunda guarda do token-array, na biblioteca, com teste PRÓPRIO: com as
    // duas no mesmo teste, apagar qualquer uma deixava o teste verde.
    const { assertChargeSlot } = require('../_lib/pay/create-charge');
    await expect(assertChargeSlot(createMemoryStore(), 'c1', null)).rejects.toMatchObject({ statusCode: 404, code: 'check_not_found' });
  });

  test('GIRAR O QR começa um balde novo NA HORA — o remédio do dono funciona', async () => {
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      await charge({ checkId: check.id, amountCents: 100 + i, qrGeneration: 'geracao-a' });
    }
    await expect(charge({ checkId: check.id, amountCents: 9000, qrGeneration: 'geracao-a' }))
      .rejects.toMatchObject({ code: 'too_many_pending_charges' });
    await expect(charge({ checkId: check.id, amountCents: 9001, qrGeneration: 'geracao-b' })).resolves.toBeTruthy();
  });

  test('ATAQUE SUSTENTADO: quem repõe cada vaga tranca a mesa por muito mais que quinze minutos', async () => {
    /**
     * O RESÍDUO, MEDIDO — e é por isso que a tela não promete prazo. A frase
     * anterior dizia "espere até 15 minutos", o censo de saída também, e as
     * duas revisões de 2026-09-15 mostraram que um script que retoma cada vaga
     * no instante em que ela vence mantém o balde cheio pelo tempo que quiser.
     * Aqui o atacante espalha duzentas cobranças numa janela e repõe uma a cada
     * 4,5 s; o cliente tenta a cada passo, por 45 minutos, e não passa nenhuma
     * vez. Girar o QR resolve na hora.
     */
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    const t0 = Date.now();
    const relogio = jest.spyOn(Date, 'now');
    const PASSO = 4500;
    let v = 0;
    try {
      for (let k = 0; k < TETO_PENDENTES; k += 1) {
        relogio.mockReturnValue(t0 + k * PASSO);
        await charge({ checkId: check.id, amountCents: 100 + (v += 1), qrGeneration: 'a' });
      }
      // O SCRIPT RETOMA TODA VAGA QUE VENCEU — tenta até ser recusado — e o
      // cliente chega no mesmo instante, depois dele: o script é mais rápido
      // que a pessoa. A primeira versão desta simulação dava ao atacante UM
      // pedido por passo, a +1 ms, e as reposições dele venciam exatamente no
      // +2 ms do cliente uma janela depois; deixava vagas que um script de
      // verdade não deixa, e o cliente "passava" 200 vezes. Era o teste
      // medindo o próprio relógio, não o ataque.
      let clientePassou = 0;
      for (let k = TETO_PENDENTES; k < TETO_PENDENTES + 600; k += 1) {
        relogio.mockReturnValue(t0 + k * PASSO);
        for (let tentativa = 0; tentativa < TETO_PENDENTES; tentativa += 1) {
          const pegou = await charge({ checkId: check.id, amountCents: 100 + (v += 1), qrGeneration: 'a' })
            .then(() => true, () => false);
          if (!pegou) break;
        }
        if (await charge({ checkId: check.id, amountCents: 4200 + (v += 1), qrGeneration: 'a' }).then(() => true, () => false)) clientePassou += 1;
      }
      expect({ minutos: Math.round((600 * PASSO) / 60000), clientePassou }).toEqual({ minutos: 45, clientePassou: 0 });
      // O remédio: o QR girado.
      await expect(charge({ checkId: check.id, amountCents: 99999, qrGeneration: 'b' })).resolves.toBeTruthy();
    } finally {
      relogio.mockRestore();
    }
  });

  test('o intent da Stripe confere o rótulo ANTES da vaga e ANTES da Stripe', () => {
    // Só o `registerCharge` conferia, depois de a Stripe criar o intent: um
    // rótulo longo gastava uma vaga e deixava um PaymentIntent órfão.
    // (Revisão de compliance de 2026-09-15, MEDIUM-1.)
    const ROUTER = ler('api', '_app', 'router.js');
    const ini = ROUTER.indexOf("url.pathname === '/api/pay/stripe-intent'");
    const rota = ROUTER.slice(ini, ROUTER.indexOf("url.pathname === '", ini + 30));
    const rotulo = rota.indexOf('payerLabelValido(b.payerLabel)');
    expect({ rotulo: rotulo > 0, antesDaVaga: rotulo < rota.indexOf('assertChargeSlot('),
      antesDaStripe: rotulo < rota.search(/stripePsp\.create[A-Z]/) })
      .toEqual({ rotulo: true, antesDaVaga: true, antesDaStripe: true });
  });

  test('ponta a ponta no router: corpos inválidos e depois um cliente de verdade paga', async () => {
    // A camada por origem da forma anterior contava ANTES da validação: 90
    // corpos lixo do mesmo IP trancavam quem estava no wi-fi. Sem camada em
    // memória, este teste existe pra que ela não volte sem ninguém ver.
    const { route, store } = require('../_app/router');
    const venue = store.seedVenue({ name: 'Rota', servicoBp: 1000, pspRecipientId: 'rcpt_r' });
    const table = store.seedTable(venue.id, 'M1');
    await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 900000 }]);
    const srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const porta = srv.address().port;
    const pagar = (corpo) => fetch(`http://127.0.0.1:${porta}/api/pay`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '189.10.20.30' },
      body: JSON.stringify({ token: table.qrToken, ...corpo }),
    });
    try {
      for (let i = 0; i < 120; i += 1) expect((await pagar({ amountCents: -1 })).status).toBe(400);
      const r = await pagar({ amountCents: 4200, tipCents: 0 });
      expect(r.status).toBe(200);
    } finally {
      srv.close();
    }
  });
});

describe('cargas de saldo — por conta e por casa, com códigos diferentes', () => {
  const TETO_CARGAS = 10;
  function casa() {
    const store = createMemoryStore();
    const psp = new MockPsp({ webhookSecret: SECRET });
    const house = createHouseService({ store, psp, now: () => new Date().toISOString() });
    return { store, house };
  }
  async function casaAberta(store, house) {
    const venue = store.seedVenue({ name: 'Bar Casa', servicoBp: 1000, pspRecipientId: 'rcpt_c' });
    await house.updateConfig(venue.id, { enabled: true, bonusBp: 0, validityDays: 30 });
    return { venue, table: store.seedTable(venue.id, 'Mesa 1') };
  }
  const conta = async (house, table, n) => (await house.openAccount({
    tableQrToken: table.qrToken, phone: `1198${String(n).padStart(7, '0')}`, name: `C${n}`,
  })).accountToken;

  test('por CONTA: dez, e a décima primeira leva o código da conta', async () => {
    const { store, house } = casa();
    const { table } = await casaAberta(store, house);
    const t = await conta(house, table, 1);
    // Por conta o prazo é verdadeiro: só o dono da carteira enche este balde.
    for (let i = 0; i < TETO_CARGAS; i += 1) await house.createLoad({ accountToken: t, amountCents: 10000 + i });
    await expect(house.createLoad({ accountToken: t, amountCents: 20000 }))
      .rejects.toMatchObject({ statusCode: 429, code: 'too_many_pending_loads', vars: { limit: TETO_CARGAS, windowMinutes: 15 } });
  });

  test('por CASA: contas novas não furam, e a recusa tem código PRÓPRIO', async () => {
    // Conta de saldo é de graça (telefone sem verificação); por isso o teto
    // por casa. E quem lê a recusa por casa não tem recarga aberta nenhuma —
    // a frase da conta ("pague uma das que já gerou") seria remédio impossível.
    const { store, house } = casa();
    const { table } = await casaAberta(store, house);
    let criadas = 0; let recusa = null;
    for (let c = 0; c < 25 && !recusa; c += 1) {
      const t = await conta(house, table, c);
      for (let i = 0; i < TETO_CARGAS && !recusa; i += 1) {
        try { await house.createLoad({ accountToken: t, amountCents: 10000 + i }); criadas += 1; } catch (e) { recusa = e; }
      }
    }
    expect(criadas).toBe(200);
    expect(recusa).toMatchObject({ statusCode: 429, code: 'too_many_pending_loads_venue', vars: { limit: 200 } });
  });

  test('conta E casa cheias: sai a recusa da CASA, a sem prazo', async () => {
    // Na ordem inversa a pessoa lia "tente em até 15 minutos", esperava, e
    // recebia a recusa da casa. (Compliance, L4.)
    const { store, house } = casa();
    const { venue, table } = await casaAberta(store, house);
    const tokens = [];
    for (let c = 0; c < 20; c += 1) {
      const t = await conta(house, table, c); tokens.push(t);
      for (let i = 0; i < TETO_CARGAS; i += 1) await house.createLoad({ accountToken: t, amountCents: 10000 + i });
    }
    const recusa = await house.createLoad({ accountToken: tokens[0], amountCents: 30000 }).catch((e) => e);
    expect(recusa).toMatchObject({ code: 'too_many_pending_loads_venue', vars: { limit: 200 } });
    expect(recusa.vars.windowMinutes).toBeUndefined();
    expect(recusa.venueId).toBe(venue.id);
  });

  test('rajada CONCORRENTE de cargas não passa do teto da conta', async () => {
    const { store, house } = casa();
    const { table } = await casaAberta(store, house);
    const t = await conta(house, table, 7);
    const rs = await Promise.allSettled(Array.from({ length: 40 }, (_, i) =>
      house.createLoad({ accountToken: t, amountCents: 10000 + i })));
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(TETO_CARGAS);
  });
});

describe('TODA criação de cobrança passa pelo teto', () => {
  /**
   * O censo de chamadores anda a ÁRVORE INTEIRA de `api/`, casa o nome do
   * método em QUALQUER forma de chamada (ponto, colchete com aspas, `.call`,
   * quebra de linha antes do parêntese, desestruturação) e conta EXATO. A
   * primeira versão lia três arquivos fixos, com o receptor na regex e folga de
   * dois no sentinela. (Revisão de segurança, MEDIUM-2 e LOW-1.)
   */
  const RAIZ_API = path.join(__dirname, '..');
  const ADAPTADORES = /_lib\/pay\/(mock|pagarme|stripe)-psp\.js$/;
  const semComentario = (src) => src.split('\n').map((l) => l.replace(/\/\*.*?\*\//g, ''))
    .filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
  const arquivos = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else if (e.name.endsWith('.js')) arquivos.push(full);
    }
  }(RAIZ_API));
  const chamadores = arquivos.filter((f) => !ADAPTADORES.test(f.replace(/\\/g, '/')));
  /**
   * O que conta é USO, definido pela forma e não por uma lista de exceções:
   * acesso por PONTO ao método (chamada, `.call`, `Reflect.apply`, quebra de
   * linha antes do parêntese), acesso por COLCHETE com o nome entre aspas,
   * despacho por variável que de fato INVOCA, e desestruturação a partir de um
   * objeto. Ficam de fora sem regra própria: a chave de objeto que DEFINE o
   * método (o stub do PSP ausente no router), a sonda `typeof psp[x]` e o nome
   * solto numa string que escolhe o método. Uma lista de exceções escrita a
   * partir dos dois primeiros casos achados seria a forma que estas revisões
   * pegam toda rodada.
   */
  const CRIA = new RegExp([
    String.raw`\.create[A-Z]\w*Charge\b`,
    String.raw`\[\s*['"]create[A-Z]\w*Charge['"]\s*\]`,
    String.raw`\b\w*[pP]sp\s*\[\s*\w+\s*\]\s*(?:\(|\.call\b|\.apply\b)`,
    String.raw`\{[^}]*\bcreate[A-Z]\w*Charge\b[^}]*\}\s*=`,
  ].join('|'));
  const sitios = [];
  for (const f of chamadores) {
    const linhas = semComentario(fs.readFileSync(f, 'utf8')).split('\n');
    linhas.forEach((l, i) => {
      if (!CRIA.test(l) || /\bcreateChargeService\b/.test(l)) return;
      const antes = linhas.slice(Math.max(0, i - 60), i).join('\n');
      sitios.push({ onde: `${path.relative(RAIZ_API, f)}:${i + 1}  ${l.trim().slice(0, 60)}`,
        comTeto: /assertChargeSlot\(|assertLoadSlot\(/.test(antes) });
    });
  }

  test('todo sítio que cria cobrança reivindica vaga antes', () => {
    expect(sitios.filter((x) => !x.comTeto).map((x) => x.onde)).toEqual([]);
  });

  test('o censo acha EXATAMENTE os sítios de hoje', () => {
    // Três na fábrica (Pix, carteira, Bizum), dois no intent da Stripe, um na
    // carga de saldo. Mudou? Leia o sítio novo antes de mudar o número.
    expect(sitios.map((x) => x.onde)).toHaveLength(6);
  });

  test('o casador vê as formas que a revisão achou invisíveis', () => {
    for (const forma of [
      'await pagarme.createPixCharge({ a: 1 })', "await psp['createPixCharge']({})",
      'await psp.createPixCharge.call(psp, {})', 'const { createWalletCharge } = psp;',
      'await stripePsp[metodo]({})', 'await demoPsp[m]({})',
    ]) expect({ forma, vista: CRIA.test(forma) }).toEqual({ forma, vista: true });
    // E o que NÃO é uso não pode contar — senão o sentinela exato vira ruído e
    // alguém o afrouxa. Os três vêm do código de hoje.
    for (const naoUso of [
      'createPixCharge: indisponivel,', "if (typeof psp[creator] !== 'function') {",
      "const creator = wallet ? 'createWalletCharge' : rail === 'bizum' ? 'createBizumCharge' : 'createPixCharge';",
    ]) expect({ naoUso, vista: CRIA.test(naoUso) }).toEqual({ naoUso, vista: false });
    expect(chamadores.some((f) => f.includes(`${path.sep}_lib${path.sep}`))).toBe(true);
  });
});

describe('os dois stores e o SQL dizem a mesma coisa', () => {
  // SEM COMENTÁRIO: com a trava comentada (`-- perform pg_advisory…`) a regex
  // ainda casava, e os 26 testes ficavam verdes sobre uma RPC sem trava.
  // (Revisão de segurança de 2026-09-15, MEDIUM-1.)
  const SQL = ler('supabase', 'migrations', '0033_charge_slots.sql').replace(/--[^\n]*/g, '');
  const SUP = ler('api', '_lib', 'store', 'supabase.js');
  const MEM = ler('api', '_lib', 'store', 'memory.js');

  test('os dois stores implementam a reivindicação e a devolução', () => {
    for (const m of ['claimSlots', 'releaseSlots', 'slotsFingerprint']) {
      expect({ m, memoria: MEM.includes(`async ${m}(`), supabase: SUP.includes(`async ${m}(`) })
        .toEqual({ m, memoria: true, supabase: true });
    }
  });

  test('a RPC conta e reserva sob TRAVA, com janela DESLIZANTE, e nasce fechada', () => {
    expect(SQL).toMatch(/pg_advisory_xact_lock\(/);
    // A faxina cruzada fechava ciclo de trava sem isto (364 deadlocks medidos).
    expect(SQL).toMatch(/limit 500\s+for update skip locked/);
    // Limite nulo concedia sem fim (`v_n >= null` é null).
    expect(SQL).toMatch(/array_position\(p_limits, null\) is not null/);
    // E o expurgo diário varre o livro.
    expect(SQL).toMatch(/function public\.purge_expired_personal_data[\s\S]*delete from public\.charge_slots/);
    // Pela janela DE CADA LINHA: um corte fixo zerava o contador diário de avisos.
    expect(SQL).toMatch(/where created_at < now\(\) - make_interval\(secs => window_seconds\)/);
    expect(SQL).toMatch(/insert into charge_slots \(claim_id, slot_key, window_seconds\)/);
    expect(SQL).toMatch(/revoke all on function public\.charge_slots_fingerprint\(\) from public, anon, authenticated/);
    expect(SQL).toMatch(/created_at >= now\(\) - make_interval\(secs => p_window_seconds\)/);
    expect(SQL).toMatch(/alter table public\.charge_slots enable row level security/);
    expect(SQL).toMatch(/revoke all on public\.charge_slots from anon, authenticated/);
    expect(SQL).toMatch(/revoke all on function public\.claim_slots\(text\[\], integer\[\], integer\) from public, anon, authenticated/);
    expect(SQL).toMatch(/revoke all on function public\.release_slots\(uuid\) from public, anon, authenticated/);
  });

  test('o deploy confere TUDO antes do push, e prova a VERSÃO da 0033 no banco de PRODUÇÃO', () => {
    // A primeira versão sondava `release_slots` — que existe igual na 0033
    // anterior —, num banco que vinha do `.env` e nunca era comparado com o de
    // produção, DEPOIS de já ter feito o push. (As duas revisões.)
    const DEPLOY = ler('scripts', 'deploy.mjs');
    const push = DEPLOY.indexOf("'push', 'origin', 'HEAD:main'");
    const sonda = DEPLOY.indexOf('/rest/v1/rpc/charge_slots_fingerprint');
    const segredo = DEPLOY.indexOf("e.key === 'RACHA_NOTIFY_SECRET'");
    const host = DEPLOY.indexOf('hostProducao !== hostSondado');
    expect({ sonda: sonda > 0, segredo: segredo > 0, host: host > 0 }).toEqual({ sonda: true, segredo: true, host: true });
    expect(Math.max(sonda, segredo, host)).toBeLessThan(push);
    expect(push).toBeLessThan(DEPLOY.indexOf('/v13/deployments?teamId='));
    // E a loja e o adquirente de verdade, antes do push (auditoria de backend C1).
    const loja = DEPLOY.indexOf("['RACHA_STORE', 'supabase']");
    expect({ loja: loja > 0 && loja < push, psp: DEPLOY.includes("['RACHA_PSP', 'pagarme']") }).toEqual({ loja: true, psp: true });
    // Só a versão ATUAL tem esta impressão — o TEXTO das funções, não um
    // comportamento escolhido a dedo que a versão anterior também tinha: a
    // sonda do limite nulo passou sobre a 0033 velha (segurança M2 de 7a65e93).
    expect(DEPLOY).toMatch(/impressaoSondada !== IMPRESSAO_0033/);
    expect(DEPLOY).toMatch(/from '\.\.\/api\/_lib\/store\/impressao-0033\.js'/);
  });

  test('o cron de quinze minutos compara a IMPRESSÃO da 0033 em produção, depois do segredo', () => {
    const ROUTER = ler('api', '_app', 'router.js');
    const ini = ROUTER.indexOf("url.pathname === '/api/cron/reconcile-pending'");
    const rota = ROUTER.slice(ini, ROUTER.indexOf("url.pathname === '", ini + 30));
    const sonda = rota.indexOf('await store.slotsFingerprint()');
    expect(sonda).toBeGreaterThan(rota.indexOf('segredoConfere('));
    expect(rota).toMatch(/if \(impressao !== IMPRESSAO_0033\)/);
    expect(rota.indexOf('notifyFounderReconcile(', sonda)).toBeGreaterThan(sonda);
  });

  test('os nomes e parâmetros que o store manda são os que a RPC recebe', () => {
    expect(SUP).toMatch(/rpc\('claim_slots', \{\s*p_keys: keys, p_limits: limits, p_window_seconds:/);
    expect(SUP).toMatch(/rpc\('release_slots', \{ p_claim_id: claimId \}\)/);
    expect(SQL).toMatch(/function public\.claim_slots\(\s*p_keys text\[\],\s*p_limits integer\[\],\s*p_window_seconds integer\s*\)/);
    expect(SQL).toMatch(/function public\.release_slots\(p_claim_id uuid\)/);
  });

  test('o gêmeo em memória decide como o SQL: para na PRIMEIRA chave cheia, índice base zero', async () => {
    const s = createMemoryStore();
    await s.claimSlots({ keys: ['b'], limits: [1], windowMs: 60_000 });
    const r = await s.claimSlots({ keys: ['a', 'b', 'c'], limits: [5, 1, 5], windowMs: 60_000 });
    expect(r).toEqual({ claimId: null, fullIndex: 1, counts: [0, 1] });
    await expect(s.claimSlots({ keys: ['x', 'x'], limits: [1, 1], windowMs: 60_000 })).rejects.toThrow('repetida');
  });
});

describe('o store Supabase falha FECHADO sem a RPC', () => {
  /**
   * A ordem de deploy é MIGRAÇÃO PRIMEIRO. Sem a `claim_slots`, a PostgREST
   * devolve erro (PGRST202) — e o que o store faz com isso decide se um
   * deploy fora de ordem vira "ninguém paga" (fechado, alto) ou "todo mundo
   * cobra sem teto" (aberto, calado). O inegociável #7 escolhe o primeiro: a
   * guarda que degrada aberta mascarou doze dias de falha na Seatable.
   */
  const { createSupabaseStore } = require('../_lib/store/supabase');
  const comRpc = (resposta) => createSupabaseStore({
    url: 'http://falso', serviceRoleKey: 'x', client: { rpc: async () => resposta, from: () => ({}) },
  });
  const ARGS = { keys: ['check:c1'], limits: [200], windowMs: JANELA_VIVA_MS };

  test('erro da RPC (migração não aplicada) → estoura, não passa', async () => {
    const s = comRpc({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.claim_slots' } });
    await expect(s.claimSlots(ARGS)).rejects.toThrow();
  });

  test('resposta sem `claim_id` → estoura, não passa', async () => {
    const s = comRpc({ data: { ok: true }, error: null });
    await expect(s.claimSlots(ARGS)).rejects.toThrow('claim_id');
  });

  test('cheio e com vaga são lidos como o SQL escreve', async () => {
    await expect(comRpc({ data: { claim_id: null, full_index: 0, counts: [200] }, error: null }).claimSlots(ARGS))
      .resolves.toEqual({ claimId: null, fullIndex: 0, counts: [200] });
    await expect(comRpc({ data: { claim_id: 'u1', full_index: null, counts: [3] }, error: null }).claimSlots(ARGS))
      .resolves.toEqual({ claimId: 'u1', fullIndex: null, counts: [3] });
  });

  test('a janela vai em SEGUNDOS pra RPC, que recusa menos de um minuto', async () => {
    let enviado = null;
    const s = createSupabaseStore({ url: 'http://falso', serviceRoleKey: 'x',
      client: { rpc: async (nome, args) => { enviado = { nome, args }; return { data: { claim_id: 'u', full_index: null, counts: [0] }, error: null }; }, from: () => ({}) } });
    await s.claimSlots(ARGS);
    expect(enviado).toEqual({ nome: 'claim_slots', args: { p_keys: ['check:c1'], p_limits: [200], p_window_seconds: 900 } });
  });
});

describe('o teto disparado PAGINA o operador — uma vez por conta e janela', () => {
  test('três recusas seguidas, um aviso só, e a recusa sai do mesmo jeito', async () => {
    // Uma mesa legítima não chega ao teto: o 429 dele é ataque, e o remédio
    // (girar o QR) só existe se alguém souber. Deduplicado NO BANCO — estado de
    // módulo daria um aviso por instância.
    const segredo = process.env.RACHA_NOTIFY_SECRET;
    delete process.env.RACHA_NOTIFY_SECRET;   // sem ponte: o aviso vai pro stderr
    const { route, store } = require('../_app/router');
    const venue = store.seedVenue({ name: 'Alerta', servicoBp: 1000, pspRecipientId: 'rcpt_al' });
    const table = store.seedTable(venue.id, 'M1');
    await store.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 900000 }]);
    const srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const porta = srv.address().port;
    let v = 0;
    const pagar = () => fetch(`http://127.0.0.1:${porta}/api/pay`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: table.qrToken, amountCents: 100 + (v += 1), tipCents: 0 }),
    });
    const avisos = () => process.stderr.write.mock.calls
      .filter(([t]) => String(t).includes('TETO DE COBRANÇAS DISPAROU')).length;
    try {
      for (let i = 0; i < TETO_PENDENTES; i += 1) expect((await pagar()).status).toBe(200);
      const antes = avisos();
      for (let i = 0; i < 3; i += 1) expect((await pagar()).status).toBe(429);
      expect(avisos() - antes).toBe(1);
    } finally {
      srv.close();
      if (segredo !== undefined) process.env.RACHA_NOTIFY_SECRET = segredo;
    }
  });
});

describe('dentro dos adaptadores: só os três métodos criam cobrança no adquirente', () => {
  /**
   * O censo de chamadores reconhece a criação de cobrança pelo NOME do método
   * e pula os adaptadores. Um método novo — o "link de checkout de cartão" que
   * o CLAUDE.md lista na interface do PSP — que postasse `/orders` seria
   * invisível, e o chamador dele também. (Revisão de segurança, LOW-2.)
   */
  test('toda criação no adquirente mora num create(Pix|Wallet|Bizum)Charge — quatro, exatas', () => {
    const achados = [];
    for (const arq of ['pagarme-psp.js', 'stripe-psp.js']) {
      const linhas = ler('api', '_lib', 'pay', arq).split('\n');
      linhas.forEach((l, i) => {
        if (!/api\('POST', '\/orders'|paymentIntents\.create\(|checkout\.sessions\.create\(|\bcharges\.create\(/.test(l)) return;
        let metodo = null;
        for (let k = i; k >= 0 && !metodo; k -= 1) {
          const m = /^\s*async\s+(\w+)\s*\(/.exec(linhas[k]);
          if (m) metodo = m[1];
        }
        achados.push(`${arq}:${i + 1} ${metodo}`);
      });
    }
    expect(achados.filter((a) => !/ create(Pix|Wallet|Bizum)Charge$/.test(a))).toEqual([]);
    expect(achados).toHaveLength(4);
  });
});

describe('pelo router: demo, token, rotação, e o aviso que sai DEPOIS da recusa', () => {
  const { route, store: lojaDoRouter } = require('../_app/router');
  let porta; let srv;
  beforeAll(async () => {
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv && srv.close());
  // Sem segredo da ponte o aviso vai pro stderr, que é onde estes testes o leem.
  beforeAll(() => { delete process.env.RACHA_NOTIFY_SECRET; });
  const CONTA = [{ id: 'i', name: 'X', priceCents: 900000 }];
  // ENCHE o balde da conta direto no store: duzentas idas HTTP por teste
  // mediriam o router, não o aviso.
  const encher = async (token) => {
    const view = await lojaDoRouter.getCheckByQrToken(token);
    const chave = `check:${view.check.id}:${geracaoDoQr(token)}`;
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      await lojaDoRouter.claimSlots({ keys: [chave], limits: [TETO_PENDENTES], windowMs: JANELA_VIVA_MS });
    }
    return view.check.id;
  };
  const linhas = (frase) => process.stderr.write.mock.calls.filter(([t]) => String(t).includes(frase)).length;
  // O relógio que os testes de recuo adiantam. O store e o router leem `Date.now`.
  const adiantavel = () => {
    const real = Date.now.bind(Date);
    const r = { desloc: 0 };
    r.spy = jest.spyOn(Date, 'now').mockImplementation(() => real() + r.desloc);
    return r;
  };
  let v = 0;
  const pagar = (token, ip, extra = {}) => fetch(`http://127.0.0.1:${porta}/api/pay`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ token, amountCents: 1 + (v += 1), tipCents: 0, ...extra }),
  });
  const avisos = () => process.stderr.write.mock.calls
    .filter(([t]) => String(t).includes('TETO DE COBRANÇAS DISPAROU'));

  test('a DEMO é pública: limitada por origem, e NUNCA pagina o fundador', async () => {
    // O token dela está no link da landing, ela cobra a partir de um centavo e
    // se confirma sozinha: duzentas cobranças paginavam o fundador, e um
    // `/api/demo/reset` abria uma chave de alerta nova. (As duas revisões.)
    expect((await fetch(`http://127.0.0.1:${porta}/api/check?t=demoracha`)).status).toBe(200);
    const antes = avisos().length;
    const st = {};
    for (let ip = 0; ip < 8; ip += 1) {
      for (let i = 0; i < 31; i += 1) {
        const r = await pagar('demoracha', `10.77.0.${ip}`);
        const b = r.status === 429 ? (await r.json()).code : r.status;
        st[b] = (st[b] || 0) + 1;
      }
    }
    expect(st.demo_busy).toBeGreaterThan(0);                 // o limite por origem morde
    expect(st.too_many_pending_charges).toBeGreaterThan(0); // e o teto da conta também
    expect(avisos().length - antes).toBe(0);                // mas a demo não pagina
  });

  test('token que não é string é 404 — a PostgREST o resolveria e ele ganharia um segundo balde', async () => {
    const venue = lojaDoRouter.seedVenue({ name: 'Array', servicoBp: 1000, pspRecipientId: 'rcpt_arr' });
    const table = lojaDoRouter.seedTable(venue.id, 'M1');
    await lojaDoRouter.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 900000 }]);
    // O ROUTER RECUSA ANTES DE CONSULTAR O STORE. O `Map` do gêmeo em memória
    // não acha uma chave-array — devolveria 404 de qualquer jeito, e a guarda
    // passaria verde sem existir (a prova de mutação mostrou). Quem resolve o
    // array é a PostgREST, que interpola o valor no filtro. Então a prova é a
    // ORDEM: nenhum token que não seja string pode chegar ao store.
    const chamadas = [];
    const orig = lojaDoRouter.getCheckByQrToken.bind(lojaDoRouter);
    lojaDoRouter.getCheckByQrToken = async (t) => { chamadas.push(t); return orig(t); };
    try {
      const r = await pagar([table.qrToken], '10.78.0.1');
      expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 404, code: 'check_not_found' });
      expect(chamadas.filter((t) => typeof t !== 'string')).toEqual([]);
    } finally {
      lojaDoRouter.getCheckByQrToken = orig;
    }
  });

  test('GIRAR O QR pelo store libera a mesa na hora, pelo router', async () => {
    const venue = lojaDoRouter.seedVenue({ name: 'Giro', servicoBp: 1000, pspRecipientId: 'rcpt_giro' });
    const table = lojaDoRouter.seedTable(venue.id, 'M7');
    await lojaDoRouter.openCheck(table.qrToken, [{ id: 'i', name: 'X', priceCents: 900000 }]);
    for (let i = 0; i < TETO_PENDENTES; i += 1) expect((await pagar(table.qrToken, `10.79.${i % 250}.1`)).status).toBe(200);
    expect((await pagar(table.qrToken, '10.79.9.9')).status).toBe(429);
    const girado = await lojaDoRouter.rotateTableQr(table.id);
    expect((await pagar(girado.qrToken, '10.79.9.9')).status).toBe(200);
  });

  test('a recusa e o aviso passam por `responderEAvisar` nos dois catches — e o aviso só é chamado LÁ DENTRO', () => {
    // Esperar o aviso segurava o 429 até oito segundos (segurança stand-in,
    // LOW-2); sem `waitUntil`, depois da resposta a Vercel pode congelar a função
    // (as duas revisões de 7a65e93); e sem contexto de requisição o `waitUntil`
    // do pacote não faz nada (segurança L-A de 3a10835). A ordem mora num lugar só.
    const R = ler('api', '_app', 'router.js');
    for (const chamada of [
      'await responderEAvisar(() => json(res, status, errorBody(err, status), cabecalhoDeEspera(err)), err);',
      'await responderEAvisar(() => json(res, errorStatus(e), errorBody(e), cabecalhoDeEspera(e)), e);',
    ]) expect({ chamada, existe: R.includes(chamada) }).toEqual({ chamada, existe: true });
    const chamadas = R.split('\n').map((l) => l.trim())
      .filter((l) => /avisarTetoDisparado\(/.test(l) && !/^(\/\/|\*)/.test(l) && !/function avisarTetoDisparado/.test(l));
    expect(chamadas).toEqual(['await avisarTetoDisparado(err);', 'await depoisDaResposta(avisarTetoDisparado(err));']);
    const ini = R.indexOf('async function responderEAvisar(');
    const corpo = R.slice(ini, R.indexOf('\n}\n', ini));
    for (const c of chamadas) expect(corpo).toContain(c);
    // Com a espera garantida, a resposta sai ANTES do aviso.
    expect(corpo.lastIndexOf('enviar();')).toBeLessThan(corpo.indexOf('await depoisDaResposta('));
  });

  test('o rótulo do aviso: só letra LATINA, dígito ASCII e pouca pontuação — nada invisível, nada sósia', () => {
    // Uma varredura de pontos de código achou o que a lista anterior deixava
    // passar. (Segurança L-C de 3a10835.)
    const { rotuloDoAviso } = require('../_app/router');
    expect(rotuloDoAviso('ㅤᅟᅠﾠ')).toBe('?');           // letras INVISÍVEIS do hangul
    expect(rotuloDoAviso('evil٠comノpix')).toBe('evil com pix');   // sósias de ponto e barra
    expect(rotuloDoAviso('evil۰comᐧx')).toBe('evil com x');
    expect(rotuloDoAviso('Ze️\u{E0100}͏')).toBe('Ze');            // seletores de variação e o CGJ
    expect([...rotuloDoAviso('a' + '́'.repeat(39))]).toEqual(['á']);  // enxurrada de marcas
    expect(rotuloDoAviso('Zé Bar & Grill (Centro) #2 - Mesa 7')).toBe('Zé Bar & Grill (Centro) #2 - Mesa 7');
    expect(rotuloDoAviso('Açaí da Praça · Varanda')).toBe('Açaí da Praça Varanda');
    expect(rotuloDoAviso(null)).toBe('?');
    // Dentro da escrita latina também há sósias: ponto do meio, dois-pontos
    // sobrescrito, `ǃ`, `ǀ`, largura cheia, numerais romanos. (LOW-5 de 40d5c50.)
    expect(rotuloDoAviso('evilꞏcom')).toBe('evil com');
    expect(rotuloDoAviso('a\u{10781}b')).toBe('a b');
    expect(rotuloDoAviso('Zé ǃǀ ｅｖｉｌ Ⅻ')).toBe('Zé');
  });

  test('o aviso nomeia CONTA, CASA e MESA — nessa ordem — e avisa os dois custos do remédio', async () => {
    const venue = lojaDoRouter.seedVenue({ name: 'Bar do Aviso', servicoBp: 1000, pspRecipientId: 'rcpt_av' });
    const table = lojaDoRouter.seedTable(venue.id, 'Varanda 3');
    await lojaDoRouter.openCheck(table.qrToken, CONTA);
    const checkId = await encher(table.qrToken);
    const antes = avisos().length;
    expect((await pagar(table.qrToken, '10.80.9.9')).status).toBe(429);
    const novos = avisos().slice(antes);
    expect(novos).toHaveLength(1);
    const m = String(novos[0][0]);
    expect(m).toContain(`conta ${checkId} · casa Bar do Aviso · mesa Varanda 3. `);
    expect(m).toMatch(/perde a tela de confirmação/);
    // E o que a compliance de 7a65e93 achou faltando: o código antigo ainda cobra.
    expect(m).toMatch(/ainda podem cair — Pix por até 15 minutos, cartão ainda em confirmação talvez depois/);
    // E o que a compliance de 40d5c50 achou prometido e não entregue: o que cai
    // depois de fechar agora FICA marcado na mesa.
    expect(m).toMatch(/fica marcado na mesa/);
  });

  test('nome e rótulo são TEXTO DO DONO no pager do fundador: sem link, sem quebra, quarenta caracteres', async () => {
    const venue = lojaDoRouter.seedVenue({ name: 'Zé\nURGENTE: acesse https://evil.example/login', servicoBp: 1000, pspRecipientId: 'rcpt_txt' });
    const table = lojaDoRouter.seedTable(venue.id, 'M1 — www.x.io/pix?c=1 '.repeat(4));
    await lojaDoRouter.openCheck(table.qrToken, CONTA);
    await encher(table.qrToken);
    const antes = avisos().length;
    expect((await pagar(table.qrToken, '10.84.0.1')).status).toBe(429);
    const novos = avisos().slice(antes);
    expect(novos).toHaveLength(1);
    const m = String(novos[0][0]);
    const trechoCasa = m.slice(m.indexOf(' · casa ') + 8, m.indexOf(' · mesa '));
    const trechoMesa = m.slice(m.indexOf(' · mesa ') + 8, m.indexOf('. Uma mesa legítima'));
    for (const parte of [trechoCasa, trechoMesa]) {
      expect({ parte, limpa: parte.length > 0 && !/[\n\r:/.]/.test(parte) && [...parte].length <= 40 })
        .toEqual({ parte, limpa: true });
    }
    expect(trechoCasa.startsWith('Zé URGENTE acesse')).toBe(true);   // letras e acentos ficam
    expect(m).not.toMatch(/https?:\/\/|www\./);
  });

});
