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
 * O RECUO quando o aviso NÃO foi entregue.
 *
 * A janela é carimbada ANTES de a entrega ser conhecida — tem que ser, senão
 * duas falhas simultâneas na mesma instância mandariam dois avisos. O preço é
 * que um aviso perdido calaria a instância pelos 15 minutos inteiros
 * acreditando que paginou. O `notifyFounderMoneyEvent` devolve `{ok:false}` SEM
 * lançar quando a ponte responde 200 e nada é entregue, então dá pra saber — e
 * o irmão deste caminho (`avisarTetoDisparado`) já faz isso: devolve a vaga e
 * tenta de novo daqui a um minuto.
 */
const RECUO_SEM_ENTREGA_MS = 60_000;

/** O máximo que a env pode espaçar as páginas. Ver `janelaConfigurada`. */
const TETO_DA_JANELA_MS = 60 * 60_000;

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
/**
 * A janela é CONFIGURÁVEL por env, com o padrão de produção acima.
 *
 * Não é uma alavanca de teste disfarçada: quem opera pode querer apertar ou
 * afrouxar o intervalo entre páginas sem deploy. O teste usa `0` porque o
 * observador é um singleton de módulo — sem isso, o primeiro caso do arquivo
 * carimbaria a janela e os seguintes mediriam o silêncio dela em vez do
 * comportamento que eles nomeiam.
 */
function janelaConfigurada() {
  /**
   * VAZIA É AUSENTE, e zero só se alguém escrever zero.
   *
   * `Number('')` é `0`, e `0 >= 0` é verdadeiro — então uma variável que
   * EXISTE e está em branco (limpar o campo no painel da Vercel em vez de
   * apagar a variável, que é como isso acontece na prática) desligava o
   * debounce inteiro. Numa credencial revogada isso é uma página por cobrança
   * falhada, por instância quente: o sinal soterrado e a cota da ponte
   * queimada, pelo caminho oposto ao silêncio. Achado pela revisão de
   * segurança de 2026-09-21 (MEDIUM-1).
   */
  const cru = (process.env.RACHA_JANELA_AVISO_ADQUIRENTE_MS || '').trim();
  if (!cru) return JANELA_PADRAO_MS;
  const n = Number(cru);
  if (!Number.isFinite(n) || n < 0) return JANELA_PADRAO_MS;
  /**
   * TETO, porque esta alavanca pode desligar o único alarme do apagão.
   *
   * `RACHA_JANELA_AVISO_ADQUIRENTE_MS=864000000` (dez dias) era aceito em
   * silêncio, e transformava o pager num no-op — exatamente o que o
   * inegociável #8 proíbe, por configuração em vez de por código. Uma hora é
   * folgado pra qualquer uso legítimo de espaçar páginas.
   */
  return Math.min(n, TETO_DA_JANELA_MS);
}

function criarVigiaDoAdquirente({
  agora = () => Date.now(),
  janelaMs = janelaConfigurada(),
  seguidasPorCasa = SEGUIDAS_POR_CASA,
} = {}) {
  const seguidas = new Map();     // venueId → Set de contas que falharam
  const ultimoAviso = new Map();  // chave do aviso → instante do último

  const dentroDaJanela = (chave) => {
    const ate = ultimoAviso.get(chave);
    return ate !== undefined && agora() < ate;
  };

  return {
    /**
     * O AVISO NÃO SAIU. Encurta a janela pra um minuto em vez de deixar a
     * instância calada os 15 acreditando que paginou.
     */
    naoEntregue(chave) {
      if (!chave) return;
      /**
       * ENCURTA, nunca alonga.
       *
       * Com `set` puro, um operador que apertasse a janela pra menos de um
       * minuto faria o aviso NÃO ENTREGUE ficar suprimido MAIS tempo que o
       * entregue — o oposto exato da intenção. O `min` mantém a promessa:
       * não entregou, volta antes.
       */
      const jaMarcado = ultimoAviso.get(chave);
      const proposto = agora() + RECUO_SEM_ENTREGA_MS;
      ultimoAviso.set(chave, jaMarcado === undefined ? proposto : Math.min(jaMarcado, proposto));
    },

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
    registrarFalha(err, venueId = null, checkId = null) {
      const escopo = escopoDaFalha(err);
      if (escopo === 'nao-e-adquirente' || escopo === 'transitorio') return null;

      if (escopo === 'plataforma') {
        const chave = 'plataforma';
        if (dentroDaJanela(chave)) return null;
        ultimoAviso.set(chave, agora() + janelaMs);
        return {
          kind: 'account_alert',
          escopo,
          chave,
          venueId: null,
          detail: `adquirente recusou a NOSSA credencial (HTTP ${err.httpStatus}) — `
            + 'nenhuma casa consegue cobrar. Confira a chave e o escopo dela no painel.',
        };
      }

      /**
       * CONTAS DISTINTAS, e não requisições.
       *
       * O contador perguntava só "que status voltou?", nunca "de quem é a
       * culpa?" — então QUALQUER campo que o cliente controla e que faça o
       * adquirente responder 4xx virava saúde da casa. Fechar o `payerDocument`
       * com verificador de CPF fechou o CAMPO, não a CLASSE: medido, três
       * requisições com `tipCents: 9_000_000_000` do mesmo QR paginavam o
       * fundador dizendo "ninguém paga aqui" sobre um restaurante são.
       *
       * Exigir CONTAS distintas é o corte barato que derrota o atacante de um
       * QR só: uma mesa tem uma conta, e quem está numa mesa não consegue
       * fabricar três. Uma casa de verdade quebrada — recebedor inativo, split
       * desligado — falha em TODAS as mesas, então ela chega a três sem
       * esforço.
       *
       * Achado pela re-revisão de segurança (2026-09-21, HIGH-3).
       */
      const casa = String(venueId || 'sem-casa');
      const contas = seguidas.get(casa) || new Set();
      if (checkId) contas.add(String(checkId));
      seguidas.set(casa, contas);
      const n = contas.size;
      if (n < seguidasPorCasa) return null;

      const chave = `casa:${casa}`;
      if (dentroDaJanela(chave)) return null;
      ultimoAviso.set(chave, agora() + janelaMs);
      return {
        kind: 'account_alert',
        escopo,
        chave,
        venueId: venueId || null,
        detail: `${n} contas seguidas recusadas pelo adquirente (HTTP ${err.httpStatus}) nesta casa — `
          + 'recebedor inativo, split desligado ou dado recusado. Ninguém paga aqui.',
      };
    },
  };
}

module.exports = {
  escopoDaFalha,
  janelaConfigurada,
  RECUO_SEM_ENTREGA_MS,
  TETO_DA_JANELA_MS,
  criarVigiaDoAdquirente,
  JANELA_PADRAO_MS,
  SEGUIDAS_POR_CASA,
};
