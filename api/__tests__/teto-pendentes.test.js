'use strict';

/**
 * O TETO DE COBRANÇAS PENDENTES VIVAS.
 *
 * O portão de dinheiro tinha teto de VALOR (`amount_over`) e nenhum de
 * CONTAGEM. `remainingCents` é `totalCents - paidCents`, `paidCents` conta
 * evento CONFIRMADO, e o `registerCharge` grava linha pendente sem lançar
 * evento — então N cobranças pendentes podiam ser cada uma pelo valor INTEIRO
 * que falta. E o `chargeRef`, apesar de determinístico, não é idempotência no
 * adquirente: quem deriva o `txid` dele é o MockPsp, e é por isso que os testes
 * antigos NÃO viam o problema. A Pagar.me o recebe como referência de
 * comerciante, sem cabeçalho de idempotência, com e-mail único por chamada.
 *
 * Um chamador com um token de mesa — que viaja em QR fotografado e em link
 * compartilhado — emitia BR Codes de 15 minutos sem limite, cada um pelo valor
 * cheio da conta. Achado pela revisão de segurança de 2026-09-15 (HIGH-4).
 *
 * Estes testes VARIAM o valor de propósito: repetir o mesmo pedido colapsa no
 * mock (mesmo `chargeRef`, mesmo `txid`) e mediria o mock, não o teto.
 */

const fs = require('node:fs');
const path = require('node:path');

const { MockPsp } = require('../_lib/pay/mock-psp');
const { createChargeService, assertChargeSlot, TETO_PENDENTES, JANELA_VIVA_MS } = require('../_lib/pay/create-charge');
const { createMemoryStore } = require('../_lib/store/memory');

const SECRET = 'test-webhook-secret-0123456789';

function mundo() {
  const store = createMemoryStore();
  const psp = new MockPsp({ webhookSecret: SECRET });
  const venue = store.seedVenue({ name: 'Boteco Teto', servicoBp: 1000 });
  const table = store.seedTable(venue.id, 'Mesa 9');
  return { store, psp, venue, table, charge: createChargeService({ store, psp }) };
}

async function contaAberta(store, table) {
  // Conta grande: o teto que se está medindo é o de CONTAGEM, e uma conta
  // pequena bateria no de VALOR primeiro e mediria a outra guarda.
  return store.openCheck(table.qrToken, [{ id: 'i1', name: 'Rodízio', priceCents: 500000 }]);
}

describe('o teto de cobranças pendentes vivas por conta', () => {
  test('o teto e a janela são os números que a prosa diz', () => {
    expect(TETO_PENDENTES).toBe(20);
    expect(JANELA_VIVA_MS).toBe(15 * 60 * 1000);
  });

  test('deixa passar até o teto e recusa a seguinte, com código estável', async () => {
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      // Valor VARIÁVEL: mesmo pedido colapsaria no `txid` derivado do mock.
      await charge({ checkId: check.id, amountCents: 100 + i, tipCents: 0 });
    }
    expect((await store.listPendingCharges({ checkId: check.id, limit: 999 })).length)
      .toBe(TETO_PENDENTES);
    await expect(charge({ checkId: check.id, amountCents: 999, tipCents: 0 }))
      .rejects.toMatchObject({ statusCode: 429, code: 'too_many_pending_charges' });
  });

  test('o erro leva os NÚMEROS crus, nunca a frase — quem escreve é o cliente', async () => {
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      await charge({ checkId: check.id, amountCents: 100 + i, tipCents: 0 });
    }
    const err = await charge({ checkId: check.id, amountCents: 999 }).catch((e) => e);
    expect(err.vars).toEqual({ limit: TETO_PENDENTES, windowMinutes: 15 });
    // E a chave existe nas TRÊS línguas — servidor manda código, cliente traduz.
    const i18n = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
    for (const codigo of ['too_many_pending_charges', 'too_many_pending_loads']) {
      const bloco = i18n.slice(i18n.indexOf(`'err.${codigo}'`), i18n.indexOf(`'err.${codigo}'`) + 700);
      expect(bloco).toMatch(/en:/); expect(bloco).toMatch(/pt:/); expect(bloco).toMatch(/es:/);
    }
  });

  test('NÃO fala com o adquirente quando o teto fecha', async () => {
    // O ponto inteiro do teto: a chamada não sai. Um teto conferido DEPOIS da
    // cobrança criada é contar o estrago, não impedi-lo.
    const { store, psp, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      await charge({ checkId: check.id, amountCents: 100 + i, tipCents: 0 });
    }
    let chamou = false;
    // `Object.create`, não espalhamento: o adaptador é uma CLASSE, e `{...psp}`
    // copia só as propriedades próprias — o portão de mercado perde os métodos
    // do protótipo e a cobrança morre com `psp_market_mismatch`, que é outro
    // erro e mediria outra guarda.
    const espiao = Object.create(psp);
    espiao.createPixCharge = async (...a) => { chamou = true; return psp.createPixCharge(...a); };
    const comEspiao = createChargeService({ store, psp: espiao });
    await expect(comEspiao({ checkId: check.id, amountCents: 999 })).rejects.toMatchObject({ code: 'too_many_pending_charges' });
    expect(chamou).toBe(false);
  });

  test('cobrança VENCIDA não ocupa vaga — a mesa não fica trancada a noite toda', async () => {
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      await charge({ checkId: check.id, amountCents: 100 + i, tipCents: 0 });
    }
    // Envelhece as vivas para além da validade do Pix.
    // `getPayment` devolve a linha viva do store em memória — envelhecer aqui
    // é o equivalente honesto de esperar quinze minutos.
    const velho = new Date(Date.now() - JANELA_VIVA_MS - 60_000).toISOString();
    for (const p of await store.listPendingCharges({ checkId: check.id, limit: 999 })) {
      (await store.getPayment(p.txid)).createdAt = velho;
    }
    await expect(charge({ checkId: check.id, amountCents: 999, tipCents: 0 })).resolves.toBeTruthy();
  });

  test('cobrança CONFIRMADA não ocupa vaga', async () => {
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    const feitas = [];
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      feitas.push(await charge({ checkId: check.id, amountCents: 100 + i, tipCents: 0 }));
    }
    (await store.getPayment(feitas[0].txid)).status = 'confirmado';
    await expect(charge({ checkId: check.id, amountCents: 999, tipCents: 0 })).resolves.toBeTruthy();
  });

  test('o teto é POR CONTA: outra mesa não herda o bloqueio', async () => {
    const { store, venue, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      await charge({ checkId: check.id, amountCents: 100 + i, tipCents: 0 });
    }
    const outra = store.seedTable(venue.id, 'Mesa 10');
    const check2 = await contaAberta(store, outra);
    await expect(charge({ checkId: check2.id, amountCents: 100, tipCents: 0 })).resolves.toBeTruthy();
  });
});

describe('TODA criação de cobrança passa pelo teto', () => {
  /**
   * O CENSO DE CHAMADORES, porque há DOIS sítios que criam cobrança de conta:
   * o `create-charge` e a `/api/pay/stripe-intent`, que monta a cobrança
   * sozinha. A forma "chamador esquecido" já custou o portão de mercado e a
   * validação do `payerLabel` nesta mesma rota — duas vezes. Um teto que só
   * vale num dos dois trilhos não é um teto.
   */
  const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const FABRICA = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', 'create-charge.js'), 'utf8');
  const CASA = fs.readFileSync(path.join(__dirname, '..', '_lib', 'house', 'house-service.js'), 'utf8');

  const semComentario = (src) => src.split('\n')
    .filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');

  test('todo sítio que chama create*Charge confere vaga antes', () => {
    const CRIA = /\b(?:psp|stripePsp)\.create(?:Pix|Wallet|Bizum)Charge\s*\(/;
    const alvos = { 'router.js': ROUTER, 'create-charge.js': FABRICA, 'house-service.js': CASA };
    const semTeto = [];
    for (const [nome, src] of Object.entries(alvos)) {
      const linhas = semComentario(src).split('\n');
      for (let i = 0; i < linhas.length; i += 1) {
        if (!CRIA.test(linhas[i])) continue;
        // A vaga é conferida ANTES, na mesma função: janela generosa de 60
        // linhas acima, que é mais que qualquer corpo de rota daqui.
        const antes = linhas.slice(Math.max(0, i - 60), i).join('\n');
        if (!/assertChargeSlot\(|countPendingHouseLoads\(/.test(antes)) {
          semTeto.push(`${nome}:${i + 1}  ${linhas[i].trim().slice(0, 50)}`);
        }
      }
    }
    expect(semTeto).toEqual([]);
  });

  test('a enumeração ACHA os sítios — censo que não vê nada dá ✓ calado', () => {
    const CRIA = /\b(?:psp|stripePsp)\.create(?:Pix|Wallet|Bizum)Charge\s*\(/g;
    const total = [ROUTER, FABRICA, CASA]
      .map((s) => (semComentario(s).match(CRIA) || []).length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(4);
  });
});

/**
 * E O TETO DAS CARGAS DE SALDO.
 *
 * O `/api/house/load` é a mais exposta das três rotas que criam cobrança, e a
 * declaração do censo de saída diz por quê: não passa pela fábrica, então não
 * herda teto de valor nenhum, e não há conta aberta pra limitar o valor —
 * carga de saldo não tem conta. O `chargeRef` dela leva um `randomUUID` DE
 * PROPÓSITO, com um comentário dizendo que duas cargas idênticas são cobranças
 * diferentes: nem nominalmente havia idempotência aqui.
 */
describe('o teto de cargas de saldo vivas por conta', () => {
  const { createWebhookHandler } = require('../_lib/pay/webhook-handler');
  const { createHouseService } = require('../_lib/house/house-service');

  function casa() {
    const store = createMemoryStore();
    const psp = new MockPsp({ webhookSecret: SECRET });
    const house = createHouseService({ store, psp, now: () => new Date().toISOString() });
    createWebhookHandler({
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      psp,
      fallback: (p) => house.confirmLoadFromWebhook(p),
    });
    return { store, psp, house };
  }

  async function contaDeSaldo(store, house) {
    const venue = store.seedVenue({ name: 'Bar Teto', servicoBp: 1000, pspRecipientId: 'rcpt_t' });
    await house.updateConfig(venue.id, { enabled: true, bonusBp: 1500, validityDays: 30 });
    const table = store.seedTable(venue.id, 'Mesa 1');
    const { accountToken } = await house.openAccount({
      tableQrToken: table.qrToken, phone: '11987654321', name: 'Ana',
    });
    return accountToken;
  }

  test('deixa passar até cinco e recusa a sexta, com código estável', async () => {
    const { store, house } = casa();
    const accountToken = await contaDeSaldo(store, house);
    for (let i = 0; i < 5; i += 1) {
      await house.createLoad({ accountToken, amountCents: 10000 + i });
    }
    await expect(house.createLoad({ accountToken, amountCents: 20000 }))
      .rejects.toMatchObject({ statusCode: 429, code: 'too_many_pending_loads' });
  });

  test('carga CONFIRMADA não ocupa vaga', async () => {
    const { store, house } = casa();
    const accountToken = await contaDeSaldo(store, house);
    const feitas = [];
    for (let i = 0; i < 5; i += 1) {
      feitas.push(await house.createLoad({ accountToken, amountCents: 10000 + i }));
    }
    await expect(house.createLoad({ accountToken, amountCents: 30000 }))
      .rejects.toMatchObject({ code: 'too_many_pending_loads' });
    await store.confirmHouseLoad({ txid: feitas[0].txid, confirmedAt: new Date().toISOString() });
    await expect(house.createLoad({ accountToken, amountCents: 30001 })).resolves.toBeTruthy();
  });

  test('a JANELA é carregada — carga vencida não ocupa vaga', async () => {
    /**
     * Sem viagem no tempo: o `findHouseLoadByTxid` do store em memória devolve
     * uma CÓPIA (diferente do `getPayment`, que devolve a linha viva), então
     * envelhecer a linha por fora não é possível — e inventar um acessor de
     * teste só pra isto seria abrir superfície pra medir uma coisa que a
     * própria contagem já sabe responder. A janela é medida onde ela mora: uma
     * janela negativa não alcança carga nenhuma, uma infinita alcança todas. Se
     * o parâmetro deixar de ser aplicado, os dois números viram iguais.
     */
    const { store, house } = casa();
    const accountToken = await contaDeSaldo(store, house);
    for (let i = 0; i < 5; i += 1) {
      await house.createLoad({ accountToken, amountCents: 10000 + i });
    }
    // O id vem do store, não da projeção da carteira: a carteira é a VISTA do
    // cliente e não promete expor a chave primária.
    const conta = await store.getHouseAccountByToken(accountToken);
    const todas = await store.countPendingHouseLoads({ accountId: conta.id, windowMs: Infinity });
    const nenhuma = await store.countPendingHouseLoads({ accountId: conta.id, windowMs: -1 });
    expect({ todas, nenhuma }).toEqual({ todas: 5, nenhuma: 0 });
  });

  test('os DOIS stores implementam a contagem — o gêmeo não pode ficar pra trás', () => {
    // Um teto que só existe no store de memória é um teto que não existe: quem
    // roda em produção é o Supabase. Mesma disciplina do `store-contract`.
    const mem = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', 'memory.js'), 'utf8');
    const sup = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', 'supabase.js'), 'utf8');
    expect(mem).toContain('async countPendingHouseLoads(');
    expect(sup).toContain('async countPendingHouseLoads(');
    // E a janela tem que ser aplicada nos dois, senão um conta vencidas.
    expect(mem).toMatch(/countPendingHouseLoads[\s\S]{0,600}windowMs/);
    expect(sup).toMatch(/countPendingHouseLoads[\s\S]{0,600}windowMs/);
  });
});
