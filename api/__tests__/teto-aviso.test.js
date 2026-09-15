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
 * Um teste que anda no RELÓGIO grava linhas "no futuro", e elas contam na
 * janela de quem vier depois. Os que gravam no futuro em chave COMPARTILHADA (o
 * orçamento global) vêm por último; os outros só gravam em chaves próprias —
 * da casa, da conta — que nenhum outro teste lê.
 */

// A PONTE DE AVISO é um endereço que recusa na hora: nenhum teste daqui fala
// com a ponte de verdade, e o da ponte que FALHA precisa de uma que falhe.
process.env.RACHA_NOTIFY_URL = 'http://127.0.0.1:1';
// O `@vercel/functions` é o DE VERDADE: o teste do `waitUntil` instala um
// contexto de requisição no mesmo símbolo que a Vercel usa, e o pacote o lê. Com
// o pacote mocado, um nome de símbolo errado passava verde (segurança LOW-2 de
// 40d5c50).

const http = require('node:http');
const { TETO_PENDENTES, JANELA_VIVA_MS, geracaoDoQr } = require('../_lib/pay/create-charge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

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
  // Um contexto de requisição da Vercel, no símbolo que ela usa.
  const comContexto = () => {
    const waitUntil = jest.fn();
    const sim = Symbol.for('@vercel/request-context');
    const antes = globalThis[sim];
    globalThis[sim] = { get: () => ({ waitUntil }) };
    return { waitUntil, volta: () => { if (antes === undefined) delete globalThis[sim]; else globalThis[sim] = antes; } };
  };
  const ultimas = (frase, n) => process.stderr.write.mock.calls.map(([t]) => String(t)).filter((t) => t.includes(frase)).slice(-n);
  // Atrasa as reivindicações de ALERTA: separa "a resposta saiu" de "o aviso saiu".
  const atrasarAvisos = (ms) => {
    const orig = lojaDoRouter.claimSlots;
    lojaDoRouter.claimSlots = async (a) => {
      if (a.keys[0].startsWith('alerta')) await sleep(ms);
      return orig.call(lojaDoRouter, a);
    };
    return () => { lojaDoRouter.claimSlots = orig; };
  };

  test('com o contexto da Vercel, o `waitUntil` DELA recebe a promessa do aviso — que só resolve depois de o aviso sair', async () => {
    // A primeira versão conferia que o `waitUntil` recebia "uma promessa", e
    // `waitUntil(Promise.resolve())` passava verde (segurança L-A de 3a10835); a
    // segunda mocava o pacote, e o ramo de produção nunca rodava (LOW-2 de 40d5c50).
    const t = await mesaCheia(casa('Espera'), 'W1');
    const ctx = comContexto();
    const volta = atrasarAvisos(300);
    try {
      const antes = avisos().length;
      expect((await pagar(t.qrToken, '10.83.0.1')).status).toBe(429);
      expect(avisos().length - antes).toBe(0);          // a recusa saiu ANTES do aviso
      expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
      await ctx.waitUntil.mock.calls[0][0];
      expect(avisos().length - antes).toBe(1);          // e a promessa entregue é a do aviso
    } finally { volta(); ctx.volta(); }
  });

  test('SEM contexto de requisição, o aviso sai ANTES da resposta — e uma linha diz por quê', async () => {
    const t = await mesaCheia(casa('Sem Espera'), 'SE1');
    const volta = atrasarAvisos(300);
    try {
      const antes = avisos().length;
      expect((await pagar(t.qrToken, '10.90.0.1')).status).toBe(429);
      expect(avisos().length - antes).toBe(1);          // já tinha saído quando a resposta chegou
      expect(linhas('SEM waitUntil')).toBeGreaterThan(0);
    } finally { volta(); }
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

  test('a suspensão de RECARGA não cala a de MESA — cada tipo tem a sua, com o remédio dele', async () => {
    // (Compliance MEDIUM-1 e segurança LOW-4 de 40d5c50.)
    const { avisarTetoDisparado } = require('../_app/router');
    const venue = casa('Dois Tipos');
    const SUSP = 'AVISOS DA CASA SUSPENSOS';
    for (let i = 0; i < 3; i += 1) await lojaDoRouter.claimSlots({ keys: [`alerta-dia:venue:${venue.id}:recarga`], limits: [3], windowMs: DIA });
    const s0 = linhas(SUSP);
    await avisarTetoDisparado({ code: 'too_many_pending_loads_venue', venueId: venue.id, statusCode: 429 });
    expect(linhas(SUSP) - s0).toBe(1);
    expect(ultimas(SUSP, 1)[0]).toMatch(/não há QR a girar/);
    for (let i = 0; i < 3; i += 1) await lojaDoRouter.claimSlots({ keys: [`alerta-dia:venue:${venue.id}:mesa`], limits: [3], windowMs: DIA });
    const t = await mesaCheia(venue, 'DT1');
    expect((await pagar(t.qrToken, '10.94.0.1')).status).toBe(429);
    expect(linhas(SUSP) - s0).toBe(2);                 // a da mesa sai também
    expect(ultimas(SUSP, 1)[0]).toMatch(/girar no painel o QR/);
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

  test('a PONTE falha: a vaga da hora da divergência VOLTA — a volta seguinte tenta de novo', async () => {
    // Guardada, uma falha passageira da ponte atrasava a página em até uma hora
    // (segurança LOW-3 de 40d5c50). A ponte é 127.0.0.1:1, que recusa na hora.
    const segredoCron = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'cron-de-teste-0123456789abcdef';
    process.env.RACHA_NOTIFY_SECRET = 'segredo-de-teste';
    const orig = lojaDoRouter.slotsFingerprint;
    lojaDoRouter.slotsFingerprint = async () => 'e'.repeat(32);
    const cron = () => fetch(`http://127.0.0.1:${porta}/api/cron/reconcile-pending`,
      { headers: { authorization: 'Bearer cron-de-teste-0123456789abcdef' } });
    const DIVERGE = 'A 0033 EM PRODUÇÃO NÃO É A DESTE DEPLOY';
    try {
      const d0 = linhas(DIVERGE);
      await cron(); await cron();
      expect(linhas(DIVERGE) - d0).toBe(2);             // as duas voltas tentaram
    } finally {
      lojaDoRouter.slotsFingerprint = orig;
      delete process.env.RACHA_NOTIFY_SECRET;
      if (segredoCron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = segredoCron;
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

  test('o orçamento GLOBAL esgotado: cada casa atacada recebe a SUA suspensão, com o nome dela', async () => {
    // Com uma chave de suspensão global só, uma casa-isca tomava a vaga a cada
    // seis horas e a casa atacada nunca era nomeada (segurança LOW-1 de
    // 40d5c50). Por último neste arquivo: esgota o orçamento do dia.
    while ((await lojaDoRouter.claimSlots({ keys: ['alerta-dia:global'], limits: [12], windowMs: DIA })).claimId) { /* esgota */ }
    const SUSP = 'AVISOS DE TETO SUSPENSOS';
    const antesA = avisos().length; const s0 = linhas(SUSP);
    const casas = [casa('Fim Um'), casa('Fim Dois')];
    for (const [i, venue] of casas.entries()) {
      const t = await mesaCheia(venue, 'F1');
      expect((await pagar(t.qrToken, `10.88.0.${i + 1}`)).status).toBe(429);
    }
    expect(avisos().length - antesA).toBe(0);
    expect(linhas(SUSP) - s0).toBe(2);
    const [primeira, segunda] = ultimas(SUSP, 2);
    expect(primeira).toContain(`casa ${casas[0].id} · Fim Um`);
    expect(segunda).toContain(`casa ${casas[1].id} · Fim Dois`);
    // A mesma casa, outra mesa, na mesma janela: não repete.
    const t = await mesaCheia(casas[0], 'F2');
    expect((await pagar(t.qrToken, '10.88.0.9')).status).toBe(429);
    expect(linhas(SUSP) - s0).toBe(2);
  });

  test('o orçamento de SUSPENSÕES esgotado: sai UM resumo, nomeando a casa de agora — e depois, só log', async () => {
    // Por casa e tipo sem teto acima, vinte casas criadas por quem se cadastra
    // davam 160 páginas por dia (segurança MEDIUM-1 e compliance MEDIUM-D de
    // 497bf87). Depois do teste do orçamento global: ele já está esgotado.
    while ((await lojaDoRouter.claimSlots({ keys: ['alerta-dia:suspensoes'], limits: [12], windowMs: DIA })).claimId) { /* esgota */ }
    const RES = 'SUSPENSÕES EM MASSA';
    const suspensoes = () => linhas('AVISOS DE TETO SUSPENSOS') + linhas('AVISOS DA CASA SUSPENSOS');
    const r0 = linhas(RES); const s0 = suspensoes();
    const casas = [casa('Massa Um'), casa('Massa Dois')];
    for (const [i, venue] of casas.entries()) {
      const t = await mesaCheia(venue, 'M1');
      expect((await pagar(t.qrToken, `10.95.0.${i + 1}`)).status).toBe(429);
    }
    expect(linhas(RES) - r0).toBe(1);
    expect(ultimas(RES, 1)[0]).toContain(`casa ${casas[0].id} · Massa Um`);
    expect(suspensoes() - s0).toBe(0);
  });
});
