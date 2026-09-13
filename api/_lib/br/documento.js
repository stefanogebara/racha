'use strict';

/**
 * CPF/CNPJ com dígito verificador, do lado do SERVIDOR.
 *
 * Até 2026-09-13 esta conferência existia só em `apps/web/src/br.ts`: o
 * `Admin.tsx` mascarava pra catorze dígitos e desarmava o botão com
 * `!cnpjValid`, e o `POST /api/venues` aceitava `b.cnpj` do corpo sem checar
 * tipo, tamanho nem dígito. Cliente validando, servidor não — o par clássico.
 * O valor guardado chega depois a TODO cliente não autenticado pelo
 * `/api/check`, e agora também ao formatador do recibo.
 *
 * CÓPIA DECLARADA, NÃO CÓPIA ESQUECIDA. Os dois lados não podem compartilhar
 * módulo (o servidor é CommonJS, o cliente é TS/ESM), então o que impede a
 * divergência não é disciplina: é `documentos.fixture.json`, o mesmo corpo de
 * documentos exercitado pelos DOIS testes. Se as implementações discordarem,
 * um dos dois lados fica vermelho.
 */

function onlyDigits(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

function isValidCPF(input) {
  const d = onlyDigits(input);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // 000..., 111... passam na conta
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function isValidCNPJ(input) {
  const d = onlyDigits(input);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    const pesos = len === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * pesos[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** 11 dígitos → cpf, 14 → cnpj, senão null. */
function docKind(input) {
  const n = onlyDigits(input).length;
  if (n === 11) return 'cpf';
  if (n === 14) return 'cnpj';
  return null;
}

function isValidCpfCnpj(input) {
  const k = docKind(input);
  return k === 'cpf' ? isValidCPF(input) : k === 'cnpj' ? isValidCNPJ(input) : false;
}

/**
 * O que o `createVenue` guarda. Devolve `{ ok, valor }` ou `{ ok:false, code }`.
 *
 * Ausente é LEGÍTIMO: o cadastro pede o documento no passo do recebedor, não
 * no de abrir a casa, e exigi-lo aqui quebraria o assistente. O que não é
 * legítimo é guardar qualquer blob — o corpo vai até 1 MB, e o que entra aqui
 * sai no `/api/check` de todo mundo.
 *
 * Guarda CANÔNICO (só dígitos). A coluna deixa de ser um lugar onde cabem
 * ressalvas, e o formatador do recibo deixa de precisar adivinhar se o que
 * veio é documento ou frase sobre documento.
 *
 * `code`, não frase: quem escolhe a língua é o cliente (CLAUDE.md). O código é
 * o `tax_id_invalid` que o `create-charge.js` já emite e o `i18n.ts` já
 * traduz nas três línguas — um código novo pra mesma coisa seria uma quarta
 * palavra pro mesmo erro e uma tela em inglês cru pra quem lê em espanhol.
 */
function normalizarCnpjDeCasa(bruto) {
  if (bruto == null || bruto === '') return { ok: true, valor: null };
  if (typeof bruto !== 'string' && typeof bruto !== 'number') {
    return { ok: false, code: 'tax_id_invalid' };
  }
  const texto = String(bruto).trim();
  // Cortado ANTES de qualquer regex: uma string de 1 MB não precisa ser
  // percorrida pra se saber que não é um documento de catorze dígitos.
  if (texto.length > 32) return { ok: false, code: 'tax_id_invalid' };
  // SÓ PONTUAÇÃO CANÔNICA — a mesma regra do `formatTaxId`, e pelo mesmo
  // motivo. `isValidCpfCnpj` joga fora tudo que não é dígito, então
  // `CNPJ em analise 11222333000181` passava por ele: a ressalva sumia e o
  // número era aceito como conferido. Escrever a validação em cima de um
  // extrator é validar outra coisa que não o que o usuário mandou.
  if (!/^[\d.\-/\s]+$/.test(texto)) return { ok: false, code: 'tax_id_invalid' };
  if (!isValidCpfCnpj(texto)) return { ok: false, code: 'tax_id_invalid' };
  return { ok: true, valor: onlyDigits(texto) };
}

module.exports = {
  onlyDigits, isValidCPF, isValidCNPJ, docKind, isValidCpfCnpj, normalizarCnpjDeCasa,
};
