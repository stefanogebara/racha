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
      raw: { eventId: 'evt_z', amountCents: 6000, orderCode: 'conta-9:0:5500:500', raw: { id: 'ch_z', amount: 6000 } },
    }, { psp: 'pagarme' });

    expect(gravados).toHaveLength(1);
    expect(gravados[0].payload.orderCode).toBe('conta-9:0:5500:500');
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
