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
const { createMemoryStore } = require('./api/_lib/store/memory');
const { MockPsp } = require('./api/_lib/pay/mock-psp');
const { createWebhookHandler } = require('./api/_lib/pay/webhook-handler');
const { createChargeService } = require('./api/_lib/pay/create-charge');

const PORT = 8787;
const store = createMemoryStore();
const psp = new MockPsp({ webhookSecret: crypto.randomBytes(24).toString('hex') });
const charge = createChargeService({ store, psp });
const handleWebhook = createWebhookHandler({
  loadEvents: store.loadEvents.bind(store),
  appendEvent: store.appendEvent.bind(store),
  recordPayment: store.recordPayment.bind(store),
  findCheckByTxid: store.findCheckByTxid.bind(store),
  psp,
});

// --- seed a believable table ---------------------------------------------
const venue = store.seedVenue({ name: 'Bar do Zé', servicoBp: 1000 });
const mesa = store.seedTable(venue.id, 'Mesa 7');
let seededCheckId;
store.openCheck(mesa.qrToken, [
  { id: 'i1', name: 'Picanha na chapa', priceCents: 8990 },
  { id: 'i2', name: 'Chopp artesanal (4x)', priceCents: 5560 },
  { id: 'i3', name: 'Batata rústica', priceCents: 3290 },
  { id: 'i4', name: 'Refrigerante (2x)', priceCents: 1580 },
  { id: 'i5', name: 'Pudim da casa', priceCents: 1890 },
]).then((c) => {
  seededCheckId = c.id;
  process.stdout.write(`\nRacha demo pronto:\n  API   http://localhost:${PORT}\n  Conta http://localhost:5173/?t=${mesa.qrToken}\n\n`);
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
