'use strict';

/**
 * O CARTÃO FOI CAPTURADO E A LINHA NÃO FOI ESCRITA.
 *
 * No trilho de carteira o `createWalletCharge` captura dentro da chamada
 * (Pagar.me v5 captura por padrão) e a linha de `payments` só é escrita depois.
 * Se essa escrita falha — o banco ganhou prazo de 10 s em 2026-09-16, então
 * isso deixou de ser hipotético — o dinheiro saiu e não há onde pendurá-lo.
 *
 * O que a revisão de compliance mediu (HIGH-1 de 2026-09-16) e o que este
 * arquivo prende:
 *
 *  1. O erro subia como 500 `internal`, o cliente lia "algo deu errado, tente
 *     de novo" e o botão do Google Pay continuava ARMADO. Tocar de novo cobra
 *     o cartão outra vez (CDC art. 42).
 *  2. Sem linha de `payments`, o `charge.paid` que chega depois era 409 e o
 *     adquirente desistia: a captura ficava invisível pra conciliação, que
 *     trabalha a partir das NOSSAS linhas.
 *
 * Os dois lados são medidos aqui: a resposta ao cliente, e o desfecho do
 * webhook que chega depois.
 */

const { createChargeService } = require('../_lib/pay/create-charge');
const { applyConfirmedPayment, NON_LEDGER_KINDS } = require('../_lib/pay/webhook-handler');
const { createMemoryStore } = require('../_lib/store/memory');

const ITENS = [{ id: 'i', name: 'Prato', priceCents: 10000 }];

async function mundo({ falharGravacao = 0 } = {}) {
  const store = createMemoryStore();
  const venue = await store.seedVenue({ name: 'Bar', servicoBp: 1000, pspRecipientId: 're_x' });
  const table = await store.seedTable(venue.id, 'Mesa 1');
  const check = await store.openCheck(table.qrToken, ITENS);

  /**
   * Quantas vezes o adquirente foi chamado. `capturas` é só a CARTEIRA — é ela
   * que captura dentro da chamada; o Pix devolve um BR Code que o pagador ainda
   * vai autorizar no app do banco, e nada saiu.
   */
  const capturas = [];
  const pixCriados = [];
  const psp = {
    /**
     * O DUBLÊ DECLARA QUEM ELE É.
     *
     * Ele modela a Pagar.me — é o único adaptador cujo `createWalletCharge`
     * CAPTURA dentro da chamada, que é a premissa inteira destes testes. Sem
     * o `provider`, o `capturou` (que passou a vir do adaptador e não do nome
     * do trilho) o lia como um PSP que não captura, e os testes exigiam
     * `charge_maybe_captured` de um dublê que dizia não ter capturado nada.
     *
     * Um dublê que não declara o que é prova o dublê, não a regra.
     */
    provider: 'pagarme',
    // E declara a CAPACIDADE, não só o nome: a `createWalletCharge` da Pagar.me
    // captura dentro da chamada, que é a premissa inteira destes testes.
    walletCaptures: true,
    currencies: ['brl'],
    async createWalletCharge({ chargeRef }) {
      capturas.push(chargeRef);
      return { txid: `ch_${capturas.length}` };
    },
    async createPixCharge({ chargeRef }) {
      pixCriados.push(chargeRef);
      return {
        txid: `px_${pixCriados.length}`,
        copiaECola: '000201…',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      };
    },
  };

  let restam = falharGravacao;
  const original = store.registerCharge.bind(store);
  store.registerCharge = async (p) => {
    if (restam > 0) {
      restam -= 1;
      // A FORMA do erro do store de produção: `throwOn` não anexa `pgCode` numa
      // falha de transporte (o `code` do postgrest nasce vazio). É o que um
      // prazo estourado entrega.
      throw new Error('supabase store registerCharge: AbortError: This operation was aborted');
    }
    return original(p);
  };

  return { store, venue, check, psp, capturas, pixCriados, charge: createChargeService({ store, psp }) };
}

const pagar = (charge, check) => charge({
  checkId: check.id, amountCents: 1000, tipCents: 0,
  wallet: 'google_pay', paymentToken: 'tok', payerDocument: '52998224725', rail: 'pix',
});

describe('a escrita falha DEPOIS de o cartão ser capturado', () => {
  test('uma falha transitória é vencida pela segunda tentativa — e não cobra de novo', async () => {
    const { check, charge, capturas, store } = await mundo({ falharGravacao: 1 });
    const r = await pagar(charge, check);
    expect(r.txid).toBe('ch_1');
    // UMA captura, não duas: a nova tentativa é da ESCRITA, nunca da cobrança.
    expect(capturas).toHaveLength(1);
    expect((await store.getPayment('ch_1')).txid).toBe('ch_1');
  });

  test('falhando duas vezes, o erro tem CÓDIGO próprio — e não é "tente de novo"', async () => {
    const { check, charge, capturas } = await mundo({ falharGravacao: 2 });
    const erro = await pagar(charge, check).catch((e) => e);
    expect(erro).toBeInstanceOf(Error);
    // `internal` viraria "algo deu errado, tente de novo" com o botão armado.
    expect(erro.code).toBe('charge_maybe_captured');
    expect(erro.statusCode).toBe(502);
    // O txid viaja: é por ele que alguém liga a captura órfã à conta.
    expect(erro.txid).toBe('ch_1');
    expect(capturas).toHaveLength(1);
  });

  /**
   * A UNICIDADE é reconhecida pelo SQLSTATE, não por substring da mensagem.
   *
   * A primeira versão testava `/duplicate|unique|23505/` contra `e.message` — a
   * decisão por texto que atravessa módulo que o inegociável #7 manda
   * desconfiar, e que este repositório já consertou uma vez no sentido oposto
   * ("QUALQUER unicidade virava 'já registrado' — inclusive a `(check_id, seq)`
   * do razão, que significaria o oposto"). E o teste não exercitava o ramo: o
   * store de memória não tem unicidade, então a segunda escrita simplesmente
   * passava. Agora o dublê erra com a forma que o `throwOn` produz.
   */
  test('a unicidade na segunda tentativa é SUCESSO — a primeira escreveu e a resposta se perdeu', async () => {
    const { store, check, psp } = await mundo();
    const original = store.registerCharge.bind(store);
    let n = 0;
    store.registerCharge = async (p) => {
      n += 1;
      if (n === 1) { await original(p); throw new Error('timeout depois de escrever'); }
      // A segunda ida bate na unicidade — com o SQLSTATE que o Postgres dá.
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { pgCode: '23505' });
    };
    const charge = createChargeService({ store, psp });
    const r = await pagar(charge, check).catch((e) => e);
    expect(r).not.toBeInstanceOf(Error);
    expect(r.txid).toBe('ch_1');
    expect((await store.getPayment('ch_1')).txid).toBe('ch_1');
  });

  test('e uma unicidade de OUTRA coluna não é engolida como sucesso', async () => {
    // O motivo de decidir por SQLSTATE e não por texto vale pros dois lados: um
    // `23505` é unicidade, e é só isso que conta como "a linha já está lá". Uma
    // falha qualquer que por acaso diga "duplicate" não pode virar sucesso.
    const { store, check, psp } = await mundo();
    store.registerCharge = async () => {
      throw new Error('duplicate delivery detected upstream — nada foi escrito');
    };
    const charge = createChargeService({ store, psp });
    const erro = await pagar(charge, check).catch((e) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(erro.code).toBe('charge_maybe_captured');
  });
});

describe('e o webhook que chega depois não some', () => {
  test('`charge.paid` para um txid sem linha vira órfão registrável, não um 409', async () => {
    const { store } = await mundo();
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    const r = await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_orfa', amountCents: 1000, tipCents: 0,
      method: 'card', eventId: 'evt_1', paid: true,
      // O `code` do pedido carrega o `checkId` — é ele que torna a captura
      // órfã RESOLVÍVEL em vez de só visível.
      orderCode: 'uma-conta:0:1000:0',
    }, deps);

    expect(r.status).toBe('money_without_check');
    expect(NON_LEDGER_KINDS.has(r.status)).toBe(true);
    expect(r.raw.amountCents).toBe(1000);
    expect(r.raw.orderCode).toBe('uma-conta:0:1000:0');
  });

  /**
   * LIMITE DECLARADO deste caso: ele mede um `refund` com zero acumulado, que é
   * ruído. Ele NÃO decide política sobre dinheiro que SAI — um `dispute_lost`
   * ou um estorno de verdade pra txid desconhecido continuam 409, e isso está
   * em aberto (segurança MEDIUM-5 de 2026-09-16): o argumento "um 409 não
   * guarda nada" vale igual pro dinheiro que sai, e hoje só o que ENTRA é
   * registrado. Quem ler este teste não deve concluir que a assimetria foi
   * decidida — ela foi herdada.
   */
  test('um `refund` de acumulado ZERO para txid desconhecido segue recusado', async () => {
    const { store } = await mundo();
    const deps = {
      loadEvents: store.loadEvents.bind(store),
      appendEvent: store.appendEvent.bind(store),
      recordPayment: store.recordPayment.bind(store),
      findCheckByTxid: store.findCheckByTxid.bind(store),
      seenPspEvent: store.seenPspEvent.bind(store),
      getPayment: store.getPayment.bind(store),
      repairPaymentRow: store.repairPaymentRow.bind(store),
    };
    // Ruído de outro ambiente: sem dinheiro confirmado não há o que perder, e
    // registrar tudo encheria a fila de órfãos que ninguém fecha.
    const r = await applyConfirmedPayment({
      kind: 'refund', txid: 'ch_nada', cumulativeRefundedCents: 0, method: 'card', eventId: 'evt_2',
    }, deps);
    expect(r.status).toBe('rejected');
  });
});

/**
 * O CÓDIGO CHEGA AO CLIENTE — medido na FRONTEIRA, não no objeto lançado.
 *
 * Toda a metade voltada ao cliente deste conserto foi CÓDIGO MORTO por uma
 * rodada inteira: o erro sai com 502, e o `errorBody` devolvia
 * `{ code: 'internal' }` pra qualquer status ≥ 500 — então o botão do Google
 * Pay não desarmava e a frase nova era inalcançável. O cliente via exatamente o
 * "algo deu errado, tente de novo" que o conserto dizia ter tirado.
 *
 * Os testes não viram porque afirmavam o erro LANÇADO pela fábrica de cobrança.
 * A lição não é "testar mais": é que uma promessa sobre o que a PESSOA vê tem
 * que ser medida onde a pessoa está — depois do `errorBody`.
 * Achado pela quarta revisão de compliance de 2026-09-16 (CRITICAL-1).
 */
describe('o que de fato sai na resposta', () => {
  const { errorStatus, errorBody } = require('../_lib/http-error');

  const respostaPara = (code) => {
    const e = Object.assign(new Error('mensagem interna que não pode viajar'), {
      statusCode: 502, code,
    });
    return { status: errorStatus(e), body: errorBody(e) };
  };

  test('`charge_maybe_captured` atravessa o 5xx — é ele que desarma o botão', () => {
    const { status, body } = respostaPara('charge_maybe_captured');
    expect(status).toBe(502);
    expect(body.code).toBe('charge_maybe_captured');
  });

  test('`charge_not_started` também — no Pix a resposta certa é tentar de novo', () => {
    expect(respostaPara('charge_not_started').body.code).toBe('charge_not_started');
  });

  test('e um erro interno qualquer continua virando `internal`', () => {
    // A lista é de PERMISSÃO: o motivo de o `errorBody` engolir código em 5xx
    // continua valendo pro resto — a mensagem nomeia internos.
    expect(respostaPara('pagarme_secret_invalida').body.code).toBe('internal');
    expect(respostaPara('pagarme_secret_invalida').body.error).toBe('erro interno');
  });

  test('a MENSAGEM interna nunca viaja, nem com código na lista', () => {
    const { body } = respostaPara('charge_maybe_captured');
    expect(JSON.stringify(body)).not.toContain('mensagem interna');
  });

  test('os dois códigos têm tradução nos três idiomas', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dict = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
    for (const code of ['charge_maybe_captured', 'charge_not_started']) {
      const i = dict.indexOf(`'err.${code}'`);
      expect({ code, existe: i > 0 }).toEqual({ code, existe: true });
      const bloco = dict.slice(i, dict.indexOf("\n  '", i + 10));
      for (const lang of ['en:', 'pt:', 'es:']) {
        expect({ code, lang, tem: bloco.includes(lang) }).toEqual({ code, lang, tem: true });
      }
    }
  });

  test('e o trilho decide QUAL código — não uma frase que sirva pros dois', async () => {
    // Pix: nada foi capturado, então nada de "seu cartão pode ter sido cobrado".
    const { store, check, psp, pixCriados } = await mundo({ falharGravacao: 2 });
    const charge = createChargeService({ store, psp });
    const noPix = await charge({
      checkId: check.id, amountCents: 1000, tipCents: 0, rail: 'pix', payerDocument: '52998224725',
    }).catch((e) => e);
    expect(noPix.code).toBe('charge_not_started');
    // E o Pix de fato foi CRIADO (não é que a rota morreu antes): o que falhou
    // foi a escrita da linha, e mesmo assim nada foi capturado.
    expect(pixCriados).toHaveLength(1);

    // Carteira: o cartão foi capturado dentro da chamada ao adquirente.
    const w = await mundo({ falharGravacao: 2 });
    const naCarteira = await pagar(createChargeService({ store: w.store, psp: w.psp }), w.check).catch((e) => e);
    expect(naCarteira.code).toBe('charge_maybe_captured');
  });
});

/**
 * A CARTEIRA NÃO SE LIGA SOZINHA.
 *
 * A decisão de adiar o `capture: false` se apoia em "hoje o trilho de carteira
 * não está no ar em casa nenhuma" — e o `acceptsWallet` era verdadeiro pra
 * QUALQUER casa com recebedor de verdade. Ou seja: a primeira casa-piloto
 * cadastrada num build com as chaves ganhava Google Pay como efeito colateral
 * do cadastro, e o gatilho que devia forçar a inversão se satisfazia sozinho.
 * Achado pela quarta revisão de compliance de 2026-09-16 (HIGH-4).
 */
describe('o interruptor da carteira', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const { carteiraLiberada } = require('../_app/router');

  /**
   * Com a env posta DURANTE a chamada — porque o ajudante a lê a cada chamada,
   * de propósito: uma instância quente da Vercel viveria com a lista velha
   * depois de a env mudar, e "liguei e não ligou" é como alguém desiste do
   * interruptor e depois tira o interruptor.
   */
  const com = (valor, f) => {
    const antes = process.env.RACHA_WALLET_VENUES;
    if (valor === undefined) delete process.env.RACHA_WALLET_VENUES;
    else process.env.RACHA_WALLET_VENUES = valor;
    try { return f(); } finally {
      if (antes === undefined) delete process.env.RACHA_WALLET_VENUES;
      else process.env.RACHA_WALLET_VENUES = antes;
    }
  };

  test('o `acceptsWallet` depende do interruptor, não só do recebedor', () => {
    const i = ROUTER.indexOf('acceptsWallet: true');
    expect(i).toBeGreaterThan(0);
    const condicao = ROUTER.slice(ROUTER.lastIndexOf('if (', i), i);
    expect(condicao).toMatch(/pspRecipientId/);
    expect(condicao).toMatch(/carteiraLiberada/);
  });

  test('sem a env, nenhuma casa tem carteira — é isto que torna a decisão verdadeira', () => {
    expect(com(undefined, () => carteiraLiberada('qualquer-casa'))).toBe(false);
    expect(com('', () => carteiraLiberada('qualquer-casa'))).toBe(false);
    expect(com('   ', () => carteiraLiberada('qualquer-casa'))).toBe(false);
  });

  test('a lista libera só quem está nela', () => {
    com('casa-a, casa-b', () => {
      expect(carteiraLiberada('casa-a')).toBe(true);
      expect(carteiraLiberada('casa-b')).toBe(true);
      expect(carteiraLiberada('casa-c')).toBe(false);
    });
  });

  test('a env é lida a cada chamada — instância quente não fica com a lista velha', () => {
    expect(com('', () => carteiraLiberada('casa-a'))).toBe(false);
    expect(com('casa-a', () => carteiraLiberada('casa-a'))).toBe(true);
  });

  test('`*` é o escape EXPLÍCITO, pra staging — e não o padrão', () => {
    expect(com('*', () => carteiraLiberada('qualquer'))).toBe(true);
  });
});

describe('o que a quarta revisão mediu', () => {
  const { applyConfirmedPayment } = require('../_lib/pay/webhook-handler');
  const { createNonLedgerHandler } = require('../_lib/pay/non-ledger');

  const depsDe = (store) => ['loadEvents', 'appendEvent', 'recordPayment', 'findCheckByTxid',
    'seenPspEvent', 'getPayment', 'repairPaymentRow']
    .reduce((a, k) => ({ ...a, [k]: store[k].bind(store) }), {});

  /**
   * O EXCEDENTE NÃO É CONTADO DUAS VEZES.
   *
   * `parseCharge` já soma o excedente dentro de `amountCents` e ainda o reporta
   * à parte em `excessCents`. Somar os três dizia 7000¢ para 6000¢ que de fato
   * entraram — e esta linha é o ÚNICO registro que existe desse dinheiro
   * (inegociável #5). Nenhum caso anterior pegava: todos usavam pagamento
   * exato, onde o excedente é zero e o defeito é invisível.
   */
  test('uma conta paga a MAIOR registra o que chegou, não mais', async () => {
    const { store } = await mundo();
    // Conta de R$ 50,00 paga com R$ 60,00: o adaptador entrega 5500 + 500 de
    // serviço, com 1000 deles marcados como excedente.
    const r = await applyConfirmedPayment({
      kind: 'payment_confirmed', txid: 'ch_a_maior', amountCents: 5500, tipCents: 500,
      excessCents: 1000, method: 'card', eventId: 'evt_x', paid: true,
    }, depsDe(store));
    expect(r.status).toBe('money_without_check');
    expect(r.raw.amountCents).toBe(6000);
  });

  /**
   * O `orderCode` CHEGA À LINHA GRAVADA — não só ao objeto devolvido.
   *
   * A versão anterior afirmava `r.raw.orderCode` (o retorno, em memória) e o
   * runbook mandava consultar `payload->>'orderCode'`. Medido: o `payload`
   * salvo era `{}`, porque o `maskPixPayload` é lista de permissão e o campo
   * não é do corpo do PSP. Promessa em três artefatos, zero no banco.
   */
  test('o `orderCode` fica no que o store REALMENTE recebe', async () => {
    const gravados = [];
    const store = {
      recordOrphanMoneyEvent: async (e) => { gravados.push(e); return true; },
      findCheckByTxid: async () => null,
    };
    const tratar = createNonLedgerHandler({ store, notify: async () => ({ ok: true }) });
    await tratar({
      status: 'money_without_check', txid: 'ch_z',
      raw: { eventId: 'evt_z', amountCents: 6000, orderCode: '11111111-2222-4333-8444-555555555555:0:5500:500', raw: { id: 'ch_z', amount: 6000 } },
    }, { psp: 'pagarme' });

    expect(gravados).toHaveLength(1);
    expect(gravados[0].payload.orderCode).toBe('11111111-2222-4333-8444-555555555555:0:5500:500');
    expect(gravados[0].amountCents).toBe(6000);
  });

  /**
   * A CORRIDA ENTRE A SEGUNDA TENTATIVA E O WEBHOOK não vira alarme falso.
   *
   * O tratador procura a conta DE NOVO. Se a segunda gravação venceu no meio,
   * `found` vira verdadeiro e a versão anterior pendurava um `PAYMENT_ANOMALY`
   * **critical** numa conta cujo pagamento está prestes a confirmar normalmente:
   * a casa fica vermelha por um pagamento que está bem.
   */
  test('se a linha apareceu no meio, NÃO vira anomalia crítica — vira reenvio', async () => {
    const apendados = [];
    const store = {
      // A linha existe agora: a segunda tentativa de gravação venceu a corrida.
      findCheckByTxid: async () => ({ id: 'conta-9' }),
      recordOrphanMoneyEvent: async () => { throw new Error('não devia gravar órfão'); },
    };
    const tratar = createNonLedgerHandler({
      store,
      notify: async () => ({ ok: true }),
      append: async (...a) => { apendados.push(a); },
    });
    const marca = await tratar({
      status: 'money_without_check', txid: 'ch_z', raw: { eventId: 'evt_z', amountCents: 100 },
    }, { psp: 'pagarme' });

    expect(apendados).toEqual([]);          // nenhuma anomalia numa conta sadia
    expect(marca.persisted).toBe(false);    // …e por isso o `needsRetry` pede reenvio
    const { needsRetry } = require('../_lib/pay/non-ledger');
    expect(needsRetry(marca)).toBe(true);
  });

  /**
   * A NOVA TENTATIVA É PRA FALHA TRANSITÓRIA, não pra recusa provada.
   *
   * `registerCharge` são DUAS idas de 10 s. Repetir uma recusa determinística
   * (CHECK violado, grant revogado) leva o pior caso de 20 s pra 40 s numa rota
   * pública — amplificação de repetição contra um banco que já está mal.
   */
  test('uma recusa PROVADA não é repetida', async () => {
    const { store, check, psp } = await mundo();
    let idas = 0;
    store.registerCharge = async () => {
      idas += 1;
      // `23514` — CHECK violado. Determinístico: a segunda daria o mesmo.
      throw Object.assign(new Error('new row violates check constraint'), { pgCode: '23514' });
    };
    const charge = createChargeService({ store, psp });
    await pagar(charge, check).catch(() => {});
    expect(idas).toBe(1);
  });

  test('e uma falha transitória continua sendo repetida', async () => {
    const { store, check, psp } = await mundo();
    let idas = 0;
    store.registerCharge = async () => {
      idas += 1;
      throw new Error('AbortError: This operation was aborted');   // sem pgCode
    };
    const charge = createChargeService({ store, psp });
    await pagar(charge, check).catch(() => {});
    expect(idas).toBe(2);
  });
});

/**
 * O QUE A QUINTA REVISÃO MEDIU (2026-09-19) — três achados, uma raiz só.
 *
 * A raiz: a decisão "o que a pessoa na mesa lê quando a escrita falha depois de
 * já termos falado com o adquirente" estava escrita DENTRO de um caminho, e os
 * caminhos irmãos não a conheciam. Ela agora mora em `gravar-apos-cobrar.js`, e
 * é isso que este bloco prende.
 *
 * Os testes acima passavam todos — 2.372 deles — com os três defeitos no ar.
 * Eles exercitavam a falha de TRANSPORTE (sem `pgCode`), que é o caminho que
 * chega na segunda tentativa. Nenhum plantava um SQLSTATE na PRIMEIRA ida, que
 * é por onde o dano passava.
 */
describe('o atalho da recusa provada (CRITICAL-2)', () => {
  /** Um erro do store de produção: `pgCode` posto, e mais nada. */
  const comSqlstate = (pgCode) => Object.assign(
    new Error(`supabase store registerCharge: ${pgCode}`), { pgCode },
  );

  const mundoQueRecusa = async (pgCode) => {
    const { store, check, psp } = await mundo();
    const idas = [];
    store.registerCharge = async () => { idas.push(pgCode); throw comSqlstate(pgCode); };
    return { check, idas, charge: createChargeService({ store, psp }) };
  };

  /**
   * `57014` é o prazo de 10 s do banco — o modo de falha mais provável deste
   * caminho — e ele É recusa provada (o Postgres garante o rollback), então
   * cai no atalho de UMA tentativa. Era exatamente aí que o erro CRU do
   * Supabase subia: sem `code`, sem `statusCode`, virava 500 `internal` →
   * "algo deu errado, tente de novo" com o botão do Google Pay ARMADO, sobre um
   * cartão que já tinha sido capturado. O dano que o conserto anterior dizia ter
   * fechado, de volta pela linha ao lado.
   */
  test.each([
    ['57014', 'prazo de 10 s estourado'],
    ['40P01', 'deadlock'],
    ['53300', 'pooler do Supabase cheio'],
    ['42501', 'grant revogado'],
    ['23514', 'CHECK violado'],
    ['22001', 'texto longo demais'],
  ])('%s (%s) desarma o botão — não vira 500 `internal`', async (pgCode) => {
    const { check, charge } = await mundoQueRecusa(pgCode);
    const erro = await pagar(charge, check).catch((e) => e);
    expect(erro.code).toBe('charge_maybe_captured');
    expect(erro.statusCode).toBe(502);
    expect(erro.txid).toBe('ch_1');
  });

  /**
   * A CONTAGEM DE IDAS, que é o que ninguém estava medindo.
   *
   * O bloco acima passa com UMA ida ou com DUAS — ele só olha o desfecho. Era
   * exatamente essa cegueira que deixava o retry desligado nos erros que ele
   * conserta: `recusaProvada` responde "está provado que nada foi gravado", e
   * `53300`/`40P01`/`57014` estão nela porque o Postgres garante o rollback —
   * mas são também os SQLSTATEs canônicos de "tenta de novo e passa". O
   * `53300` é o realista: pooler saturado numa noite cheia, com o cartão já
   * capturado (quinta revisão de segurança, 2026-09-19).
   */
  test.each([
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock'],
    ['53300', 'pooler cheio'],
    ['55P03', 'lock_not_available'],
    ['57014', 'prazo estourado'],
  ])('%s (%s) é TRANSITÓRIO: tenta duas vezes', async (pgCode) => {
    const { check, charge, idas } = await mundoQueRecusa(pgCode);
    await pagar(charge, check).catch((e) => e);
    expect(idas).toHaveLength(2);
  });

  test.each([
    ['42501', 'grant revogado'],
    ['42703', 'coluna que sumiu'],
    ['23514', 'CHECK violado'],
    ['22001', 'texto longo demais'],
  ])('%s (%s) é recusa DETERMINÍSTICA: tenta uma vez só', async (pgCode) => {
    const { check, charge, idas } = await mundoQueRecusa(pgCode);
    await pagar(charge, check).catch((e) => e);
    // Repetir contra um banco que já recusou por escrito só dobra a espera numa
    // rota pública com idas de 10 s.
    expect(idas).toHaveLength(1);
  });

  test('um erro de transporte SEM sqlstate também merece a segunda ida', async () => {
    const { store, check, psp } = await mundo();
    const idas = [];
    store.registerCharge = async () => {
      idas.push(1);
      throw new Error('supabase store registerCharge: AbortError: This operation was aborted');
    };
    const charge = createChargeService({ store, psp });
    await pagar(createChargeService({ store, psp }), check).catch(() => {});
    expect(idas).toHaveLength(2);
    expect(charge).toBeInstanceOf(Function);
  });

  test('e o código de fato ATRAVESSA o 5xx — é o corpo da resposta que desarma', async () => {
    const { errorStatus, errorBody } = require('../_lib/http-error');
    const { check, charge } = await mundoQueRecusa('57014');
    const erro = await pagar(charge, check).catch((e) => e);
    // Medido DEPOIS do `errorBody`, que já apagou um código nesta mesma sessão.
    expect(errorStatus(erro)).toBe(502);
    expect(errorBody(erro, 502).code).toBe('charge_maybe_captured');
    // A mensagem interna continua sem viajar.
    expect(errorBody(erro, 502).error).not.toMatch(/supabase|57014/);
  });

  test('no Pix a recusa provada diz `charge_not_started` — nada foi capturado', async () => {
    const { store, check, psp } = await mundo();
    store.registerCharge = async () => { throw comSqlstate('57014'); };
    const charge = createChargeService({ store, psp });
    const erro = await charge({
      checkId: check.id, amountCents: 1000, tipCents: 0, rail: 'pix',
      payerDocument: '52998224725',
    }).catch((e) => e);
    expect(erro.code).toBe('charge_not_started');
  });

  /**
   * O `23505` da PRIMEIRA ida quer dizer que a linha JÁ ESTÁ LÁ — sucesso. Ele
   * cai dentro de `^23`, que é classe de recusa provada, então a ordem dos dois
   * testes no `gravarAposCobrar` é a diferença entre "pronto, segue" e um 500
   * permanente. E não é hipótese: o MockPsp deriva o txid de
   * `sha256(chargeRef|valor|gorjeta|recebedor)` e o `chargeRef` carrega o
   * `paidCents` — duas pessoas tocando "pagar R$ 50,00" na mesma conta antes de
   * qualquer uma confirmar produzem o MESMO txid. Como o store de memória passou
   * a impor a unicidade (a produção impõe), isso passou a prender quem tentava
   * pagar, no demo público da landing e no canário de staging.
   */
  test('`23505` na PRIMEIRA ida é SUCESSO, não recusa — senão prende quem paga', async () => {
    const { store, check, psp } = await mundo();
    const original = store.registerCharge.bind(store);
    let n = 0;
    store.registerCharge = async (p) => {
      n += 1;
      if (n === 1) { await original(p); throw comSqlstate('23505'); }
      throw new Error('não devia haver segunda ida: a linha já estava lá');
    };
    const charge = createChargeService({ store, psp });
    // COM rótulo: é o mesmo pedido repetido, e o rótulo é o que prova isso. Sem
    // rótulo dos dois lados a posse não tem como ser provada, e aí o portão
    // fecha — que é o caso dos dois anônimos, coberto logo abaixo.
    const r = await charge({
      checkId: check.id, amountCents: 1000, tipCents: 0,
      wallet: 'google_pay', paymentToken: 'tok', payerDocument: '52998224725',
      rail: 'pix', payerLabel: 'Ana',
    }).catch((e) => e);
    expect(r).not.toBeInstanceOf(Error);
    expect(r.txid).toBe('ch_1');
    expect(n).toBe(1);
    expect((await store.getPayment('ch_1')).txid).toBe('ch_1');
  });
});

/**
 * "A LINHA EXISTE" NÃO É "A LINHA É NOSSA", na primeira ida.
 *
 * Na segunda é: a primeira tentativa foi nossa. Na primeira não houve tentativa
 * anterior nossa, então a linha que está lá foi escrita por OUTRA cobrança — e
 * devolver sucesso ali entrega à segunda pessoa o BR Code da primeira. O
 * `refDoPagamento` deriva do txid o marcador de "este pagamento é meu", então
 * os dois telefones reivindicariam a única confirmação e os dois desenhariam
 * recibo (CDC art. 6º III). Sexta revisão de compliance, 2026-09-19, MEDIUM-2.
 */
describe('colisão de txid na primeira ida não vira sucesso de outra pessoa', () => {
  const colisao = async (rotuloDaOutra, meuRotulo) => {
    const { store, check, psp } = await mundo();
    const original = store.registerCharge.bind(store);
    // A OUTRA pessoa já gravou, com o mesmo txid que o mock vai nos dar.
    await original({
      checkId: check.id, txid: 'ch_1', amountCents: 1000, tipCents: 0,
      payerLabel: rotuloDaOutra, method: 'pix',
    });
    store.registerCharge = async () => {
      throw Object.assign(new Error('duplicate key'), { pgCode: '23505' });
    };
    store.getPayment = async (txid) => (txid === 'ch_1'
      ? { txid, checkId: check.id, amountCents: 1000, tipCents: 0, payerLabel: rotuloDaOutra }
      : null);
    const charge = createChargeService({ store, psp });
    return charge({
      checkId: check.id, amountCents: 1000, tipCents: 0,
      wallet: 'google_pay', paymentToken: 'tok', payerDocument: '52998224725',
      rail: 'pix', payerLabel: meuRotulo,
    }).catch((e) => e);
  };

  test('o BR Code da Ana NÃO é devolvido pro Bruno', async () => {
    const r = await colisao('Ana', 'Bruno');
    expect(r).toBeInstanceOf(Error);
    expect(r.code).toBe('charge_maybe_captured');
  });

  test('o rótulo é comparado NORMALIZADO — " Ana " é a Ana', async () => {
    const r = await colisao('Ana', '  Ana  ');
    expect(r).not.toBeInstanceOf(Error);
    expect(r.txid).toBe('ch_1');
  });

  /**
   * DOIS ANÔNIMOS é o caso COMUM, não a borda: `payerLabel` é opcional em todo
   * caminho e a PWA manda `trim() || null`. A versão anterior devolvia sucesso
   * aqui, com uma justificativa errada — "o `chargeRef` carrega o `paidCents`,
   * então quando a primeira confirmar o txid deixa de colidir" — que aponta
   * pra DEPOIS da janela que o próprio parágrafo define (antes de qualquer uma
   * confirmar). Sétima revisão de segurança, MEDIUM-3.
   */
  test('dois anônimos: não dá pra provar posse, então NÃO entrega a cobrança alheia', async () => {
    const r = await colisao(null, null);
    expect(r).toBeInstanceOf(Error);
    expect(r.code).toBe('charge_maybe_captured');
  });

  /**
   * A pergunta é uma LEITURA ao banco, logo depois de uma escrita que falhou,
   * no mesmo cliente com prazo de 10 s. Sem `try`, a exceção subia crua — sem
   * `code`, sem `statusCode` — virando 500 `internal` → "tente de novo" com o
   * botão ARMADO sobre um cartão capturado. O defeito que este módulo existe
   * pra eliminar, reaberto pela linha acrescentada pra fechar outro.
   * Sétima revisão de segurança, MEDIUM-2.
   */
  test('se a pergunta da posse FALHA, fecha pro lado seguro — não vira 500 `internal`', async () => {
    const { store, check, psp } = await mundo();
    store.registerCharge = async () => {
      throw Object.assign(new Error('duplicate key'), { pgCode: '23505' });
    };
    store.getPayment = async () => {
      throw Object.assign(new Error('supabase store getPayment: 57014'), { pgCode: '57014' });
    };
    const charge = createChargeService({ store, psp });
    const r = await pagar(charge, check).catch((e) => e);
    expect(r).toBeInstanceOf(Error);
    expect(r.code).toBe('charge_maybe_captured');
    expect(r.statusCode).toBe(502);
  });
});

describe('o trilho da Stripe passa pelo MESMO portão (MEDIUM)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const API = path.join(__dirname, '..');
  const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  /**
   * Censo, e não teste de comportamento, porque o que se quer prender é a
   * AUSÊNCIA de um segundo caminho: `registerCharge` chamado direto depois de
   * falar com o adquirente é a forma do defeito, onde quer que ela reapareça.
   * Sem comentário antes de medir — a prosa que explica um `registerCharge` já
   * inflou um censo deste repositório três vezes.
   */
  /**
   * VARRE `api/` INTEIRO, e não o `router.js`.
   *
   * A versão anterior lia só o roteador — e o TERCEIRO caminho estava em
   * `_lib/house/house-service.js` o tempo todo, escrevendo `registerHouseLoad`
   * pelado depois de falar com o adquirente. O censo escrito pra impedir um
   * terceiro caminho não enxergava a pasta onde ele morava (sexta revisão de
   * compliance, 2026-09-19).
   */
  test('nenhuma escrita PELADA depois de falar com o adquirente, em api/ inteiro', () => {
    const ESCRITAS = /\bstore\.(registerCharge|registerHouseLoad)\(/;
    const pelados = [];
    const varrer = (dir) => {
      for (const nome of fs.readdirSync(dir)) {
        const cheio = path.join(dir, nome);
        if (fs.statSync(cheio).isDirectory()) {
          if (nome !== '__tests__' && nome !== 'node_modules') varrer(cheio);
          continue;
        }
        if (!nome.endsWith('.js')) continue;
        const fonte = fs.readFileSync(cheio, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        fonte.split('\n').forEach((linha, i) => {
          // `gravar:` é a assinatura de estar DENTRO do portão compartilhado.
          // `\bgravar:` com fronteira: a versão sem ela casava a SUBSTRING, e
          // um `xgravar:` — ou qualquer campo terminado em "gravar" — absolvia
          // a linha. Foi um mutante plantado que mostrou isso.
          if (ESCRITAS.test(linha) && !/(^|[^A-Za-z])gravar:/.test(linha)) {
            pelados.push(`${path.relative(API, cheio)}:${i + 1}`);
          }
        });
      }
    };
    varrer(API);
    // Se esta lista crescer, alguém escreveu o quarto caminho.
    expect(pelados).toEqual([]);
  });

  test('o trilho da Stripe lê `walletCaptures` do adaptador — e ele declara false', () => {
    // Ancorado na CHAMADA, não na primeira aparição de `stripeAccountId` —
    // que fica noutro trecho e absolvia o trilho sem medi-lo.
    // Ancorado no que a rota REALMENTE chama — hoje o adaptador passa pela
    // recusa-se-não-declarar antes, então o literal antigo não existe mais.
    const i = ROUTER.indexOf('comContratoDeCaptura(stripePsp).createWalletCharge');
    expect(i).toBeGreaterThan(0);
    const trecho = ROUTER.slice(i, i + 2000);
    expect(trecho).toMatch(/gravarAposCobrar/);
    /**
     * O CONTRATO, não o literal.
     *
     * Esta linha exigia `capturou: false` cravado — e com isso REJEITAVA o
     * conserto: trocar pelo `stripePsp.walletCaptures` correto deixava o teste
     * vermelho. Um guarda que impede a correção é pior que nenhum. Nona revisão
     * de segurança (2026-09-19, MEDIUM-1).
     */
    expect(trecho).toMatch(/capturou:\s*stripePsp\.walletCaptures/);
    // E o adaptador declara `false` porque é verdade: o `createWalletCharge` da
    // Stripe devolve `clientSecret` pro front confirmar, ao contrário do
    // homônimo da Pagar.me, que captura dentro da chamada.
    const STRIPE = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', 'stripe-psp.js'), 'utf8');
    expect(STRIPE).toMatch(/clientSecret:\s*pi\.client_secret/);
    expect(STRIPE).toMatch(/walletCaptures:\s*false/);
    // E a rota recusa um adaptador que não declare — o mesmo "falha fechado"
    // que a fábrica já fazia, que esta rota contornava por chamar direto.
    expect(ROUTER).toMatch(/comContratoDeCaptura\(stripePsp\)/);
  });
});

/**
 * OS CENSOS DE TEXTO DESTE PORTÃO FORAM APAGADOS, de propósito.
 *
 * Eram três `ROUTER.indexOf(...)` provando que a linha existe e que vem antes
 * da cobrança. A sétima revisão de segurança plantou o mutante que encerra o
 * assunto: manteve o literal INTACTO — então os três censos seguiam satisfeitos
 * — e acrescentou uma disjunção paralela que barrava a demo de novo, isto é,
 * reintroduziu por inteiro o HIGH da rodada anterior. Suíte completa: 79 suítes,
 * 2.498 testes, zero falhas.
 *
 * Um guarda que passa por ser lido e não medido é pior que nenhum: ele consome
 * a atenção que o guarda de verdade precisaria. A cobertura deste portão mora
 * agora em `interruptor-da-carteira.test.js`, que monta o `route()` e mede o
 * que a linha AVALIA — ligado, desligado, outra casa, o Pix que não passa por
 * aqui, a demo que é isenta, e o nome de trilho inválido.
 */
describe('o `orderCode` gravado tem a FORMA de um orderCode', () => {
  const { createNonLedgerHandler } = require('../_lib/pay/non-ledger');

  const gravado = async (orderCode) => {
    const gravados = [];
    const store = {
      recordOrphanMoneyEvent: async (e) => { gravados.push(e); return true; },
      findCheckByTxid: async () => null,
    };
    const tratar = createNonLedgerHandler({ store, notify: async () => ({ ok: true }) });
    await tratar({
      status: 'money_without_check', txid: 'ch_z',
      raw: { eventId: 'evt_z', amountCents: 6000, orderCode, raw: { id: 'ch_z', amount: 6000 } },
    }, { psp: 'pagarme' });
    return gravados[0] && gravados[0].payload;
  };

  // UUID porque é a forma do NOSSO `checks.id` — e a fixture anterior
  // ('conta-9') não era um id de conta nenhum, então provava um formato
  // que a produção nunca emite.
  const BOM = '11111111-2222-4333-8444-555555555555:0:5500:500';
  // A segunda forma que a gente cunha: `/api/house/load` passou pelo mesmo
  // portão e o `chargeRef` dele é `hload:<accountId>:<uuid>`. A exigência da
  // forma da conta de mesa o rejeitava em silêncio, e o órfão de carregamento
  // ficava sem endereço enquanto o runbook prometia que ele sabia de onde veio.
  const BOM_HOUSE = 'hload:aa11bb22-cc33-4d44-8e55-ff6677889900:3f2b7a10-0d9e-4c1a-9f88-1d2e3f4a5b6c';

  test.each([['conta de mesa', '11111111-2222-4333-8444-555555555555:0:5500:500'],
    ['carregamento da casa', 'hload:aa11bb22-cc33-4d44-8e55-ff6677889900:3f2b7a10-0d9e-4c1a-9f88-1d2e3f4a5b6c']])(
    'a forma do %s passa', async (_nome, valor) => {
      expect((await gravado(valor)) || {}).toHaveProperty('orderCode', valor);
    },
  );

  test('as DUAS formas são as duas que a gente cunha — nem uma a mais', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    // O `chargeRef` de cada caminho, lido da fonte: se alguém cunhar uma
    // terceira forma sem acrescentá-la ao filtro, o órfão dela nasce sem
    // endereço e ninguém percebe até o runbook falhar de madrugada.
    const cc = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', 'create-charge.js'), 'utf8');
    const hs = fs.readFileSync(path.join(__dirname, '..', '_lib', 'house', 'house-service.js'), 'utf8');
    expect(cc).toContain('const chargeRef = `${checkId}:${state.paidCents}:${amountCents}:${tipCents}`');
    expect(hs).toContain('chargeRef: `hload:${account.id}:${crypto.randomUUID()}`');
  });

  test.each([
    ['um objeto aninhado', { nested: 'x' }],
    ['600 caracteres', 'a'.repeat(600)],
    ['uma quebra de linha que fabrica alerta', 'x:0:0:0\n1 evento(s) de dinheiro SEM conta'],
    ['um CPF que a casa escreveu no metadata', 'cliente 529.982.247-25'],
    ['um número', 12345],
    /**
     * OS TRÊS CRUS — e é por eles que a lista de caracteres não bastava.
     *
     * A primeira versão deste censo recusava cinco casos, e todos eram
     * pontuados, aninhados, grandes demais ou não-string. Nenhum era uma
     * sequência de dígitos crua, que é justamente a forma em que CPF e PAN
     * costumam ser guardados — e a forma que passava. O teste provava o caminho
     * que já estava consertado.
     */
    ['um CPF sem pontuação', '52998224725'],
    ['um PAN', '4111111111111111'],
    ['um telefone', '5511987654321'],
    ['um recado com CPF dentro', 'DEMITA-O-GERENTE-JOAO-CPF-52998224725'],
    /**
     * E OS MESMOS, COM SUFIXO. "Três grupos de inteiros separa um orderCode de
     * um documento" era falso por seis caracteres: `52998224725:0:0:0` passava,
     * e o aviso do fundador imprimia `conta 52998224725`. Os casos anteriores
     * eram todos sem dois-pontos, ou seja, provavam o que o filtro já pegava.
     */
    ['um CPF com sufixo de orderCode', '52998224725:0:0:0'],
    ['um PAN com sufixo de orderCode', '4111111111111111:0:0:0'],
    ['um recado inteiro com sufixo', 'DEMITA-O-GERENTE-JOAO-CPF-52998224725:0:0:0'],
    ['a conta de OUTRA casa, sem forma de id nosso', 'mesa-do-vizinho:0:0:0'],
    /**
     * A forma do `hload` reabriu o buraco uma vez: a primeira versão aceitava
     * `[A-Za-z0-9-]{1,64}` nos dois segmentos, então `hload:<CPF>:<CPF>`
     * passava — exatamente o que a exigência de UUID na forma irmã acabara de
     * fechar (oitava revisão de compliance, MEDIUM-1).
     */
    ['um CPF vestido de carregamento', 'hload:52998224725:52998224725'],
    ['um PAN vestido de carregamento', 'hload:4111111111111111:4111111111111111'],
  ])('%s NÃO entra', async (_nome, valor) => {
    const p = (await gravado(valor)) || {};
    expect(p.orderCode).toBeUndefined();
  });

  test('e o que entra é sempre escalar curto — a propriedade, não o caso', async () => {
    for (const v of [BOM, { a: 1 }, 'a'.repeat(600), 'x\ny', null, '52998224725', '4111111111111111']) {
      const p = (await gravado(v)) || {};
      for (const valor of Object.values(p)) {
        expect(['string', 'number', 'boolean']).toContain(typeof valor);
        if (typeof valor === 'string') expect(valor.length).toBeLessThanOrEqual(128);
      }
    }
  });
});

/**
 * QUEM CAPTURA É O ADAPTADOR (sétima revisão de compliance, LOW-2 / segurança L7).
 *
 * `capturou: Boolean(wallet)` decidia pelo nome do trilho, contra o que o
 * docblock do `gravar-apos-cobrar` afirma. Na mesa de DEMONSTRAÇÃO o PSP é o
 * MockPsp, que não captura nada — e uma falha de escrita mandava "Seu cartão
 * pode já ter sido cobrado, não pague de novo" pra um prospect sem cartão em
 * jogo. É o mesmo alarme falso que a separação dos dois códigos existe pra
 * evitar, vindo do outro lado.
 */
describe('o alarme de cartão capturado depende de haver captura', () => {
  const comAdaptador = async (extra) => {
    const { store, check, psp } = await mundo();
    store.registerCharge = async () => {
      throw Object.assign(new Error('prazo'), { pgCode: '57014' });
    };
    const base = { ...psp };
    delete base.walletCaptures;
    const charge = createChargeService({ store, psp: { ...base, ...extra } });
    return pagar(charge, check).catch((e) => e);
  };

  test('quem captura desarma o botão', async () => {
    expect((await comAdaptador({ provider: 'pagarme', walletCaptures: true })).code)
      .toBe('charge_maybe_captured');
  });

  test('quem NÃO captura não assusta ninguém com cobrança que não houve', async () => {
    expect((await comAdaptador({ provider: 'mock', walletCaptures: false })).code)
      .toBe('charge_not_started');
  });

  /**
   * UM ADAPTADOR QUE NÃO DECLARA É RECUSADO — e esta asserção já esteve ao
   * contrário.
   *
   * A versão anterior exigia `charge_not_started` de um `zoop` não declarado, e
   * eu chamei isso de "lista de permissão". Era o ramo ERRADO: `charge_not_started`
   * diz "nada foi cobrado, tente de novo", que num PSP que captura é convite à
   * SEGUNDA CAPTURA (CDC art. 42 § único). O teste transformava a segurança num
   * "o próximo autor precisa lembrar de se declarar", que é a forma que este
   * repositório mais paga pra aprender. Oitava revisão de segurança, MEDIUM-3.
   */
  test('um adaptador que não se declara é RECUSADO, não presumido', async () => {
    const e = await comAdaptador({ provider: 'zoop' });
    expect(e.code).toBe('platform_misconfigured');
    // E nenhum dos dois desfechos de dinheiro: a pergunta não foi respondida.
    expect(['charge_maybe_captured', 'charge_not_started']).not.toContain(e.code);
  });

  /**
   * O CASO QUE SEPARA AS DUAS REGRAS — e sem ele a asserção é vácua.
   *
   * Enquanto `provider: 'pagarme'` e `walletCaptures: true` andarem juntos nos
   * dublês, "pergunta o nome" e "pergunta a capacidade" dão a MESMA resposta, e
   * um mutante que volte pro nome passa verde. Estes dois casos são os únicos em
   * que as duas regras divergem — e são exatamente os do mundo real: o
   * adaptador NOVO que captura, e o adaptador conhecido que deixa de capturar
   * (o dia em que a inversão `capture: false` for feita na Pagar.me).
   */
  test('um adaptador NOVO que captura desarma o botão — mesmo sem se chamar pagarme', async () => {
    expect((await comAdaptador({ provider: 'zoop', walletCaptures: true })).code)
      .toBe('charge_maybe_captured');
  });

  test('e a Pagar.me deixando de capturar (`capture: false`) para de assustar', async () => {
    expect((await comAdaptador({ provider: 'pagarme', walletCaptures: false })).code)
      .toBe('charge_not_started');
  });

  test('declarar coisa que não é booleano também é recusa', async () => {
    expect((await comAdaptador({ provider: 'zoop', walletCaptures: 'sim' })).code)
      .toBe('platform_misconfigured');
  });
});
