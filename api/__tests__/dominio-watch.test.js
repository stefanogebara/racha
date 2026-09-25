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
const NS = [{ ldhName: 'ns1.vercel-dns.com' }, { ldhName: 'ns2.vercel-dns.com' }];
const rdap = (vence, status = ['client transfer prohibited'], nameservers = NS) => ({
  status, nameservers, events: [{ eventAction: 'registration', eventDate: '2026-09-24T22:51:56.842Z' },
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
      // Sem a trava junto, de propósito: o estado ruim é o mais grave e vence.
      expect(avaliarDominio(rdap('2027-09-24T22:51:56Z', [s]), { agoraMs: AGORA }).codigo).toBe('domain_status_bad');
    }
  });
  test('a trava de transferência sumiu: avisa domain_unlocked, com o vencimento longe', () => {
    expect(avaliarDominio(rdap('2027-09-24T22:51:56Z', ['add period']), { agoraMs: AGORA }).codigo).toBe('domain_unlocked');
  });
  test('nameservers que não são os da Vercel: avisa; ordem e ponto final não importam', () => {
    const outros = [{ ldhName: 'ns1.atacante.example' }, { ldhName: 'ns2.vercel-dns.com' }];
    expect(avaliarDominio(rdap('2027-09-24T22:51:56Z', undefined, outros), { agoraMs: AGORA }).codigo).toBe('domain_nameservers_changed');
    expect(avaliarDominio(rdap('2027-09-24T22:51:56Z', undefined, []), { agoraMs: AGORA }).codigo).toBe('domain_nameservers_changed');
    const mesmos = [{ ldhName: 'NS2.VERCEL-DNS.COM.' }, { ldhName: 'ns1.vercel-dns.com' }];
    expect(avaliarDominio(rdap('2027-09-24T22:51:56Z', undefined, mesmos), { agoraMs: AGORA }).codigo).toBe('domain_ok');
  });
  test('falha de leitura, JSON sem vencimento ou data inválida: avisa, nunca cala', () => {
    expect(avaliarDominio(null, { agoraMs: AGORA, erro: 'TimeoutError' }).codigo).toBe('domain_read_failed');
    expect(avaliarDominio({ status: [] }, { agoraMs: AGORA }).codigo).toBe('domain_read_failed');
    expect(avaliarDominio(rdap('amanhã'), { agoraMs: AGORA }).codigo).toBe('domain_read_failed');
  });
});

describe('vigiarDominio lê, decide e AVISA', () => {
  const resposta = (json, ok = true, status = 200) => async () => ({ ok, status, text: async () => JSON.stringify(json) });
  const espiao = () => { const chamadas = []; return { chamadas, notificar: async (a) => { chamadas.push(a); return { ok: true, entregue: true }; } }; };
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
  test('o desfecho da entrega fica no resultado; resposta gigante vira falha de leitura', async () => {
    const a = espiao();
    const r = await vigiarDominio(a.notificar, { buscar: resposta(rdap(emDias(10))), agoraMs: AGORA });
    expect(r.envio).toEqual({ ok: true, entregue: true });
    const b = espiao();
    const gigante = async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(70 * 1024) });
    expect((await vigiarDominio(b.notificar, { buscar: gigante, agoraMs: AGORA })).linha).toMatch(/too_large/);
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

test('a conciliação chama o vigia DEPOIS da autenticação e DEPOIS do aviso de dinheiro, nos dois desfechos', () => {
  const router = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
  const bloco = router.slice(router.indexOf("url.pathname === '/api/cron/reconcile'"),
    router.indexOf("url.pathname === '/api/cron/retention'"));
  expect(bloco).toMatch(/return await vigiarDominio\(notifyFounderMoneyEvent, \{ seco: url\.searchParams\.get\('dry'\) === '1' \}\)/);
  const auth = bloco.indexOf('segredoConfere(');
  const chamadas = [...bloco.matchAll(/await conferirDominio\(\)/g)].map((m) => m.index);
  expect(chamadas).toHaveLength(2);
  // Ramo da explosão: depois do aviso crítico, antes do 500.
  const explodiu = bloco.indexOf("code: 'reconcile_threw'");
  const avisoCritico = bloco.lastIndexOf('notifyFounderReconcile(', explodiu);
  expect(chamadas[0]).toBeGreaterThan(avisoCritico);
  expect(chamadas[0]).toBeLessThan(explodiu);
  // Ramo normal: depois do ÚLTIMO aviso da conciliação.
  expect(chamadas[1]).toBeGreaterThan(bloco.lastIndexOf('notifyFounderReconcile('));
  expect(bloco.indexOf('const conferirDominio')).toBeGreaterThan(auth);
  expect(bloco).toMatch(/data: \{ \.\.\.report, mensagem, envio, dominio \}/);
});
