'use strict';

/**
 * A DEMO PAGA SE RENOVA — e a cura que já existia nunca pegava este caso.
 *
 * O comentário da cura em `/api/check` diz que ela reabre a demo "com a conta
 * fechada (alguém pagou tudo)". Só que ela dispara em `!data`, e pagar tudo
 * NÃO fecha a conta: deixa `status: 'paga'`, `closed: false`, e a leitura
 * continua achando a conta. Medido em memória e visto em produção em
 * 2026-09-23: a principal chamada da landing ("Experimente a demo ao vivo")
 * levava a "Conta paga por completo. Boa noite!", sem abas e sem botão de
 * pagar, até o reset diário das 09:00 UTC — até 22 horas de demo morta. E o PSP
 * de mentira da demo confirma as próprias cobranças na hora, então basta uma
 * pessoa pagar a parte que falta pra matar a demo pra todo mundo.
 *
 * É o inegociável #7 quase na letra: "uma guarda que nunca dispara é testada em
 * produção, não confiada". A guarda estava escrita, o comentário descrevia o
 * caso, e o caso nunca passava por ela.
 *
 * O conserto: na leitura, se a conta da demo está paga HÁ MAIS de um tempo de
 * glória, ela se renova. O tempo existe pra quem pagou ver o "Conta paga por
 * completo" — o momento que a demo existe pra mostrar — antes de a próxima
 * pessoa ganhar uma conta nova.
 */

const http = require('node:http');
const { createMemoryStore } = require('../_lib/store/memory');
const {
  DEMO_TOKEN, DEMO_TOTAL_CENTS, ensureDemoCheck, resetDemoCheck, demoPagaHaTempo, DEMO_TEMPO_DE_GLORIA_MS,
} = require('../_lib/demo');

const pagarTudo = (store, checkId) => store.appendEvent(checkId, 'PAYMENT_CONFIRMED',
  { txid: `tx_${Math.random()}`, amountCents: DEMO_TOTAL_CENTS, tipCents: 0, method: 'pix' });

describe('o predicado: paga, e há quanto tempo', () => {
  const agora = Date.parse('2026-09-23T12:00:00Z');
  const estado = (status, confirmedAt) => ({
    status, payments: confirmedAt === undefined ? {} : { t1: { confirmedAt } },
  });

  test('paga há mais que o tempo de glória → renova', () => {
    const velho = new Date(agora - DEMO_TEMPO_DE_GLORIA_MS - 1).toISOString();
    expect(demoPagaHaTempo(estado('paga', velho), agora)).toBe(true);
  });

  test('paga AGORA → não renova: quem pagou tem direito ao "Boa noite!"', () => {
    const recente = new Date(agora - 5_000).toISOString();
    expect(demoPagaHaTempo(estado('paga', recente), agora)).toBe(false);
  });

  test('aberta ou parcial → nunca renova, por mais velho que seja o pagamento', () => {
    const velho = new Date(agora - 10 * DEMO_TEMPO_DE_GLORIA_MS).toISOString();
    expect(demoPagaHaTempo(estado('aberta', velho), agora)).toBe(false);
    expect(demoPagaHaTempo(estado('parcial', velho), agora)).toBe(false);
  });

  test('conta de VÁRIOS pagamentos conta a partir do ÚLTIMO', () => {
    // O primeiro foi há uma hora; o que fechou a conta, agora. Contar do
    // primeiro renovaria na cara de quem acabou de pagar.
    const s = { status: 'paga', payments: {
      a: { confirmedAt: new Date(agora - 3_600_000).toISOString() },
      b: { confirmedAt: new Date(agora - 2_000).toISOString() },
    } };
    expect(demoPagaHaTempo(s, agora)).toBe(false);
  });

  test('sem data legível → não renova: na dúvida, não fecha nada', () => {
    expect(demoPagaHaTempo(estado('paga', 'não é data'), agora)).toBe(false);
    expect(demoPagaHaTempo(estado('paga', undefined), agora)).toBe(false);
    expect(demoPagaHaTempo(null, agora)).toBe(false);
  });
});

describe('a rota: a demo paga volta a abrir, e SÓ a demo', () => {
  let srv; let porta; let store; let agoraFalso;

  beforeAll(async () => {
    let route;
    jest.isolateModules(() => { ({ route, store } = require('../_app/router')); });
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv && srv.close());
  afterEach(() => { if (agoraFalso) agoraFalso.mockRestore(); agoraFalso = null; });
  // Cada teste começa de uma demo FRESCA. Sem isto o segundo teste dependia do
  // primeiro ter deixado a conta aberta — e a primeira versão dele tinha um
  // `if (paga) return` que pulava as asserções em silêncio: guarda nascida
  // inerte, dentro do teste escrito pra pegar uma guarda nascida inerte.
  beforeEach(async () => { await resetDemoCheck(store, DEMO_TOKEN); });

  const ler = async (t, ip = '10.9.8.7') => {
    const r = await fetch(`http://127.0.0.1:${porta}/api/check?t=${t}`, { headers: { 'x-real-ip': ip } });
    return r.status === 200 ? (await r.json()).data : { status: r.status };
  };
  const avancar = (ms) => {
    const real = Date.now;
    const alvo = real() + ms;
    agoraFalso = jest.spyOn(Date, 'now').mockReturnValue(alvo);
  };

  test('paga há tempo → a leitura devolve uma conta NOVA, aberta e zerada', async () => {
    const v = await ensureDemoCheck(store, DEMO_TOKEN);
    await pagarTudo(store, v.check.id);
    expect((await ler(DEMO_TOKEN)).state.status).toBe('paga');   // o momento de quem pagou

    avancar(DEMO_TEMPO_DE_GLORIA_MS + 1_000);
    const depois = await ler(DEMO_TOKEN);
    expect(depois.check.id).not.toBe(v.check.id);
    expect(depois.state.status).toBe('aberta');
    expect(depois.state.paidCents).toBe(0);
    expect(depois.state.totalCents).toBe(DEMO_TOTAL_CENTS);
  });

  test('paga agora → quem pagou continua vendo a conta paga', async () => {
    const v = await ensureDemoCheck(store, DEMO_TOKEN);
    expect(v.state.status).toBe('aberta');   // o `beforeEach` garante — e aqui se confere
    await pagarTudo(store, v.check.id);
    const agora = await ler(DEMO_TOKEN);
    expect(agora.check.id).toBe(v.check.id);
    expect(agora.state.status).toBe('paga');
  });

  /**
   * "A ORDEM IMPORTA" — e até aqui nada provava.
   *
   * O comentário da rota diz que o balde da cura é conferido POR ÚLTIMO, pra
   * leitura normal da demo não gastar o limite de ninguém. A revisão de
   * segurança pôs o `rateLimitDemoHeal` na frente e a suíte ficou verde.
   * Perder isso não é de graça: cada iframe da landing sonda a cada 4s, o balde
   * é de 6 por 10 minutos por IP, e atrás de CGNAT — um wi-fi de restaurante —
   * a leitura saudável de um vizinho mataria a cura `!data` de todos.
   */
  test('leituras SAUDÁVEIS da demo não gastam o balde da cura', async () => {
    const ip = '10.77.77.77';
    for (let i = 0; i < 12; i += 1) {
      expect((await ler(DEMO_TOKEN, ip)).state.status).toBe('aberta');
    }
    // A demo some (fechada à mão); o mesmo IP ainda tem balde pra reabri-la.
    const v = await store.getCheckByQrToken(DEMO_TOKEN);
    await store.appendEvent(v.check.id, 'CLOSED', { motivo: 'teste' });
    const curada = await ler(DEMO_TOKEN, ip);
    expect(curada.state && curada.state.status).toBe('aberta');
  });

  test('uma mesa DE VERDADE paga há tempo NUNCA é mexida', async () => {
    // O teste que importa: a mesma rota serve todas as casas. Se a guarda do
    // token sumir, é a conta paga de um restaurante que reabre.
    const venue = await store.createVenue({ name: 'Bar de Verdade', servicoBp: 1000, pspRecipientId: 'rcpt_live_2' });
    const table = await store.seedTable(venue.id, 'Mesa 9', 'tokenrealdecasa123');
    await store.openCheck(table.qrToken, [{ id: 'r1', name: 'Picanha', priceCents: 5000 }]);
    const v = await store.getCheckByQrToken(table.qrToken);
    await store.appendEvent(v.check.id, 'PAYMENT_CONFIRMED',
      { txid: 'tx_real', amountCents: 5000, tipCents: 0, method: 'pix' });

    avancar(10 * DEMO_TEMPO_DE_GLORIA_MS);
    const linhas = [];
    const erro = jest.spyOn(process.stderr, 'write').mockImplementation((l) => { linhas.push(String(l)); return true; });
    let depois;
    try { depois = await ler(table.qrToken); } finally { erro.mockRestore(); }
    expect(depois.check.id).toBe(v.check.id);
    expect(depois.state.status).toBe('paga');
    expect(depois.state.paidCents).toBe(5000);
    /**
     * E A ROTA NEM TENTA. Sem esta asserção, apagar a guarda do token deixava
     * este teste VERDE — medido: o `resetDemoCheck` recusa a mesa real sozinho
     * (`resolveDemoTable`), o `try` engole, e a conta fica intacta. O resultado
     * se sustentava pela camada de baixo; a guarda de cima não era provada por
     * nada. E perdê-la não é de graça: toda leitura de conta paga de
     * restaurante passaria a chamar o reset, estourar, escrever uma linha de
     * erro e gastar o balde de cura daquele IP.
     */
    expect(linhas.filter((l) => l.includes('[demo-renova]'))).toEqual([]);
  });
});

/**
 * A CORRIDA — e o dublê que escondia ela.
 *
 * A revisão de segurança mediu: 20 leituras simultâneas de uma demo paga há
 * mais de 90s, com 5 a 30 ms de latência injetada no store, deixaram DOZE
 * eventos `CLOSED` na mesma conta e onze anomalias `already closed`, de
 * severidade `high`, no razão imutável. Sem latência o store de memória é
 * praticamente síncrono e o resultado sai limpo — 1 CLOSED —, que é por que a
 * primeira versão deste arquivo passava: o dublê não tinha a janela que a
 * produção tem.
 *
 * E não é hipotético: a landing embute a demo num iframe por visitante, cada um
 * sonda a cada 4s, e todos cruzam os 90s na mesma janela. O inegociável #7 pede
 * reserva ATÔMICA conferida — e o `appendEventIfUnchanged(expectedSeq)` já
 * existia no store, sem ser usado aqui.
 */
describe('a renovação é atômica: um CLOSED só, com qualquer quantidade de leitores', () => {
  /**
   * Latência nas FRONTEIRAS de cada chamada ao store — e NÃO dentro da
   * primitiva atômica.
   *
   * A primeira versão deste teste envolvia também o `appendEvent`. Só que o
   * `appendEventIfUnchanged` do dublê confere o `seq` e chama
   * `this.appendEvent` — que passava a ser o método envolvido, com um `await`
   * ENTRE a conferência e a escrita. No Postgres isso é uma instrução só; não
   * existe esse vão. O teste fabricava uma corrida que a produção não tem, e
   * acusou o conserto certo: saíam 2 a 8 CLOSED "mesmo com a reserva". O
   * dublê de verdade é atômico (o `appendEvent` não tem `await` antes do
   * `push`). O que estava errado era a medição.
   */
  const comLatencia = (store) => {
    const devagar = () => new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 25)));
    for (const m of ['getCheckByQrToken', 'loadEvents', 'appendEventIfUnchanged', 'openCheck']) {
      const orig = store[m].bind(store);
      store[m] = async (...a) => { await devagar(); const r = await orig(...a); await devagar(); return r; };
    }
    return store;
  };

  test('vinte resets simultâneos de uma demo paga: EXATAMENTE um CLOSED, e uma conta aberta', async () => {
    const { resetDemoCheck: resetar } = require('../_lib/demo');
    const store = comLatencia(createMemoryStore());
    const v = await ensureDemoCheck(store, DEMO_TOKEN);
    await pagarTudo(store, v.check.id);

    await Promise.allSettled(Array.from({ length: 20 }, () => resetar(store, DEMO_TOKEN)));

    const eventos = await store.loadEvents(v.check.id);
    const fechamentos = eventos.filter((e) => e.type === 'CLOSED');
    expect(fechamentos).toHaveLength(1);
    // E o fechamento DIZ quem fechou: sem isto, o razão da demo não distingue a
    // renovação do dono fechando a mesa (compliance MEDIUM-1).
    expect(fechamentos[0].payload).toMatchObject({ motivo: 'demo-renovada' });
    const agora = await store.getCheckByQrToken(DEMO_TOKEN);
    expect(agora.check.id).not.toBe(v.check.id);
    expect(agora.state.status).toBe('aberta');
  });
});
