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

const { ensureDemoCheck } = require('./api/_lib/demo');
const crypto = require('crypto');
const { route, store, authClient, useSupabase, DEMO_MODE } = require('./api/_app/router');

const PORT = 8787;

// --- seed a believable venue (local demo only; not run in the deploy) --------
(async () => {
  const bootTag = crypto.randomBytes(2).toString('hex');
  const venue = await store.seedVenue({
    name: useSupabase ? `Bar do Zé [demo ${bootTag}]` : 'Bar do Zé',
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
    ownerLine = '  Login  (modo memória — auth desligada)';
  }

  process.stdout.write([
    '', `Racha demo pronto (${useSupabase ? 'SUPABASE worttfotxasxqjaqwpjf' : 'memória'}${DEMO_MODE ? '' : ', SEM modo demo — a confirmação simulada não existe'}):`,
    `  API    http://localhost:${PORT}`,
    `  Conta  http://localhost:5173/?t=${mesa.qrToken}`,
    `  Conta2 http://localhost:5173/?t=${mesa2.qrToken}`,
    `  Carteira http://localhost:5173/carteira?t=${conta.accountToken}`,
    `  Painel http://localhost:5173/painel?v=${venue.id}`,
    `  Admin  http://localhost:5173/admin`,
    ownerLine, '', '',
  ].join('\n'));
})().catch((err) => {
  process.stderr.write(`seed failed: ${err.message}\n`);
  process.exit(1);
});

http.createServer((req, res) => route(req, res)).listen(PORT);
