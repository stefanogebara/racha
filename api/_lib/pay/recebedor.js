'use strict';

/**
 * As DECISÕES das rotas do recebedor (`/api/psp/recipient`) — puras e testáveis
 * sem HTTP. O recebedor é PRA ONDE O DINHEIRO DA CASA LIQUIDA (inegociável #4:
 * PSP → subconta da casa); trocar o id dele troca o destino do dinheiro.
 *
 * O defeito que isto fecha (auditoria de onboarding, C3): a leitura não tinha
 * `try`, então um 404 do Pagar.me e um timeout saíam do mesmo jeito; a tela
 * tratava qualquer falha como "o recebedor não existe — crie um novo, ele
 * substitui o antigo" e abria o formulário; e o POST sobrescrevia o
 * `psp_recipient_id` sem pergunta nem registro. Um soluço do gateway e um
 * envio trocavam o destino do dinheiro de uma casa com recebedor ativo — e
 * reabriam a análise de KYC (~3 dias úteis).
 */

/** Uma falha do adquirente ao LER o recebedor: inexistente de verdade, ou só indisponível? */
function classificarFalhaDoRecebedor(e) {
  if (e && e.httpStatus === 404) return { status: 404, code: 'recipient_not_found' };
  return { status: 503, code: 'psp_unavailable' };
}

/**
 * Uma falha ao CRIAR: dado recusado pelo adquirente (4xx), campo faltando do
 * nosso lado (`TypeError` do adaptador), ou adquirente indisponível (rede, 5xx).
 * O texto do gateway ("pagarme POST /recipients: {…}") não vai pra tela.
 */
function classificarFalhaNaCriacao(e) {
  if (e instanceof TypeError) return { status: 400, code: 'recipient_fields_invalid' };
  const h = e && e.httpStatus;
  if (Number.isInteger(h) && h >= 400 && h < 500) return { status: 400, code: 'psp_recipient_rejected' };
  return { status: 503, code: 'psp_unavailable' };
}

/** A casa já tem um recebedor de VERDADE no adquirente (`re_…`/`rp_…`)? */
function temRecebedorReal(venue) {
  return Boolean(venue && /^r[ep]_/.test(venue.pspRecipientId || ''));
}

/**
 * Criar um recebedor pode SUBSTITUIR o de verdade só com pedido explícito
 * (`replace: true`). Sem ele, uma casa com recebedor recebe 409 — e o envio
 * que um erro passageiro provocou não troca o destino do dinheiro.
 */
function podeCriarRecebedor(venue, corpo) {
  if (!temRecebedorReal(venue)) return { ok: true, substitui: false };
  if (corpo && corpo.replace === true) return { ok: true, substitui: true };
  return { ok: false, status: 409, code: 'recipient_exists' };
}

module.exports = { classificarFalhaDoRecebedor, classificarFalhaNaCriacao, temRecebedorReal, podeCriarRecebedor };
