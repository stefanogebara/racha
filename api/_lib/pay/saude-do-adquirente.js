'use strict';

/**
 * QUANDO UMA FALHA DO ADQUIRENTE PRECISA ACORDAR ALGUÉM.
 *
 * O buraco que isto fecha, medido pela nona e pela décima revisão: todo 4xx do
 * gateway vira 402 `psp_rejected` pra quem está na mesa. Com a `sk_live_`
 * rotacionada, 100% das cobranças falham em TODAS as casas, cada pessoa lê que
 * ELA foi recusada — e nada acorda ninguém:
 *
 *  - a rota só registra a partir de 500 (`router.js`);
 *  - o `errorBody` manda `{success:false, code}` e nada mais;
 *  - o `service_never_collected` exige 8 pagamentos CONFIRMADOS, e uma queda
 *    total produz zero; sem pagamento não há deriva;
 *  - a conciliação compara dois registros que concordam que nada aconteceu, e
 *    o aviso diário diz "restaurantes ok";
 *  - o canário sintético roda contra o MockPsp, por declaração própria.
 *
 * É o inegociável #8 ("um canário vermelho PAGINA; nunca só registra") pelo
 * caminho da cobrança em vez do da conciliação.
 *
 * ESCOPO É A DECISÃO PRINCIPAL. Uma credencial revogada e um recebedor
 * desativado chegam os dois como 4xx e pedem coisas opostas:
 *
 *  - 401/403 é NOSSO e é de TODAS as casas. Esperar N ocorrências é esperar
 *    enquanto 100% falha. Pagina na PRIMEIRA.
 *  - 422 e companhia são de UMA casa (recebedor inativo, split desligado,
 *    esquema recusado). Uma sozinha pode ser um pedido torto; N seguidas na
 *    mesma casa é a casa quebrada. Pagina no N.
 *
 * O QUE ESTE MÓDULO NÃO É: um contador confiável. A Vercel é serverless e não
 * há memória compartilhada entre instâncias, então o estado aqui é por
 * INSTÂNCIA QUENTE. Duas consequências, as duas assumidas de propósito:
 *
 *  1. instâncias diferentes podem avisar do mesmo apagão — alerta repetido é
 *     estritamente melhor que silêncio, e é pra isso que existe o `janelaMs`;
 *  2. uma instância fria perde o histórico e conta de novo do zero. Numa
 *     credencial revogada isso não atrasa nada, porque o escopo `plataforma`
 *     avisa na primeira.
 *
 * O que ISSO NÃO cobre é o apagão que só aparece na ausência de cobranças —
 * ninguém tocou em pagar. Esse é o detector durável que fica na lista de
 * abertos, e ele mora na conciliação, não aqui.
 */

/** Uma janela generosa: o objetivo é acordar alguém, não fazer barulho. */
const JANELA_PADRAO_MS = 15 * 60_000;

/**
 * Quantas seguidas na MESMA casa antes de avisar.
 *
 * Três, e não uma: um `422` sozinho costuma ser um pedido torto (documento
 * recusado, valor fora do limite do esquema) e não uma casa quebrada. Três
 * seguidas, sem nenhum sucesso no meio, é configuração.
 */
const SEGUIDAS_POR_CASA = 3;

/**
 * O ESCOPO de uma falha do adquirente, pelo status exato que o adaptador
 * guarda em `httpStatus`.
 *
 * `httpStatus === 0` é a marca que o adaptador usa pra rede/timeout — nunca
 * "recusa" nem "inexistente". Transitório, e quem trata é a nova tentativa;
 * acordar alguém a cada soluço de rede é o jeito de ninguém mais ler o alerta.
 */
function escopoDaFalha(err) {
  const h = err && err.httpStatus;
  if (!Number.isInteger(h)) return 'nao-e-adquirente';
  if (h === 0) return 'transitorio';
  if (h >= 500) return 'transitorio';
  if (h === 429) return 'transitorio';          // limite de taxa, não quebra
  if (h === 401 || h === 403) return 'plataforma';
  if (h >= 400) return 'casa';
  return 'nao-e-adquirente';
}

/**
 * O vigia. Recebe falhas e sucessos e devolve o aviso QUANDO ele deve sair —
 * `null` no resto do tempo.
 *
 * O relógio entra por parâmetro pra que o teste meça a janela sem dormir.
 */
function criarVigiaDoAdquirente({
  agora = () => Date.now(),
  janelaMs = JANELA_PADRAO_MS,
  seguidasPorCasa = SEGUIDAS_POR_CASA,
} = {}) {
  const seguidas = new Map();     // venueId → quantas falhas seguidas
  const ultimoAviso = new Map();  // chave do aviso → instante do último

  const dentroDaJanela = (chave) => {
    const t = ultimoAviso.get(chave);
    return t !== undefined && (agora() - t) < janelaMs;
  };

  return {
    /**
     * UM SUCESSO ZERA A CASA. Sem isto, "seguidas" seria "acumuladas desde que
     * a instância subiu", e uma casa saudável com três recusas espalhadas pela
     * noite avisaria como se estivesse quebrada.
     *
     * Não zera o escopo de PLATAFORMA de propósito: naquele a primeira já
     * avisou, e o que segura o volume é a janela.
     */
    registrarSucesso(venueId) {
      if (venueId) seguidas.delete(String(venueId));
    },

    /**
     * @returns {null | {kind, escopo, detail, venueId}} o aviso, ou nada.
     */
    registrarFalha(err, venueId = null) {
      const escopo = escopoDaFalha(err);
      if (escopo === 'nao-e-adquirente' || escopo === 'transitorio') return null;

      if (escopo === 'plataforma') {
        const chave = 'plataforma';
        if (dentroDaJanela(chave)) return null;
        ultimoAviso.set(chave, agora());
        return {
          kind: 'account_alert',
          escopo,
          venueId: null,
          detail: `adquirente recusou a NOSSA credencial (HTTP ${err.httpStatus}) — `
            + 'nenhuma casa consegue cobrar. Confira a chave e o escopo dela no painel.',
        };
      }

      const casa = String(venueId || 'sem-casa');
      const n = (seguidas.get(casa) || 0) + 1;
      seguidas.set(casa, n);
      if (n < seguidasPorCasa) return null;

      const chave = `casa:${casa}`;
      if (dentroDaJanela(chave)) return null;
      ultimoAviso.set(chave, agora());
      return {
        kind: 'account_alert',
        escopo,
        venueId: venueId || null,
        detail: `${n} recusas seguidas do adquirente (HTTP ${err.httpStatus}) nesta casa — `
          + 'recebedor inativo, split desligado ou dado recusado. Ninguém paga aqui.',
      };
    },
  };
}

module.exports = {
  escopoDaFalha,
  criarVigiaDoAdquirente,
  JANELA_PADRAO_MS,
  SEGUIDAS_POR_CASA,
};
