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

  const ler = async (t) => {
    const r = await fetch(`http://127.0.0.1:${porta}/api/check?t=${t}`, { headers: { 'x-real-ip': '10.9.8.7' } });
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
