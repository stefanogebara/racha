'use strict';

/**
 * Local demo server — the whole Racha flow, no cloud dependencies.
 *
 *   node dev-server.js          → API on :8787, seeded demo check
 *   cd apps/web && npm run dev  → PWA on :5173 (proxies /api here)
 *
 * Memory store + MockPsp. Webhooks are SIGNED and verified even here — the
 * demo exercises the production verification path (no dev bypass exists).
 * The one dev-only affordance is POST /api/dev/confirm, which plays the role
 * of "the diner's bank app confirming the Pix" by emitting the signed
 * webhook a real PSP would send.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require('./api/_lib/store/memory');
const { MockPsp } = require('./api/_lib/pay/mock-psp');
const { createWebhookHandler } = require('./api/_lib/pay/webhook-handler');
const { createChargeService } = require('./api/_lib/pay/create-charge');

// Minimal .env loader (no dependency): KEY=VALUE lines, no interpolation.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const PORT = 8787;
// RACHA_STORE=supabase runs the same demo against the real project
// (requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env).
const useSupabase = process.env.RACHA_STORE === 'supabase';
const store = useSupabase
  ? require('./api/_lib/store/supabase').createSupabaseStore()
  : createMemoryStore();
const psp = new MockPsp({ webhookSecret: crypto.randomBytes(24).toString('hex') });
const charge = createChargeService({ store, psp });
const { createCheckService } = require('./api/_lib/checks/check-service');
const checkSvc = createCheckService({ store });
const { resolvePosAdapter } = require('./api/_lib/pos/adapter');

// Owner auth — needs a Supabase client to verify GoTrue tokens. Present only
// when SUPABASE creds are configured; without it, authed endpoints refuse
// (501) rather than silently opening.
const { createAuth, AuthError } = require('./api/_lib/auth');
let auth = null;
let authClient = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  auth = createAuth({ authClient, store });
}
/** Guard: resolve the caller to a user, or send 401/501 and return null. */
async function guardUser(req, res) {
  if (!auth) { json(res, 501, { success: false, error: 'auth não configurado (rode em modo supabase)' }); return null; }
  try { return await auth.requireUser(req); }
  catch (e) { json(res, e.statusCode || 401, { success: false, error: e.message }); return null; }
}
const handleWebhook = createWebhookHandler({
  loadEvents: store.loadEvents.bind(store),
  appendEvent: store.appendEvent.bind(store),
  recordPayment: store.recordPayment.bind(store),
  findCheckByTxid: store.findCheckByTxid.bind(store),
  psp,
});

// --- seed a believable venue (store-agnostic: memory OR supabase) -----------
// Against supabase, demo tables get unique labels per boot (unique venue_id+label)
// and the venue is tagged [demo] so it is recognizable in the dashboard.
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
  await store.openCheck(mesa2.qrToken, [
    { id: 'j1', name: 'Moqueca de peixe', priceCents: 12900 },
    { id: 'j2', name: 'Caipirinha (2x)', priceCents: 3980 },
    { id: 'j3', name: 'Arroz e farofa', priceCents: 1500 },
  ]);

  // Demo owner — so /painel and /admin (now owner-gated) are reachable. Real
  // GoTrue user via the admin API when in supabase mode; the frontend logs in
  // with these creds. In memory mode there's no GoTrue, so we mint a fake
  // user id and link it (auth verification is disabled in memory mode anyway).
  const DEMO_EMAIL = 'dono@bardoze.demo';
  const DEMO_PASS = 'racha-demo-1234';
  let ownerLine = '';
  if (useSupabase && authClient) {
    // Idempotent: ignore "already registered".
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
    '', `Racha demo pronto (${useSupabase ? 'SUPABASE worttfotxasxqjaqwpjf' : 'memória'}):`,
    `  API    http://localhost:${PORT}`,
    `  Conta  http://localhost:5173/?t=${mesa.qrToken}`,
    `  Conta2 http://localhost:5173/?t=${mesa2.qrToken}`,
    `  Painel http://localhost:5173/painel?v=${venue.id}`,
    `  Admin  http://localhost:5173/admin`,
    ownerLine,
    '', '',
  ].join('\n'));
})().catch((err) => {
  process.stderr.write(`seed failed: ${err.message}\n`);
  process.exit(1);
});

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type,x-racha-signature',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * POS write-back after a confirmed payment. Resolves the venue's adapter and
 * posts the payment to the POS so it shows the table settled. Manual mode is a
 * no-op. Best-effort: a POS sync failure must never fail the diner's payment
 * (the money already moved) — it's logged for the panel to surface.
 */
async function writeBackToPos(checkId) {
  try {
    const venue = await store.getVenueForCheck(checkId);
    if (!venue) return;
    const adapter = resolvePosAdapter(venue);
    if (!adapter.capabilities.writeBack) return; // manual: nothing to sync
    await adapter.writeBackPayment({ venue, checkId });
  } catch (err) {
    process.stderr.write(`writeBackToPos(${checkId}) failed (non-fatal): ${err.message}\n`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'OPTIONS') return json(res, 200, {});

    if (req.method === 'GET' && url.pathname === '/api/check') {
      const data = await store.getCheckByQrToken(url.searchParams.get('t') || '');
      if (!data) return json(res, 404, { success: false, error: 'Conta não encontrada' });
      return json(res, 200, { success: true, data });
    }

    if (req.method === 'POST' && url.pathname === '/api/pay') {
      const body = JSON.parse(await readBody(req) || '{}');
      const view = await store.getCheckByQrToken(body.token || '');
      if (!view) return json(res, 404, { success: false, error: 'Conta não encontrada' });
      const result = await charge({
        checkId: view.check.id,
        amountCents: body.amountCents,
        tipCents: body.tipCents ?? 0,
        payerLabel: body.payerLabel ?? null,
      });
      return json(res, 200, { success: true, data: result });
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/psp') {
      const raw = await readBody(req);
      const result = await handleWebhook(raw, req.headers['x-racha-signature']);
      if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
        await writeBackToPos(result.checkId); // POS sync (manual: no-op)
      }
      const status = result.status === 'rejected' ? 409 : 200;
      return json(res, status, { success: status === 200, data: result });
    }

    // Restaurant panel — owner-gated.
    if (req.method === 'GET' && url.pathname === '/api/panel') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const data = await store.getPanelView(venueId);
      if (!data) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      return json(res, 200, { success: true, data });
    }

    // --- manual check lifecycle (owner-gated) --------------------------------
    // POS adapter, manual mode: the owner pushes the check from the panel.
    if (req.method === 'POST' && url.pathname === '/api/checks') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.tableId) return json(res, 400, { success: false, error: 'tableId é obrigatório' });
      try { await auth.requireTableOwner(user, b.tableId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      try {
        const r = await checkSvc.openCheck({ tableId: b.tableId, items: b.items, totalCents: b.totalCents });
        return json(res, 200, { success: true, data: r });
      } catch (e) { return json(res, e.statusCode || 400, { success: false, error: e.message }); }
    }
    if (req.method === 'POST' && (url.pathname === '/api/checks/adjust' || url.pathname === '/api/checks/close')) {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.checkId) return json(res, 400, { success: false, error: 'checkId é obrigatório' });
      const venue = await store.getVenueForCheck(b.checkId);
      if (!venue) return json(res, 404, { success: false, error: 'conta não encontrada' });
      try { await auth.requireVenueOwner(user, venue.id); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      try {
        const r = url.pathname.endsWith('close')
          ? await checkSvc.closeCheck({ checkId: b.checkId })
          : await checkSvc.adjustCheck({ checkId: b.checkId, items: b.items, totalCents: b.totalCents });
        return json(res, 200, { success: true, data: r });
      } catch (e) { return json(res, e.statusCode || 400, { success: false, error: e.message }); }
    }

    // Who am I + my venues (bootstraps the admin/panel client after login).
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = await guardUser(req, res); if (!user) return;
      const venues = await store.listVenuesForOwner(user.id);
      return json(res, 200, { success: true, data: { user: { id: user.id, email: user.email }, venues } });
    }

    // --- onboarding + table/QR management (production ships behind auth) ------
    // Bad input → 400 (not a store-thrown 500). Store validation is the second
    // line; these are the first (review finding).
    if (req.method === 'POST' && url.pathname === '/api/venues') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.name || !String(b.name).trim()) return json(res, 400, { success: false, error: 'Nome é obrigatório' });
      const venue = await store.createVenue({
        name: b.name, cnpj: b.cnpj ?? null, city: b.city ?? null,
        servicoBp: Number.isInteger(b.servicoBp) ? b.servicoBp : 1000,
      });
      // The authenticated creator becomes the venue owner.
      await store.addVenueMember(venue.id, user.id, 'owner');
      return json(res, 200, { success: true, data: venue });
    }
    if (req.method === 'GET' && url.pathname === '/api/tables') {
      const user = await guardUser(req, res); if (!user) return;
      const venueId = url.searchParams.get('v') || '';
      try { await auth.requireVenueOwner(user, venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const venue = await store.getVenue(venueId);
      if (!venue) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      return json(res, 200, { success: true, data: { venue, tables: await store.listTables(venue.id) } });
    }
    if (req.method === 'POST' && url.pathname === '/api/tables') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.venueId) return json(res, 400, { success: false, error: 'venueId é obrigatório' });
      if (!b.label || !String(b.label).trim()) return json(res, 400, { success: false, error: 'Rótulo da mesa é obrigatório' });
      try { await auth.requireVenueOwner(user, b.venueId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      try {
        const t = await store.createTable(b.venueId, b.label);
        return json(res, 200, { success: true, data: t });
      } catch (e) {
        const dup = /duplicate/.test(e.message);
        return json(res, dup ? 409 : 400, { success: false, error: dup ? 'Já existe uma mesa com esse nome' : e.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/tables/rotate') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.tableId) return json(res, 400, { success: false, error: 'tableId é obrigatório' });
      try { await auth.requireTableOwner(user, b.tableId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      const r = await store.rotateTableQr(b.tableId);
      return json(res, 200, { success: true, data: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/tables/active') {
      const user = await guardUser(req, res); if (!user) return;
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.tableId || typeof b.active !== 'boolean') return json(res, 400, { success: false, error: 'tableId e active são obrigatórios' });
      try { await auth.requireTableOwner(user, b.tableId); }
      catch (e) { return json(res, e.statusCode || 403, { success: false, error: e.message }); }
      try {
        const r = await store.setTableActive(b.tableId, b.active);
        return json(res, 200, { success: true, data: r });
      } catch (e) {
        return json(res, 409, { success: false, error: e.message });
      }
    }

    // DEV ONLY — "the bank app confirmed": emits the signed webhook a real
    // PSP would send. Does not exist in production builds.
    if (req.method === 'POST' && url.pathname === '/api/dev/confirm') {
      const body = JSON.parse(await readBody(req) || '{}');
      const payment = await store.getPayment(body.txid || '');
      if (!payment) return json(res, 404, { success: false, error: 'txid desconhecido' });
      const wh = psp.buildConfirmationWebhook({
        txid: payment.txid,
        amountCents: payment.amountCents,
        tipCents: payment.tipCents,
        payerName: payment.payerLabel || 'Cliente Demo',
        payerCpf: '390.533.447-05',
      });
      const result = await handleWebhook(wh.rawBody, wh.signature);
      if (result.checkId && (result.status === 'appended' || result.status === 'divergent_appended')) {
        await writeBackToPos(result.checkId);
      }
      return json(res, 200, { success: true, data: result });
    }

    return json(res, 404, { success: false, error: 'not found' });
  } catch (err) {
    const status = err.statusCode || (err.name === 'WebhookVerificationError' ? 401 : 500);
    return json(res, status, { success: false, error: err.message });
  }
});

server.listen(PORT);
