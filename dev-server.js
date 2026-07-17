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
  process.stdout.write([
    '', `Racha demo pronto (${useSupabase ? 'SUPABASE worttfotxasxqjaqwpjf' : 'memória'}):`,
    `  API    http://localhost:${PORT}`,
    `  Conta  http://localhost:5173/?t=${mesa.qrToken}`,
    `  Conta2 http://localhost:5173/?t=${mesa2.qrToken}`,
    `  Painel http://localhost:5173/painel?v=${venue.id}`,
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
      const status = result.status === 'rejected' ? 409 : 200;
      return json(res, status, { success: status === 200, data: result });
    }

    // Restaurant panel (local demo — the production panel ships with auth;
    // this server never leaves localhost).
    if (req.method === 'GET' && url.pathname === '/api/panel') {
      const data = await store.getPanelView(url.searchParams.get('v') || '');
      if (!data) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      return json(res, 200, { success: true, data });
    }

    // --- onboarding + table/QR management (production ships behind auth) ------
    if (req.method === 'POST' && url.pathname === '/api/venues') {
      const b = JSON.parse(await readBody(req) || '{}');
      const venue = await store.createVenue({
        name: b.name, cnpj: b.cnpj ?? null, city: b.city ?? null,
        servicoBp: Number.isInteger(b.servicoBp) ? b.servicoBp : 1000,
      });
      return json(res, 200, { success: true, data: venue });
    }
    if (req.method === 'GET' && url.pathname === '/api/venues/get') {
      const venue = await store.getVenue(url.searchParams.get('v') || '');
      if (!venue) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      return json(res, 200, { success: true, data: venue });
    }
    if (req.method === 'GET' && url.pathname === '/api/tables') {
      const venue = await store.getVenue(url.searchParams.get('v') || '');
      if (!venue) return json(res, 404, { success: false, error: 'Restaurante não encontrado' });
      return json(res, 200, { success: true, data: { venue, tables: await store.listTables(venue.id) } });
    }
    if (req.method === 'POST' && url.pathname === '/api/tables') {
      const b = JSON.parse(await readBody(req) || '{}');
      const t = await store.createTable(b.venueId, b.label);
      return json(res, 200, { success: true, data: t });
    }
    if (req.method === 'POST' && url.pathname === '/api/tables/rotate') {
      const b = JSON.parse(await readBody(req) || '{}');
      const r = await store.rotateTableQr(b.tableId);
      return json(res, 200, { success: true, data: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/tables/active') {
      const b = JSON.parse(await readBody(req) || '{}');
      const r = await store.setTableActive(b.tableId, b.active);
      return json(res, 200, { success: true, data: r });
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
      return json(res, 200, { success: true, data: result });
    }

    return json(res, 404, { success: false, error: 'not found' });
  } catch (err) {
    const status = err.statusCode || (err.name === 'WebhookVerificationError' ? 401 : 500);
    return json(res, status, { success: false, error: err.message });
  }
});

server.listen(PORT);
