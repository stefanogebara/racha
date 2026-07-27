'use strict';

/**
 * Adaptador Saipos — o primeiro POS real do Racha (order-api.saipos.com).
 *
 * Por que Saipos primeiro: é o ÚNICO grande PDV brasileiro com portal de
 * desenvolvedor público e self-service (developer.saipos.com) cuja API lê o
 * pedido da mesa — o que destrava o split POR ITEM no Racha (no modo manual só
 * dá divisão igual/proporcional). Mapa de mercado 2026-07-27.
 *
 * O que a API dá e o que NÃO dá (doc pública, jul/2026):
 *   POST /auth {idPartner, secret} → { token }. A doc avisa: pedir token em
 *        excesso causa bloqueio temporário → cache até morrer (401) e UMA
 *        renovação com retry; segundo 401 propaga.
 *   GET  /sale-status-by-table-or-pad?table=N → a conta viva da mesa.
 *   PUT  /close-sale?cod_store&order_id → NÃO registra pagamento. Marca a mesa
 *        em laranja pro garçom ir fechar. A baixa no PDV continua humana —
 *        writeBackPayment aqui SINALIZA, nunca finge liquidar (e só quando a
 *        conta está 100% paga: sinalizar em pagamento parcial mandaria o
 *        garçom à mesa à toa).
 *
 * Shapes de resposta não são públicos na doc → parser TOLERANTE (shape
 * inesperado vira null com log, nunca crash no meio do jantar) + validação
 * agendada no sandbox quando a credencial do fundador chegar.
 */

const BASE = process.env.SAIPOS_API_URL || 'https://order-api.saipos.com';
const TIMEOUT_MS = 10_000;

/** Reais decimais → centavos inteiros sem fantasma de float (0.1*3 → 30). */
const cents = (reais) => Math.round(Number(reais || 0) * 100);

/**
 * @param {{ idPartner: string, secret: string, codStore: string,
 *           fetchImpl?: typeof fetch }} cfg
 */
function createSaiposAdapter(cfg = {}) {
  const { idPartner, secret, codStore } = cfg;
  if (!idPartner) throw new Error('saipos: idPartner obrigatório');
  if (!secret) throw new Error('saipos: secret obrigatório');
  if (!codStore) throw new Error('saipos: codStore obrigatório');
  const doFetch = cfg.fetchImpl || fetch;

  let token = null;

  async function autenticar() {
    const res = await doFetch(`${BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idPartner, secret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`saipos auth falhou: HTTP ${res.status}`);
    const body = await res.json();
    token = body.token || body.access_token || null;
    if (!token) throw new Error('saipos auth: resposta sem token');
    return token;
  }

  /** Chamada autenticada com cache de token e UMA renovação em 401. */
  async function chamar(path, opts = {}, jaRenovou = false) {
    if (!token) await autenticar();
    const res = await doFetch(`${BASE}${path}`, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !jaRenovou) {
      token = null;
      return chamar(path, opts, true);
    }
    return res;
  }

  /**
   * A conta viva da mesa no shape do Racha, ou null quando não há conta
   * aberta (200 vazio e 404 valem o mesmo: mesa livre).
   * @param {{ table?: string, pad?: string }} ref  número da mesa OU comanda
   */
  async function pullOpenCheck({ table, pad } = {}) {
    const q = new URLSearchParams();
    if (table) q.set('table', table);
    if (pad) q.set('pad', pad);
    const res = await chamar(`/sale-status-by-table-or-pad?${q}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`saipos consulta mesa falhou: HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    const venda = Array.isArray(body.sales) ? body.sales[0] : null;
    if (!venda || !Array.isArray(venda.items)) {
      if (venda === null && !Array.isArray(body.sales)) {
        process.stderr.write('[saipos] resposta com shape inesperado — validar no sandbox\n');
      }
      return null;
    }
    const items = venda.items.map((it, i) => {
      const qtd = Number(it.quantity || 1);
      const nome = String(it.desc_store_item || it.name || `Item ${i + 1}`);
      return {
        id: String(it.id_item ?? it.id ?? `saipos-${i}`),
        name: qtd > 1 ? `${nome} (${qtd}x)` : nome,
        priceCents: cents(it.unit_price ?? it.price) * qtd,
      };
    });
    const totalCents = venda.total != null
      ? cents(venda.total)
      : items.reduce((s, it) => s + it.priceCents, 0);
    return { orderId: venda.order_id || null, items, totalCents };
  }

  /**
   * Pós-confirmação de pagamento. Semântica REAL: sinaliza o fechamento
   * (mesa laranja) — a baixa no PDV é do garçom. Skips declarados:
   *  - pagamento parcial → não sinaliza (garçom iria à toa);
   *  - venda manual do PDV não tem order_id (doc) → não há o que sinalizar.
   */
  async function writeBackPayment({ orderId, fullyPaid } = {}) {
    if (!fullyPaid) return { ok: true, skipped: 'pagamento parcial — só sinaliza com a conta 100% paga' };
    if (!orderId) return { ok: true, skipped: 'venda manual do PDV sem order_id — sinalização indisponível' };
    const q = new URLSearchParams({ cod_store: String(codStore), order_id: String(orderId) });
    const res = await chamar(`/close-sale?${q}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cod_store: String(codStore), order_id: String(orderId) }),
    });
    if (!res.ok) throw new Error(`saipos close-sale falhou: HTTP ${res.status}`);
    return { ok: true, ref: String(orderId) };
  }

  return {
    provider: 'saipos',
    // writeBack=true no sentido do router (existe ação pós-confirmação); a
    // semântica de sinalização-não-baixa está documentada acima e nos skips.
    capabilities: { pull: true, writeBack: true },
    pullOpenCheck,
    writeBackPayment,
  };
}

module.exports = { createSaiposAdapter };
