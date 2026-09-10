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

/**
 * "Maria da Silva Sauro" → "Maria d*****" — enough to eyeball, useless to leak.
 *
 * NÃO É MAIS CHAMADA POR `maskPixPayload`. Fica exportada porque é a
 * ferramenta certa se um dia alguém PRECISAR mostrar um nome mascarado numa
 * tela — mas o banco deixou de guardar um. Ver o comentário do `maskPixPayload`.
 */
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
  // AQUI NÃO ENTRA MAIS NADA DO PAGADOR.
  //
  // Havia um ramo que descia em `raw.pagador`/`raw.payer` e guardava
  // `payer_hint` (o primeiro nome INTEIRO, até 12 caracteres, mais a inicial do
  // sobrenome) e `payer_doc_hint` (os dois últimos dígitos do CPF). Mascarado
  // continua sendo dado pessoal (LGPD art. 12: pseudonimizado não é anonimizado),
  // e o ramo rodava em produção — o `mock-psp` emite `pagador`, e a mesa da demo
  // roda em produção.
  //
  // Ninguém lia esses campos. Nenhum adaptador de PSP real do repositório
  // produz `pagador`/`payer`; nenhuma tela, relatório ou conciliação os
  // consulta. Eram dado pessoal guardado por precaução, que é exatamente o que
  // o art. 6º III proíbe. Apagados em vez de documentados: a resposta certa pra
  // "o mapa de dados não lista este campo" é quase sempre parar de guardá-lo.
  //
  // O efeito colateral é que a promessa do `docs/compliance/data-map.md` §3
  // ("todo objeto aninhado morre") passou a ser verdade — o filtro de tipo do
  // laço acima é o único caminho pra dentro. Achado da revisão de compliance
  // de 2026-09-10.
  return out;
}

module.exports = { maskPixPayload, maskName, maskTaxId };
