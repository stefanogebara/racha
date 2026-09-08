'use strict';

/**
 * O FUNIL DE ADOÇÃO — o primeiro degrau, que não era medido.
 *
 * O portão do CLAUDE.md governa o roteiro: as casas-piloto precisam mostrar
 * ≥25% das contas migrando na semana 8, ou o produto para. Sete semanas depois
 * da primeira casa, o banco sabia dizer quantas contas o RESTAURANTE digitou e
 * quantas foram pagas — e nada sobre quantas pessoas viram a tela.
 *
 * Com isso, dois mundos opostos davam o mesmo relatório: "40 escanearam e 1
 * pagou" (problema de produto) e "ninguém escaneou" (problema de distribuição).
 * Eles pedem correções opostas, e um portão que não os distingue não é um
 * portão.
 *
 * A telemetria que existia media vendas: `sendBeacon` só dispara com `?pl=` na
 * URL, o token de prospecção da Olímpia.
 */

const { createMemoryStore } = require('../_lib/store/memory');

async function casaComMesa() {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Beira Mar', servicoBp: 900, pspRecipientId: 're_x' });
  const table = await store.seedTable(venue.id, 'Mesa 13');
  return { store, venue, table };
}

describe('quem ABRIU a conta na mesa', () => {
  test('conta uma vez por telefone, não uma vez por consulta', async () => {
    // O app consulta a conta a cada 4 segundos. Contar leitura seria contar
    // polling em vez de gente.
    const { store, venue, table } = await casaComMesa();
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    const abrir = (sessao) => store.recordCheckView({
      checkId: check.id, venueId: venue.id, tableId: table.id, sessionHash: sessao,
    });
    expect(await abrir('telefone-a')).toBe(true);
    expect(await abrir('telefone-a')).toBe(false);   // mesma aba, de novo
    expect(await abrir('telefone-b')).toBe(true);    // outra pessoa na mesa

    const f = await store.getAdoptionFunnel(venue.id, {});
    expect(f.contasAbertasNaMesa).toBe(1);           // uma CONTA, dois telefones
  });

  test('o funil separa "ninguém viu" de "viram e não pagaram"', async () => {
    const { store, venue, table } = await casaComMesa();

    // Conta A: o restaurante digitou o total e ninguém abriu no telefone.
    await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    let f = await store.getAdoptionFunnel(venue.id, {});
    expect(f.contasCriadas).toBe(1);
    expect(f.contasAbertasNaMesa).toBe(0);
    // Sem denominador não há taxa — e inventar 0% aqui diria "o produto perde
    // gente" quando o que houve foi ninguém chegar nele.
    expect(f.conversao).toBeNull();
  });

  test('viram e NÃO pagaram: aí sim é 0%, e isso é sobre o produto', async () => {
    const { store, venue, table } = await casaComMesa();
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    await store.recordCheckView({
      checkId: check.id, venueId: venue.id, tableId: table.id, sessionHash: 'telefone-a',
    });
    const f = await store.getAdoptionFunnel(venue.id, {});
    expect(f.contasAbertasNaMesa).toBe(1);
    expect(f.contasPagas).toBe(0);
    expect(f.conversao).toBe(0);
  });

  test('viram e pagaram: a conversão que o portão pede', async () => {
    const { store, venue, table } = await casaComMesa();
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    await store.recordCheckView({
      checkId: check.id, venueId: venue.id, tableId: table.id, sessionHash: 'telefone-a',
    });
    await store.registerCharge({
      checkId: check.id, txid: 'ch_1', amountCents: 5000, tipCents: 0, method: 'pix',
    });
    await store.recordPayment({ txid: 'ch_1', status: 'confirmado', confirmedAt: new Date().toISOString() });
    const f = await store.getAdoptionFunnel(venue.id, {});
    expect(f.conversao).toBe(1);
  });

  test('a janela é respeitada — o portão é da semana, não da vida da casa', async () => {
    const { store, venue, table } = await casaComMesa();
    const check = await store.openCheck(table.qrToken, [{ id: 'i', name: 'Total', priceCents: 5000 }]);
    await store.recordCheckView({
      checkId: check.id, venueId: venue.id, tableId: table.id, sessionHash: 'telefone-a',
    });
    const daquiUmMes = new Date(Date.now() + 30 * 86400000).toISOString();
    const f = await store.getAdoptionFunnel(venue.id, { sinceIso: daquiUmMes });
    expect(f.contasAbertasNaMesa).toBe(0);
  });
});

describe('a rota registra e nunca atrapalha quem paga', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const rota = src.slice(src.indexOf("url.pathname === '/api/check/opened'"), src.indexOf("url.pathname === '/api/demo/beacon'"));

  test('sempre 200 — telemetria não pode espelhar falha na tela de pagar', () => {
    expect(rota).toMatch(/json\(res, 200/);
    expect(rota).not.toMatch(/json\(res, [45]\d\d/);
  });

  test('tem limite de taxa: é rota pública e sem auth', () => {
    expect(rota).toMatch(/rateLimitDemo\(req\)/);
  });

  test('exige uma sessão com tamanho mínimo — sem ela não conta', () => {
    expect(rota).toMatch(/sessao\.length >= 8/);
  });

  test('e o cliente dispara pra mesa REAL, não só pra link de prospecção', () => {
    const app = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/'\/api\/check\/opened'/);
    // O de vendas continua existindo e continua dependendo do `pl` — são dois
    // instrumentos diferentes medindo coisas diferentes.
    expect(app).toMatch(/if \(!prospectPl\) return;/);
  });
});
