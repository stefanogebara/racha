'use strict';

/**
 * O AVISO DE TETO DISPARADO — o comportamento, pelo router, com um store
 * PRÓPRIO.
 *
 * Arquivo à parte por um motivo de conta, não de gosto: o orçamento global é de
 * doze avisos por dia por store, e cada teste que pagina gasta um. No mesmo
 * arquivo que o resto do teto, os testes desta rodada passavam de doze e
 * começavam a medir o orçamento esgotado em vez do que diziam medir. O jest dá
 * a cada arquivo um registro de módulos — e um store — novo.
 *
 * Os testes que andam no RELÓGIO (seis horas, um dia) vêm depois dos que não
 * andam: uma linha criada "no futuro" conta na janela de quem vier depois.
 */

// A PONTE DE AVISO é um endereço que recusa na hora: nenhum teste daqui fala
// com a ponte de verdade, e o da ponte que FALHA precisa de uma que falhe.
process.env.RACHA_NOTIFY_URL = 'http://127.0.0.1:1';
// O `waitUntil` da Vercel, observado.
jest.mock('@vercel/functions', () => ({ waitUntil: jest.fn() }));

const http = require('node:http');
const { TETO_PENDENTES, JANELA_VIVA_MS, geracaoDoQr } = require('../_lib/pay/create-charge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HORA = 60 * 60 * 1000;

beforeAll(() => {
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // Sem segredo da ponte o aviso vai pro stderr, que é onde estes testes o leem.
  delete process.env.RACHA_NOTIFY_SECRET;
});
afterAll(() => { jest.restoreAllMocks(); });

describe('o aviso de teto disparado, pelo router', () => {
  const { route, store: lojaDoRouter } = require('../_app/router');
  let porta; let srv;
  beforeAll(async () => {
    srv = http.createServer(route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    porta = srv.address().port;
  });
  afterAll(() => srv && srv.close());

  const CONTA = [{ id: 'i', name: 'X', priceCents: 900000 }];
  let v = 0;
  const pagar = (token, ip) => fetch(`http://127.0.0.1:${porta}/api/pay`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ token, amountCents: 1 + (v += 1), tipCents: 0 }),
  });
  const avisos = () => process.stderr.write.mock.calls
    .filter(([t]) => String(t).includes('TETO DE COBRANÇAS DISPAROU'));
  const linhas = (frase) => process.stderr.write.mock.calls.filter(([t]) => String(t).includes(frase)).length;
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
  const mesaCheia = async (venue, rotulo) => {
    const t = lojaDoRouter.seedTable(venue.id, rotulo);
    await lojaDoRouter.openCheck(t.qrToken, CONTA);
    await encher(t.qrToken);
    return t;
  };
  const casa = (nome) => lojaDoRouter.seedVenue({ name: nome, servicoBp: 1000, pspRecipientId: `rcpt_${nome.replace(/\W/g, '_')}` });
  // O relógio que os testes adiantam. O store e o router leem `Date.now`.
  const adiantavel = () => {
    const real = Date.now.bind(Date);
    const r = { desloc: 0 };
    r.spy = jest.spyOn(Date, 'now').mockImplementation(() => real() + r.desloc);
    return r;
  };
  // Atrasa as reivindicações de ALERTA: separa "a resposta saiu" de "o aviso saiu".
  const atrasarAvisos = (ms) => {
    const orig = lojaDoRouter.claimSlots;
    lojaDoRouter.claimSlots = async (a) => {
      if (a.keys[0].startsWith('alerta')) await sleep(ms);
      return orig.call(lojaDoRouter, a);
    };
    return () => { lojaDoRouter.claimSlots = orig; };
  };

  test('o `waitUntil` recebe a promessa DO AVISO — ela só resolve depois de o aviso sair', async () => {
    // A primeira versão só conferia que recebeu "uma promessa", e
    // `waitUntil(Promise.resolve())` passava verde. (Segurança L-A de 3a10835.)
    const { waitUntil } = require('@vercel/functions');
    const t = await mesaCheia(casa('Espera'), 'W1');
    const volta = atrasarAvisos(300);
    try {
      waitUntil.mockClear();
      const antes = avisos().length;
      expect((await pagar(t.qrToken, '10.83.0.1')).status).toBe(429);
      expect(avisos().length - antes).toBe(0);          // a recusa saiu ANTES do aviso
      expect(waitUntil).toHaveBeenCalledTimes(1);
      await waitUntil.mock.calls[0][0];
      expect(avisos().length - antes).toBe(1);          // e a promessa entregue é a do aviso
    } finally { volta(); }
  });

  test('na Vercel SEM contexto de requisição, o aviso sai ANTES da resposta — e uma linha diz por quê', async () => {
    const { waitUntil } = require('@vercel/functions');
    const vercel = process.env.VERCEL;
    process.env.VERCEL = '1';   // e nenhum contexto no símbolo global: o `waitUntil` do pacote não faria nada
    const t = await mesaCheia(casa('Sem Espera'), 'SE1');
    const volta = atrasarAvisos(300);
    try {
      waitUntil.mockClear();
      const antes = avisos().length;
      expect((await pagar(t.qrToken, '10.90.0.1')).status).toBe(429);
      expect(avisos().length - antes).toBe(1);          // já tinha saído quando a resposta chegou
      expect(waitUntil).not.toHaveBeenCalled();
      expect(linhas('SEM waitUntil na Vercel')).toBeGreaterThan(0);
    } finally {
      volta();
      if (vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = vercel;
    }
  });

  test('GIRAR o QR e o ataque voltar na geração NOVA pagina de novo, na hora; na mesma geração, não', async () => {
    const venue = lojaDoRouter.seedVenue({ name: 'Volta', servicoBp: 1000, pspRecipientId: 'rcpt_volta' });
    const table = lojaDoRouter.seedTable(venue.id, 'G1');
    await lojaDoRouter.openCheck(table.qrToken, CONTA);
    await encher(table.qrToken);
    const antes = avisos().length;
    expect((await pagar(table.qrToken, '10.85.0.1')).status).toBe(429);
    expect((await pagar(table.qrToken, '10.85.0.2')).status).toBe(429);
    expect(avisos().length - antes).toBe(1);
    const girado = await lojaDoRouter.rotateTableQr(table.id);
    await encher(girado.qrToken);
    expect((await pagar(girado.qrToken, '10.85.0.3')).status).toBe(429);
    expect(avisos().length - antes).toBe(2);
  });

  test('orçamento da CASA cheio não é só log: sai UM aviso de SUSPENSÃO da casa, e ele se repete em seis horas', async () => {
    // O quarto disparo numa casa ia só pro stderr (#8). (Compliance MEDIUM-A de 3a10835.)
    const venue = casa('Casa Visada');
    const SUSP = 'AVISOS DA CASA SUSPENSOS';
    const antes = avisos().length; const s0 = linhas(SUSP);
    for (let m = 1; m <= 5; m += 1) {
      const t = await mesaCheia(venue, `V${m}`);
      expect((await pagar(t.qrToken, `10.86.${m}.1`)).status).toBe(429);
    }
    expect(avisos().length - antes).toBe(3);
    expect(linhas(SUSP) - s0).toBe(1);                  // o quarto suspende; o quinto, na mesma janela, não repete
    const relogio = adiantavel();
    try {
      relogio.desloc = 6 * HORA + 11 * 60 * 1000;
      const t = await mesaCheia(venue, 'V6');
      expect((await pagar(t.qrToken, '10.86.6.1')).status).toBe(429);
      expect(linhas(SUSP) - s0).toBe(2);                // seis horas depois, com disparo contido, repete
    } finally { relogio.spy.mockRestore(); }
  });

  test('uma reivindicação SEGUINTE que estoura devolve as anteriores — a conta não fica calada seis horas', async () => {
    // (Compliance LOW-A de 3a10835: só a PRIMEIRA reivindicação era testada.)
    const t = await mesaCheia(casa('Estouro'), 'E1');
    const orig = lojaDoRouter.claimSlots;
    let falhou = false;
    lojaDoRouter.claimSlots = async (a) => {
      if (!falhou && a.keys[0].startsWith('alerta-dia:')) { falhou = true; throw new Error('statement timeout'); }
      return orig.call(lojaDoRouter, a);
    };
    const relogio = adiantavel();
    try {
      const antes = avisos().length;
      expect((await pagar(t.qrToken, '10.92.0.1')).status).toBe(429);   // a segunda reivindicação estoura
      expect(avisos().length - antes).toBe(0);
      relogio.desloc = 61_000;
      expect((await pagar(t.qrToken, '10.92.0.2')).status).toBe(429);
      expect(avisos().length - antes).toBe(1);
    } finally {
      lojaDoRouter.claimSlots = orig;
      relogio.spy.mockRestore();
    }
  });

  test('um ERRO de RPC no aviso recua UM MINUTO — não cala a conta pela janela inteira', async () => {
    // O atalho local era marcado ANTES das reivindicações e valia quinze
    // minutos: um erro de RPC calava a conta nesta instância pelo quarto de
    // hora. (Segurança de 7a65e93.)
    const table = await mesaCheia(casa('Recuo'), 'R1');
    const orig = lojaDoRouter.claimSlots;
    let falhou = false;
    lojaDoRouter.claimSlots = async (a) => {
      if (!falhou && a.keys[0].startsWith('alerta:')) { falhou = true; throw new Error('rpc caiu'); }
      return orig.call(lojaDoRouter, a);
    };
    const relogio = adiantavel();
    try {
      const antes = avisos().length;
      expect((await pagar(table.qrToken, '10.87.0.1')).status).toBe(429);   // a RPC do aviso cai
      expect((await pagar(table.qrToken, '10.87.0.2')).status).toBe(429);   // recuo: nem tenta
      expect(avisos().length - antes).toBe(0);
      relogio.desloc = 61_000;
      expect((await pagar(table.qrToken, '10.87.0.3')).status).toBe(429);
      expect(avisos().length - antes).toBe(1);
    } finally {
      lojaDoRouter.claimSlots = orig;
      relogio.spy.mockRestore();
    }
  });

  test('a PONTE FALHA: as vagas de alerta voltam, e a instância recua um minuto em vez de tentar a cada 429', async () => {
    // A ponte é 127.0.0.1:1 (topo do arquivo), que recusa na hora.
    process.env.RACHA_NOTIFY_SECRET = 'segredo-de-teste';
    const table = await mesaCheia(casa('Ponte'), 'P1');
    const orig = lojaDoRouter.claimSlots;
    const tomadas = [];
    lojaDoRouter.claimSlots = async (a) => {
      const r = await orig.call(lojaDoRouter, a);
      if (a.keys[0].startsWith('alerta:check:')) tomadas.push(r.claimId !== null);
      return r;
    };
    const relogio = adiantavel();
    try {
      expect((await pagar(table.qrToken, '10.89.0.1')).status).toBe(429);
      expect(tomadas).toEqual([true]);          // tomou a vaga do aviso; a ponte recusou
      expect((await pagar(table.qrToken, '10.89.0.2')).status).toBe(429);
      expect(tomadas).toEqual([true]);          // recuo local: nem reivindicou de novo
      relogio.desloc = 61_000;
      expect((await pagar(table.qrToken, '10.89.0.3')).status).toBe(429);
      expect(tomadas).toEqual([true, true]);    // a vaga VOLTOU: reivindicou de novo e ganhou
    } finally {
      delete process.env.RACHA_NOTIFY_SECRET;
      lojaDoRouter.claimSlots = orig;
      relogio.spy.mockRestore();
    }
  });

  test('o cron pagina a divergência da 0033 uma vez por HORA, e só chama de erro depois de DUAS sondas', async () => {
    // Noventa e seis páginas por dia no canal do canário de conciliação, e uma
    // falha passageira dizendo "ninguém consegue pagar". (Segurança L-D e
    // compliance LOW-D de 3a10835.)
    const segredo = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'cron-de-teste-0123456789abcdef';
    const orig = lojaDoRouter.slotsFingerprint;
    const cron = () => fetch(`http://127.0.0.1:${porta}/api/cron/reconcile-pending`,
      { headers: { authorization: 'Bearer cron-de-teste-0123456789abcdef' } });
    const DIVERGE = 'A 0033 EM PRODUÇÃO NÃO É A DESTE DEPLOY'; const FALHA = 'A SONDA DO TETO FALHOU';
    try {
      const d0 = linhas(DIVERGE); const f0 = linhas(FALHA);
      const conta = () => [linhas(DIVERGE) - d0, linhas(FALHA) - f0];
      expect((await cron()).status).toBe(200);
      expect(conta()).toEqual([0, 0]);
      lojaDoRouter.slotsFingerprint = async () => 'f'.repeat(32);   // a 0033 de outra versão
      await cron(); await cron();
      expect(conta()).toEqual([1, 0]);                  // a mesma divergência, uma vez na hora
      let n = 0;
      lojaDoRouter.slotsFingerprint = async () => { n += 1; if (n === 1) throw new Error('PGRST000 passageiro'); return orig.call(lojaDoRouter); };
      await cron();
      expect(conta()).toEqual([1, 0]);                  // uma falha e depois a resposta certa: nada
      lojaDoRouter.slotsFingerprint = async () => { throw new Error('PGRST202 função não existe'); };
      await cron();
      expect(conta()).toEqual([1, 1]);                  // duas falhas: pagina
    } finally {
      lojaDoRouter.slotsFingerprint = orig;
      if (segredo === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = segredo;
    }
  });

  test('quando o orçamento da casa REABRE, a conta contida pagina — a vaga dela voltou na recusa', async () => {
    // Guardada, a vaga de deduplicação calava a conta seis horas depois de o
    // orçamento abrir. (Segurança L-B de 3a10835.) Anda no relógio: vem depois
    // dos que não andam.
    const venue = casa('Reabre');
    for (let m = 1; m <= 3; m += 1) {
      const t = await mesaCheia(venue, `Q${m}`);
      expect((await pagar(t.qrToken, `10.93.${m}.1`)).status).toBe(429);
    }
    const relogio = adiantavel();
    try {
      relogio.desloc = 23 * HORA;
      const t = await mesaCheia(venue, 'Q4');
      const antes = avisos().length;
      expect((await pagar(t.qrToken, '10.93.4.1')).status).toBe(429);  // orçamento cheio: contida
      expect(avisos().length - antes).toBe(0);
      relogio.desloc = 24 * HORA + 2 * 60 * 1000;                      // os três da casa saíram da janela
      await encher(t.qrToken);                                        // a janela da conta também passou
      expect((await pagar(t.qrToken, '10.93.4.2')).status).toBe(429);
      expect(avisos().length - antes).toBe(1);
    } finally { relogio.spy.mockRestore(); }
  });

  test('mesa e recarga têm orçamentos SEPARADOS — três avisos de recarga não calam a mesa da mesma casa', async () => {
    // Um QR de mesa abre carteiras (o `/api/house/open` aceita o token da mesa),
    // gastava os três avisos da casa em "RECARGAS PAUSADAS… a conta da mesa não é
    // afetada" e então trancava a mesa, que ia só pro log. (Compliance MEDIUM-A
    // de 3a10835.) Longe no relógio, pra não disputar o orçamento global.
    const { avisarTetoDisparado } = require('../_app/router');
    const venue = casa('Orcamentos');
    const relogio = adiantavel();
    try {
      const r0 = linhas('RECARGAS PAUSADAS');
      for (let i = 0; i < 3; i += 1) {
        relogio.desloc = 100 * HORA + i * (6 * HORA + 60_000);
        await avisarTetoDisparado({ code: 'too_many_pending_loads_venue', venueId: venue.id, statusCode: 429 });
      }
      expect(linhas('RECARGAS PAUSADAS') - r0).toBe(3);
      const t = await mesaCheia(venue, 'O1');
      const antes = avisos().length;
      expect((await pagar(t.qrToken, '10.91.0.1')).status).toBe(429);
      expect(avisos().length - antes).toBe(1);
    } finally { relogio.spy.mockRestore(); }
  });

  test('o teto DIÁRIO: esgotado, sai UM aviso de que acabou — e depois só o log', async () => {
    // Antes, do décimo terceiro em diante o único rastro era uma linha de
    // stderr (#8). Por último neste arquivo: esgota o contador do dia.
    while ((await lojaDoRouter.claimSlots({ keys: ['alerta-dia:global'], limits: [12], windowMs: 86_400_000 })).claimId) { /* esgota */ }
    const SUSPENSOS = 'AVISOS DE TETO SUSPENSOS';
    const antesA = avisos().length; const antesS = linhas(SUSPENSOS);
    for (let i = 1; i <= 2; i += 1) {
      const t = await mesaCheia(casa(`Fim ${i}`), 'F1');
      expect((await pagar(t.qrToken, `10.88.0.${i}`)).status).toBe(429);
    }
    expect(avisos().length - antesA).toBe(0);
    expect(linhas(SUSPENSOS) - antesS).toBe(1);
  });
});
