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
const {
  createChargeService, assertChargeSlot, TETO_PENDENTES, TETO_POR_ORIGEM, JANELA_VIVA_MS,
  MAX_PESSOAS_NA_DIVISAO, TENTATIVAS_POR_PESSOA,
} = require('../_lib/pay/create-charge');
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
  test('o teto é DERIVADO do passo a passo da divisão, não escolhido', () => {
    /**
     * A PRIMEIRA VERSÃO DESTE NÚMERO ERA UM PALPITE que se descrevia como
     * medida: "o pior caso legítimo é uma mesa de dez pessoas". O produto
     * afere VINTE — o passo a passo da divisão para em `Math.min(20, …)` —,
     * e com teto vinte uma mesa cheia consumia todas as vagas em primeira
     * tentativa. A primeira pessoa que precisasse de um segundo código (tirou
     * o serviço, a tela dormiu, o wi-fi engoliu o pedido) não conseguia pagar
     * a própria conta. Achado pela revisão de compliance de 2026-09-15.
     *
     * Este teste PRENDE a derivação à UI: se o passo a passo passar a dividir
     * entre trinta, ele falha e alguém decide o teto de novo, em vez de
     * descobrir na mesa.
     */
    const app = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'App.tsx'), 'utf8');
    const m = /Math\.min\((\d+), people \+ 1\)/.exec(app);
    expect({ achou: !!m }).toEqual({ achou: true });
    // A derivação lê UM cliente. O app iOS já chama `GET /api/check`; no dia
    // em que ganhar um fluxo de pagamento com teto próprio de pessoas, este
    // número deixa de ser derivado e este teste continua verde. Se isso
    // acontecer, o teto tem que ler o MAIOR dos dois. Apontado pela revisão
    // de segurança de 2026-09-15 (LOW-5).
    expect({ passoAPassoDoApp: Number(m[1]), derivacao: MAX_PESSOAS_NA_DIVISAO })
      .toEqual({ passoAPassoDoApp: MAX_PESSOAS_NA_DIVISAO, derivacao: MAX_PESSOAS_NA_DIVISAO });
    // A camada POR ORIGEM é a derivada: uma mesa cheia, três tentativas cada,
    // mais metade pelas tentativas que os outros portões recusam.
    expect(TETO_POR_ORIGEM).toBe((MAX_PESSOAS_NA_DIVISAO * TENTATIVAS_POR_PESSOA * 3) / 2);
    // E a POR CONTA tem que ficar acima do que UMA origem cria numa janela
    // viva: o balde de dez minutos pode virar uma vez em quinze, então uma
    // origem cria até o DOBRO do seu teto. Se a conta couber nisso, uma origem
    // só volta a trancar a mesa — que é o HIGH-1 da revisão de segurança.
    expect(TETO_PENDENTES).toBeGreaterThan(2 * TETO_POR_ORIGEM);
    expect(JANELA_VIVA_MS).toBe(15 * 60 * 1000);
  });

  test('a mesa CHEIA que o produto permite cabe, com folga de tentativas', async () => {
    // O caso que a revisão achou: vinte pessoas, divisão igual, todas pagam.
    // Nenhuma pode levar 429 na primeira tentativa, nem na segunda.
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    for (let i = 0; i < MAX_PESSOAS_NA_DIVISAO * 2; i += 1) {
      await expect(charge({ checkId: check.id, amountCents: 100 + i, tipCents: 0 }))
        .resolves.toBeTruthy();
    }
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
      // ATÉ A PRÓXIMA CHAVE, não 700 caracteres. A janela fixa vazava pras
      // entradas seguintes do dicionário: apagar o `pt:` desta chave deixava
      // as seis asserções verdes, porque o `pt:` da vizinha estava dentro da
      // janela. Achado pela revisão de segurança de 2026-09-15 (LOW-2).
      const ini = i18n.indexOf(`'err.${codigo}'`);
      expect(ini).toBeGreaterThanOrEqual(0);
      const fim = i18n.indexOf("\n  '", ini + 1);
      const bloco = i18n.slice(ini, fim === -1 ? undefined : fim);
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

describe('o teto AMARRA contra o atacante que ele existe pra parar', () => {
  /**
   * A primeira versão só era testada do ponto de vista de quem PAGA: todo caso
   * esperava cada cobrança antes da próxima. A revisão de segurança de
   * 2026-09-15 disparou trezentas em paralelo contra um PSP com latência e viu
   * trezentas criadas e zero recusadas — a janela entre ler e gravar é uma ida
   * inteira ao adquirente. Estes testes fazem o que o atacante faz.
   */
  function mundoLento(latMs) {
    const store = createMemoryStore();
    const base = new MockPsp({ webhookSecret: SECRET });
    const psp = Object.create(base);
    psp.createPixCharge = async (a) => {
      await new Promise((r) => setTimeout(r, latMs));
      return base.createPixCharge(a);
    };
    const venue = store.seedVenue({ name: 'Boteco Lento', servicoBp: 1000 });
    const table = store.seedTable(venue.id, 'Mesa 1');
    return { store, psp, table, charge: createChargeService({ store, psp }) };
  }

  test('uma rajada CONCORRENTE não passa do teto', async () => {
    const { store, table, charge } = mundoLento(40);
    const check = await contaAberta(store, table);
    const n = TETO_PENDENTES + 100;
    const rs = await Promise.allSettled(Array.from({ length: n }, (_, i) =>
      charge({ checkId: check.id, amountCents: 100 + i, tipCents: 0 })));
    const criadas = rs.filter((r) => r.status === 'fulfilled').length;
    const recusadas = rs.filter((r) => r.status === 'rejected' && r.reason.code === 'too_many_pending_charges').length;
    expect({ criadas, recusadas }).toEqual({ criadas: TETO_PENDENTES, recusadas: n - TETO_PENDENTES });
    // E o que ficou no banco é o que foi criado — a reserva não vazou.
    expect(await store.countPendingCharges({ checkId: check.id, windowMs: JANELA_VIVA_MS }))
      .toBe(TETO_PENDENTES);
  });

  test('uma cobrança que ESTOURA no PSP devolve a vaga', async () => {
    // Sem o `finally`, cada falha do adquirente vazaria uma reserva, e uma
    // noite de instabilidade da Pagar.me trancaria mesas que não criaram nada.
    const { store, psp, table } = mundo();
    const check = await contaAberta(store, table);
    let falhas = 0;
    const instavel = Object.create(psp);
    instavel.createPixCharge = async (a) => {
      if (falhas < TETO_PENDENTES) { falhas += 1; throw new Error('gateway 502'); }
      return psp.createPixCharge(a);
    };
    const charge = createChargeService({ store, psp: instavel });
    for (let i = 0; i < TETO_PENDENTES; i += 1) {
      await expect(charge({ checkId: check.id, amountCents: 100 + i })).rejects.toThrow('gateway 502');
    }
    await expect(charge({ checkId: check.id, amountCents: 9999 })).resolves.toBeTruthy();
  });

  test('a contagem do teto NÃO esconde as linhas mais novas', async () => {
    // O `listPendingCharges` serve a conciliação e tem um limite superior de
    // idade (`graceMs`) que esconde de propósito o que acabou de nascer. A
    // contagem do teto é outra pergunta: a linha de agora conta.
    const { store, table, charge } = mundo();
    const check = await contaAberta(store, table);
    await charge({ checkId: check.id, amountCents: 100 });
    expect(await store.countPendingCharges({ checkId: check.id, windowMs: JANELA_VIVA_MS })).toBe(1);
    expect((await store.listPendingCharges({ checkId: check.id, graceMs: 20_000 })).length).toBe(0);
  });
});

describe('TODA criação de cobrança passa pelo teto', () => {
  /**
   * O CENSO DE CHAMADORES, e a primeira versão dele tinha três cegueiras que
   * se somavam — todas medidas pela revisão de segurança de 2026-09-15
   * (MEDIUM-2):
   *
   *  · lista FIXA de três arquivos. A refatoração que o quebra é a que qualquer
   *    um chamaria de limpeza: tirar o handler do intent da Stripe do router
   *    de 2200 linhas pra um módulo próprio. Os dois testes ficavam verdes e o
   *    teto sumia do trilho Stripe. O `markets.test.js` já tinha um
   *    caminhador de árvore inteira pra exatamente isto, trezentas linhas
   *    adiante;
   *  · o nome do RECEPTOR na regex: `pagarme.`, `adapter.`, `demoPsp.` e
   *    `psp[creator](` eram invisíveis;
   *  · o sentinela contava `>= 4` com seis sítios reais — duas de folga, que é
   *    exatamente o que o trilho Stripe contribui.
   *
   * Agora: árvore inteira de `api/`, qualquer receptor, um curinga pra trilho
   * que ainda não existe (`create*Charge`), e contagem EXATA — sítio novo obriga
   * a uma decisão, em vez de caber na folga.
   */
  const RAIZ_API = path.join(__dirname, '..');
  const ADAPTADORES = /_lib\/pay\/(mock|pagarme|stripe)-psp\.js$/;
  const semComentario = (src) => src.split('\n')
    .filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
  const arquivos = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) arquivos.push(full);
    }
  }(RAIZ_API));
  // Os adaptadores DEFINEM os métodos; quem os CHAMA precisa do teto.
  const chamadores = arquivos.filter((f) => !ADAPTADORES.test(f.replace(/\\/g, '/')));
  const CRIA = /\.create[A-Z]\w*Charge\s*\(|\bpsp\s*\[\s*\w+\s*\]\s*\(/;

  const sitios = [];
  for (const f of chamadores) {
    const linhas = semComentario(fs.readFileSync(f, 'utf8')).split('\n');
    linhas.forEach((l, i) => {
      if (!CRIA.test(l)) return;
      const antes = linhas.slice(Math.max(0, i - 60), i).join('\n');
      sitios.push({
        onde: `${path.relative(RAIZ_API, f)}:${i + 1}  ${l.trim().slice(0, 50)}`,
        comTeto: /assertChargeSlot\(|assertLoadSlot\(/.test(antes),
      });
    });
  }

  test('todo sítio que cria cobrança confere vaga antes', () => {
    expect(sitios.filter((x) => !x.comTeto).map((x) => x.onde)).toEqual([]);
  });

  test('o censo acha EXATAMENTE os sítios de hoje — sítio novo é decisão, não folga', () => {
    // Seis: três na fábrica (Pix, carteira, Bizum), dois no intent da Stripe
    // (Bizum, carteira), um na carga de saldo. Mudou? Leia o sítio novo antes
    // de mudar o número.
    expect(sitios.map((x) => x.onde)).toHaveLength(6);
  });

  test('a caminhada é da árvore inteira, não de uma lista de arquivos', () => {
    // Um arquivo-isca fora dos três conhecidos, com uma cobrança sem teto,
    // tem que ser VISTO. Sem isto a lista fixa pode voltar em silêncio.
    const isca = "async function x(psp) { return pagarme.createPixCharge({ a: 1 }); }\n";
    expect(CRIA.test(isca)).toBe(true);
    expect(chamadores.length).toBeGreaterThan(10);
    expect(chamadores.some((f) => f.includes(`${path.sep}_lib${path.sep}`))).toBe(true);
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

  const TETO_CARGAS = 10;

  test('deixa passar até o teto e recusa a seguinte, com código estável', async () => {
    const { store, house } = casa();
    const accountToken = await contaDeSaldo(store, house);
    for (let i = 0; i < TETO_CARGAS; i += 1) {
      await house.createLoad({ accountToken, amountCents: 10000 + i });
    }
    await expect(house.createLoad({ accountToken, amountCents: 20000 }))
      .rejects.toMatchObject({ statusCode: 429, code: 'too_many_pending_loads' });
  });

  test('carga CONFIRMADA não ocupa vaga', async () => {
    const { store, house } = casa();
    const accountToken = await contaDeSaldo(store, house);
    const feitas = [];
    for (let i = 0; i < TETO_CARGAS; i += 1) {
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
    for (let i = 0; i < TETO_CARGAS; i += 1) {
      await house.createLoad({ accountToken, amountCents: 10000 + i });
    }
    // O id vem do store, não da projeção da carteira: a carteira é a VISTA do
    // cliente e não promete expor a chave primária.
    const conta = await store.getHouseAccountByToken(accountToken);
    const todas = await store.countPendingHouseLoads({ accountId: conta.id, windowMs: Infinity });
    const nenhuma = await store.countPendingHouseLoads({ accountId: conta.id, windowMs: -1 });
    expect({ todas, nenhuma }).toEqual({ todas: TETO_CARGAS, nenhuma: 0 });
  });

  test('o teto POR CASA amarra mesmo com contas novas — conta é de graça', async () => {
    // `openAccount` aceita qualquer telefone de 10 a 13 dígitos sem
    // verificação. Um teto só por conta era um teto sobre nada.
    const { store, house } = casa();
    const venue = store.seedVenue({ name: 'Bar Casa', servicoBp: 1000, pspRecipientId: 'rcpt_c' });
    await house.updateConfig(venue.id, { enabled: true, bonusBp: 0, validityDays: 30 });
    const table = store.seedTable(venue.id, 'Mesa 1');
    let criadas = 0; let recusa = null;
    for (let conta = 0; conta < 25 && !recusa; conta += 1) {
      const { accountToken } = await house.openAccount({
        tableQrToken: table.qrToken, phone: `1198${String(conta).padStart(7, '0')}`, name: `C${conta}`,
      });
      for (let i = 0; i < TETO_CARGAS && !recusa; i += 1) {
        try { await house.createLoad({ accountToken, amountCents: 10000 + i }); criadas += 1; }
        catch (e) { recusa = e; }
      }
    }
    expect(criadas).toBe(200);
    expect(recusa).toMatchObject({ statusCode: 429, code: 'too_many_pending_loads', vars: { limit: 200 } });
  });

  test('os DOIS stores implementam a contagem — o gêmeo não pode ficar pra trás', () => {
    // Um teto que só existe no store de memória é um teto que não existe: quem
    // roda em produção é o Supabase. Mesma disciplina do `store-contract`.
    const mem = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', 'memory.js'), 'utf8');
    const sup = fs.readFileSync(path.join(__dirname, '..', '_lib', 'store', 'supabase.js'), 'utf8');
    for (const metodo of ['countPendingHouseLoads', 'countPendingCharges']) {
      expect({ metodo, memoria: mem.includes(`async ${metodo}(`) }).toEqual({ metodo, memoria: true });
      expect({ metodo, supabase: sup.includes(`async ${metodo}(`) }).toEqual({ metodo, supabase: true });
    }
    // O teto por CASA precisa do filtro por venue nos DOIS.
    expect(mem).toMatch(/countPendingHouseLoads\(\{[^}]*venueId/);
    expect(sup).toMatch(/countPendingHouseLoads\(\{[^}]*venueId/);
    // E a janela tem que ser aplicada nos dois, senão um conta vencidas.
    expect(mem).toMatch(/countPendingHouseLoads[\s\S]{0,600}windowMs/);
    expect(sup).toMatch(/countPendingHouseLoads[\s\S]{0,600}windowMs/);
  });
});

describe('a camada POR ORIGEM está nas duas rotas que cobram conta', () => {
  // A mesma forma "chamador esquecido": duas rotas, uma regra.
  const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  test.each(['/api/pay', '/api/pay/stripe-intent'])('%s', (rota) => {
    const ini = ROUTER.indexOf(`url.pathname === '${rota}'`);
    expect(ini).toBeGreaterThan(0);
    const fim = ROUTER.indexOf("url.pathname === '", ini + 20);
    expect(ROUTER.slice(ini, fim)).toMatch(/exigeVagaDaOrigem\(req, view\.check\.id\)/);
  });
});
