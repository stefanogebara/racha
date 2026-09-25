'use strict';

/**
 * O VIGIA DO DOMÍNIO — `useracha.app` está impresso nos QR das mesas; vencido,
 * vira isca de Pix falso. Casos com RDAP de verdade (a forma do
 * pubapi.registry.google) e a prova de que a linha que AVISA não é morta.
 */
const fs = require('node:fs');
const path = require('node:path');
const { avaliarDominio, vigiarDominio, DIAS_DE_AVISO } = require('../_lib/checks/dominio-watch');

const AGORA = Date.parse('2026-09-25T12:00:00Z');
const rdap = (vence, status = ['client transfer prohibited']) => ({
  status, events: [{ eventAction: 'registration', eventDate: '2026-09-24T22:51:56.842Z' },
    { eventAction: 'expiration', eventDate: vence }],
});
const emDias = (d) => new Date(AGORA + d * 86400000).toISOString();

describe('avaliarDominio', () => {
  test('longe do vencimento: não avisa', () => {
    const r = avaliarDominio(rdap('2027-09-24T22:51:56.842Z'), { agoraMs: AGORA });
    expect([r.avisar, r.codigo, r.dias]).toEqual([false, 'domain_ok', 364]);
  });
  test(`menos de ${DIAS_DE_AVISO} dias: avisa domain_expiring`, () => {
    expect(avaliarDominio(rdap(emDias(DIAS_DE_AVISO - 1)), { agoraMs: AGORA }))
      .toMatchObject({ avisar: true, codigo: 'domain_expiring', dias: DIAS_DE_AVISO - 1 });
    expect(avaliarDominio(rdap(emDias(DIAS_DE_AVISO + 1)), { agoraMs: AGORA }).avisar).toBe(false);
  });
  test('já vencido: dias negativos, avisa', () => {
    expect(avaliarDominio(rdap(emDias(-3)), { agoraMs: AGORA })).toMatchObject({ avisar: true, codigo: 'domain_expiring' });
  });
  test('estado ruim no registro avisa mesmo longe do vencimento', () => {
    for (const s of ['client hold', 'redemption period', 'pending delete', 'Server Hold']) {
      expect(avaliarDominio(rdap('2027-09-24T22:51:56Z', [s]), { agoraMs: AGORA }).codigo).toBe('domain_status_bad');
    }
  });
  test('falha de leitura, JSON sem vencimento ou data inválida: avisa, nunca cala', () => {
    expect(avaliarDominio(null, { agoraMs: AGORA, erro: 'TimeoutError' }).codigo).toBe('domain_read_failed');
    expect(avaliarDominio({ status: [] }, { agoraMs: AGORA }).codigo).toBe('domain_read_failed');
    expect(avaliarDominio(rdap('amanhã'), { agoraMs: AGORA }).codigo).toBe('domain_read_failed');
  });
});

describe('vigiarDominio lê, decide e AVISA', () => {
  const resposta = (json, ok = true, status = 200) => async () => ({ ok, status, json: async () => json });
  const espiao = () => { const chamadas = []; return { chamadas, notificar: async (a) => { chamadas.push(a); } }; };
  let log;
  beforeEach(() => { log = jest.spyOn(process.stderr, 'write').mockImplementation(() => true); });
  afterEach(() => log.mockRestore());

  test('perto do vencimento → um account_alert com o código e o texto', async () => {
    const { chamadas, notificar } = espiao();
    await vigiarDominio(notificar, { buscar: resposta(rdap(emDias(10))), agoraMs: AGORA });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].kind).toBe('account_alert');
    expect(chamadas[0].detail).toMatch(/^domain_expiring: domínio useracha\.app vence em 10 dia/);
  });
  test('RDAP fora do ar (HTTP 503 ou exceção) → avisa', async () => {
    for (const buscar of [resposta(null, false, 503), async () => { throw new Error('ENOTFOUND'); }]) {
      const { chamadas, notificar } = espiao();
      await vigiarDominio(notificar, { buscar, agoraMs: AGORA });
      expect(chamadas.map((c) => c.detail.split(':')[0])).toEqual(['domain_read_failed']);
    }
  });
  test('tudo bem → não avisa; seco → não avisa nem perto do vencimento', async () => {
    const a = espiao();
    await vigiarDominio(a.notificar, { buscar: resposta(rdap('2027-09-24T22:51:56Z')), agoraMs: AGORA });
    expect(a.chamadas).toHaveLength(0);
    const b = espiao();
    await vigiarDominio(b.notificar, { buscar: resposta(rdap(emDias(5))), agoraMs: AGORA, seco: true });
    expect(b.chamadas).toHaveLength(0);
  });
  test('o kind é um que a ponte aceita', () => {
    const { KINDS_DE_FUNDADOR } = require('../_lib/notify');
    expect(KINDS_DE_FUNDADOR.has('account_alert')).toBe(true);
  });
});

test('a conciliação diária chama o vigia com o notificador de verdade e o `dry`', () => {
  const router = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const bloco = router.slice(router.indexOf("url.pathname === '/api/cron/reconcile'"),
    router.indexOf("url.pathname === '/api/cron/retention'"));
  expect(bloco).toMatch(/dominio = await vigiarDominio\(notifyFounderMoneyEvent, \{ seco: url\.searchParams\.get\('dry'\) === '1' \}\)/);
  expect(bloco).toMatch(/data: \{ \.\.\.report, mensagem, envio, dominio \}/);
});
