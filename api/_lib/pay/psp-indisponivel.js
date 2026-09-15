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
 * Agora quem recusa é o próprio adaptador, e ele é um PROXY: qualquer chave
 * que não seja `provider`/`motivo` responde a função que estoura. Não há lista
 * de métodos a manter em dia.
 *
 * A primeira versão tinha a lista, guardada por um censo que varria
 * `psp.<método>(` no código. O censo não enxerga despacho DINÂMICO — e o
 * `create-charge` usa exatamente isso (`psp[creator](...)`, onde `creator` sai
 * do trilho). Um trilho novo (`boleto` → `createBoletoCharge`) seria invisível
 * pro censo, ficaria fora da lista, e o adaptador nasceria ABERTO naquele
 * método; hoje só não nasce porque OUTRA guarda (`typeof psp[creator] !==
 * 'function'`) o pega por acaso (segurança LOW-1 de ec86b37). `METODOS` fica
 * como documentação e como o que o censo confere — não como a fronteira.
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
  // `currencies` fica FORA do alvo de propósito (ver o cabeçalho): o `get` só
  // devolve o que o alvo tem, e `currencies` não está lá — então
  // `Array.isArray(psp.currencies)` segue falso e o portão do `create-charge`
  // recusa antes de qualquer chamada.
  return new Proxy({ provider: 'unconfigured', motivo: String(motivo) }, {
    get: (alvo, chave) => {
      if (chave in alvo) return alvo[chave];
      // O RUNTIME TAMBÉM PERGUNTA. `then` faz de qualquer objeto um thenable:
      // um `await psp` chamaria a recusa como executor e rejeitaria em vez de
      // devolver o adaptador. `toJSON`/`inspect` idem, na hora de logar. São
      // chaves do protocolo do JavaScript, não métodos de PSP (segurança LOW-2
      // de d7f2683).
      if (typeof chave === 'symbol' || chave === 'then' || chave === 'toJSON'
          || chave === 'inspect' || chave === 'constructor') return undefined;
      return recusa;
    },
  });
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
