'use strict';

/**
 * Local demo server — serves the shared router (api/_app/router.js) on :8787
 * and seeds a believable venue so the flow is clickable end to end.
 *
 *   node dev-server.js          → API on :8787 (memory, or supabase via .env)
 *   cd apps/web && npm run dev  → PWA on :5173 (proxies /api here)
 *
 * The route logic lives in the shared router (also used by the Vercel
 * function); this file only adds the local HTTP listener + the demo seed.
 */

const http = require('http');

// The local server IS the demo, so it says so — before the router is required,
// because `DEMO_MODE` is read once at module load.
//
// Without this the seeded links open a real bill you can never finish paying:
// "Simulate bank confirmation" 404s and then hides itself, so the flow this
// file exists to make "clickable end to end" stopped one tap from the end. An
// explicit opt-out stays, for testing what production does.
//
// This file is never deployed (Vercel serves api/index.js), so it cannot turn
// the forged-webhook route on anywhere that moves real money.
if (process.env.RACHA_DEMO_MODE === undefined) process.env.RACHA_DEMO_MODE = 'true';
// A Espanha falha fechada em produção (ver `chargingAllowed` em markets.js).
// Localmente ela é ligada, senão a mesa espanhola semeada abaixo é uma conta
// que ninguém consegue pagar — e uma tela que não se pode exercitar não se
// pode revisar.
if (process.env.RACHA_ES_ENABLED === undefined) process.env.RACHA_ES_ENABLED = 'true';
/**
 * E O AMBIENTE DIZ QUE É DESENVOLVIMENTO — senão o portão de produção fecha as
 * rotas de dinheiro AQUI.
 *
 * `AMBIENTE` sai de `VERCEL_ENV || RACHA_ENV`, e o desconhecido é tratado como
 * o lado perigoso (produção) de propósito: é assim que uma casa de verdade
 * nunca serve BR Code de mentira. Só que localmente as duas variáveis não
 * existem, então `/api/pay` respondia 503 `platform_misconfigured` e o link
 * semeado logo abaixo virava uma conta que ninguém consegue pagar.
 *
 * É o mesmo argumento que o `RACHA_ES_ENABLED` acima faz, com as mesmas
 * palavras: uma tela que não se pode exercitar não se pode revisar. E o mesmo
 * que torna isto seguro: este arquivo nunca é deployado (a Vercel serve
 * `api/index.js`), então ele não pode abrir portão nenhum onde há dinheiro de
 * verdade. A saída explícita continua — `RACHA_ENV=production node dev-server.js`
 * reproduz o que a produção faz.
 */
if (process.env.RACHA_ENV === undefined && process.env.VERCEL_ENV === undefined) {
  process.env.RACHA_ENV = 'development';
}

const { ensureDemoCheck } = require('./api/_lib/demo');
const crypto = require('crypto');
const { route, store, authClient, useSupabase, DEMO_MODE } = require('./api/_app/router');

const PORT = 8787;

// --- seed a believable venue (local demo only; not run in the deploy) --------
(async () => {
  const bootTag = crypto.randomBytes(2).toString('hex');
  const venue = await store.seedVenue({
    name: useSupabase ? `Bar do Zé [demo ${bootTag}]` : 'Bar do Zé',
    // O documento da casa é semeado porque o comprovante o MOSTRA agora, e uma
    // demo sem ele não revisa a linha que o cliente lê depois de pagar.
    cnpj: '12.345.678/0001-99',
    servicoBp: 1000,
    pspRecipientId: 'rcpt_demo',
  });
  const mesa = await store.seedTable(venue.id, useSupabase ? `Mesa 7 · ${bootTag}` : 'Mesa 7');
  const mesa2 = await store.seedTable(venue.id, useSupabase ? `Mesa 12 · ${bootTag}` : 'Mesa 12');
  await store.openCheck(mesa.qrToken, [
    { id: 'i1', name: 'Picanha na chapa', priceCents: 8990 },
    { id: 'i2', name: 'Chopp artesanal (4x)', priceCents: 5560 },
    { id: 'i3', name: 'Batata rústica', priceCents: 3290 },
    { id: 'i4', name: 'Refrigerante (2x)', priceCents: 1580 },
    { id: 'i5', name: 'Pudim da casa', priceCents: 1890 },
  ]);
  // The public demo table, same token as prod, so the landing's live phone
  // (`/?t=demoracha`) works locally without a special case. Goes through the
  // same `ensureDemoCheck` the server uses, so local gets the SAME venue markers
  // (isTest + rcpt_demo) the identity assertion requires — seeding it by hand
  // here would build a demo table that the server then refuses to touch.
  if (!useSupabase) await ensureDemoCheck(store);
  await store.openCheck(mesa2.qrToken, [
    { id: 'j1', name: 'Moqueca de peixe', priceCents: 12900 },
    { id: 'j2', name: 'Caipirinha (2x)', priceCents: 3980 },
    { id: 'j3', name: 'Arroz e farofa', priceCents: 1500 },
  ]);

  // Uma casa ESPANHOLA, pra o mercado novo ser clicável e não só testável:
  // euro, Bizum, sem linha de serviço, sem documento do pagador.
  const bar = await store.seedVenue({
    name: useSupabase ? `Bar Pepe [demo ${bootTag}]` : 'Bar Pepe',
    cnpj: 'B12345678',         // um NIF espanhol mora na mesma coluna
    servicoBp: 1000,           // gravado à brasileira DE PROPÓSITO: o mercado
    pspRecipientId: 'rcpt_demo', // tem que zerar isto sozinho.
    market: 'es',
  });
  const mesaEs = await store.seedTable(bar.id, useSupabase ? `Mesa 4 · ${bootTag}` : 'Mesa 4');
  await store.openCheck(mesaEs.qrToken, [
    { id: 'e1', name: 'Jamón ibérico', priceCents: 2450 },
    { id: 'e2', name: 'Tortilla de patatas', priceCents: 1200 },
    { id: 'e3', name: 'Croquetas (6 ud.)', priceCents: 980 },
    { id: 'e4', name: 'Caña (3 ud.)', priceCents: 750 },
    { id: 'e5', name: 'Vino de la casa', priceCents: 1400 },
  ]);

  // Saldo da casa: enabled with 15% bonus + a seeded customer wallet holding
  // a confirmed R$100 load (R$15 bonus) so the flow is clickable end to end.
  await store.setHouseConfig(venue.id, { enabled: true, bonusBp: 1500, validityDays: 90 });
  const conta = await store.createHouseAccount({ venueId: venue.id, phone: '11987654321', name: 'Cliente Fiel' });
  const seedLoadTxid = `hlseed${bootTag}${crypto.randomBytes(4).toString('hex')}`;
  await store.registerHouseLoad({
    accountId: conta.id, txid: seedLoadTxid, amountCents: 10000, bonusCents: 1500, validityDays: 90,
  });
  await store.confirmHouseLoad({ txid: seedLoadTxid, confirmedAt: new Date().toISOString() });

  const DEMO_EMAIL = 'dono@bardoze.demo';
  const DEMO_PASS = 'racha-demo-1234';
  let ownerLine = '';
  if (useSupabase && authClient) {
    const { data: created, error } = await authClient.auth.admin.createUser({
      email: DEMO_EMAIL, password: DEMO_PASS, email_confirm: true,
    });
    let userId = created && created.user && created.user.id;
    if (error && /registered|exists/i.test(error.message)) {
      const { data: list } = await authClient.auth.admin.listUsers();
      const u = (list && list.users || []).find((x) => x.email === DEMO_EMAIL);
      userId = u && u.id;
    }
    if (userId) { await store.addVenueMember(venue.id, userId, 'owner'); ownerLine = `  Login  ${DEMO_EMAIL} / ${DEMO_PASS}`; }
  } else {
    await store.addVenueMember(venue.id, 'demo-user-0000', 'owner');
    // "auth desligada" era mentira e custava tempo: o Gate do front pede sessão
    // do Supabase e o `guardUser` do router devolve 501 sem auth configurada.
    // Em memória o lado do CLIENTE roda inteiro; o lado do DONO não abre. Dizer
    // isso na hora vale mais que descobrir depois de clicar em três telas.
    ownerLine = '  Painel/Admin/QRs  precisam de auth — ponha SUPABASE_URL e '
              + 'SUPABASE_SERVICE_ROLE_KEY no .env (em memória o gate não abre)';
  }

  process.stdout.write([
    '', `Racha demo pronto (${useSupabase ? 'SUPABASE worttfotxasxqjaqwpjf' : 'memória'}${DEMO_MODE ? '' : ', SEM modo demo — a confirmação simulada não existe'}):`,
    `  API    http://localhost:${PORT}`,
    `  Conta  http://localhost:5173/?t=${mesa.qrToken}`,
    `  Conta2 http://localhost:5173/?t=${mesa2.qrToken}`,
    `  Cuenta http://localhost:5173/?t=${mesaEs.qrToken}   (Espanha · EUR · Bizum)`,
    `  Carteira http://localhost:5173/carteira?t=${conta.accountToken}`,
    ...(useSupabase ? [
      `  Painel http://localhost:5173/painel?v=${venue.id}`,
      `  Admin  http://localhost:5173/admin`,
    ] : []),
    ownerLine, '', '',
  ].join('\n'));
})().catch((err) => {
  process.stderr.write(`seed failed: ${err.message}\n`);
  process.exit(1);
});

http.createServer((req, res) => route(req, res)).listen(PORT);
