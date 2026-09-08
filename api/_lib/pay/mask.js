'use strict';

/**
 * LGPD masking for PSP webhook payloads — the ONLY shape allowed into
 * payments.psp_payload_masked (review finding: storing raw webhooks with
 * payer CPF/name is a data-minimization violation, and "mask at write time"
 * as a comment is not a control).
 *
 * Strategy: allowlist, not blocklist. We copy ONLY the fields reconciliation
 * needs; everything else (payer identity, account numbers, free-form fields)
 * never touches our database. Where a kept field can embed PII (payer name in
 * some PSPs' description), it is masked positionally.
 */

/**
 * A lista branca. Escalares que a conciliação precisa, e nada mais.
 *
 * `paid_amount` entrou porque sem ele o retrato guardava o valor PEDIDO. Numa
 * conta de 36,98 em que o cliente digitou 33,00 no app do banco, o registro
 * que este arquivo existe pra produzir — "o retrato forense de quando o
 * dinheiro entrou, que é o que se olha quando alguém contesta" — dizia 36,98.
 * Não incompleto: afirmativamente o número errado, exatamente pros estados que
 * esta série de mudanças acrescentou. `canceled_amount` pelo mesmo motivo, no
 * cancelamento parcial. Achado pela revisão de segurança de 2026-09-08.
 *
 * Todos são escalares não-pessoais, e o filtro de tipo lá embaixo derruba
 * qualquer um deles que chegue como objeto.
 */
const KEEP = [
  'txid', 'endToEndId', 'e2eid', 'amount', 'valor', 'status', 'horario', 'timestamp', 'kind',
  'paid_amount', 'canceled_amount', 'payment_method', 'created_at', 'id',
];

/** "Maria da Silva Sauro" → "Maria d*****" — enough to eyeball, useless to leak. */
function maskName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const trimmed = name.trim().slice(0, 80);
  const [first, ...rest] = trimmed.split(/\s+/);
  if (rest.length === 0) return first.slice(0, 12);
  return `${first.slice(0, 12)} ${rest[0][0] || ''}${'*'.repeat(5)}`;
}

/** CPF/CNPJ (with or without punctuation) → keep last 2 digits only. */
function maskTaxId(doc) {
  if (typeof doc !== 'string') return null;
  const digits = doc.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-2)}`;
}

/**
 * Build the storable subset from a parsed webhook body. Pure; never throws on
 * weird shapes — the result is always a flat, small object.
 */
function maskPixPayload(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of KEEP) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[key] = v.slice(0, 128);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    // objects/arrays deliberately dropped — flat only
  }
  // Payer hints, masked (some PSPs put them at pagador.nome / payer.name).
  const payer = raw.pagador || raw.payer || {};
  const name = maskName(payer.nome || payer.name);
  const doc = maskTaxId(payer.cpf || payer.cnpj || payer.document);
  if (name) out.payer_hint = name;
  if (doc) out.payer_doc_hint = doc;
  return out;
}

module.exports = { maskPixPayload, maskName, maskTaxId };
