'use strict';

/**
 * O ADAPTADOR QUE RECUSA, e a decisão de usá-lo.
 *
 * Produção sem `RACHA_STORE=supabase` ou sem `RACHA_PSP=pagarme` já recusava —
 * mas por uma LISTA DE ROTAS, e a lista esquecia rotas. O cron diário de KYC
 * seguia perguntando ao adquirente de mentira, que responde `active` pra
 * qualquer id, gravava "ativo" numa casa de verdade e avisava o dono por
 * WhatsApp que ele já podia cobrar (segurança MEDIUM-1 e compliance LOW-5 de
 * 3eea5f3).
 *
 * Agora quem recusa é o próprio adaptador. Uma rota nova que fale com o PSP
 * nasce fechada sem ninguém lembrar de acrescentá-la a lista nenhuma — e é isso
 * que o censo em `producao-estrutural.test.js` prende: todo `psp.<método>` que o
 * router chama tem de existir aqui.
 *
 * TUDO estoura, inclusive a leitura. A versão anterior deste arquivo devolvia
 * `null` no `getRecipient` "pra não paginar de quinze em quinze minutos", e
 * `null` é uma RESPOSTA: o cron lê "sem status" e segue em frente como se
 * tivesse perguntado. Indisponível não é vazio.
 *
 * `currencies` fica de FORA de propósito: o portão do `create-charge` recusa
 * adaptador que não declare a lista (`!Array.isArray(psp.currencies)`), então a
 * ausência aqui é a recusa, e uma lista vazia seria só outra forma de dizer a
 * mesma coisa com mais código pra errar.
 */

/** Todo método que o router chama no PSP. O censo confere contra o código. */
const METODOS = [
  'createPixCharge',
  'createBizumCharge',
  'createWalletCharge',
  'createRecipient',
  'getRecipient',
  'getRecipientBalance',
  'getCharge',
  'listChargePayables',
  'verifyAndParseWebhook',
  'buildConfirmationWebhook',
];

function pspIndisponivel(motivo) {
  const recusa = () => {
    const e = new Error(`pagamento indisponível: ${motivo}`);
    e.statusCode = 503;
    e.code = 'platform_misconfigured';
    throw e;
  };
  const psp = { provider: 'unconfigured', motivo: String(motivo) };
  for (const m of METODOS) psp[m] = recusa;
  return psp;
}

/**
 * @param {string[]} faltando o que a produção não tem (`CONFIG_DE_PRODUCAO_FALTANDO`)
 * @param {() => object} construir a fábrica do PSP de verdade
 */
function escolherPsp(faltando, construir, aviso = () => {}) {
  if (faltando && faltando.length) {
    return pspIndisponivel(`produção sem ${faltando.join(' e ')}`);
  }
  try {
    return construir();
  } catch (err) {
    // Init quebrado não derruba a leitura da conta: só o dinheiro para.
    aviso(err);
    return pspIndisponivel(`PSP não configurado (${err.message})`);
  }
}

module.exports = { pspIndisponivel, escolherPsp, METODOS };
