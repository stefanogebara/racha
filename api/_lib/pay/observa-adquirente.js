'use strict';

/**
 * O LADO COM I/O do vigia: resolve a casa quando ela importa, e manda o aviso.
 *
 * A decisão pura — escopo, contagem, janela — mora em `saude-do-adquirente.js`
 * e é testada sem rede nem relógio. Aqui fica só o que toca o mundo.
 *
 * MORA EM `_lib` E NÃO NO ROTEADOR, e isso foi aprendido caro nesta mesma
 * mudança: o `router.js` é lido por censos que ancoram em LITERAIS do código
 * (`bundle.test.ts` fatia de uma declaração até outra). As duas primeiras
 * versões deste bloco viviam lá e sequestraram duas âncoras diferentes — a
 * segunda foi o COMENTÁRIO que explicava a primeira. Texto novo naquele arquivo
 * tem custo; aqui não tem.
 */

const { criarVigiaDoAdquirente, escopoDaFalha } = require('./saude-do-adquirente');

/**
 * @param {object} store  pra resolver a casa a partir da conta
 * @param {function} notifyFounderMoneyEvent  o canal do fundador
 */
function criarObservadorDoAdquirente({ store, notifyFounderMoneyEvent, vigia = null } = {}) {
  const olho = vigia || criarVigiaDoAdquirente();

  const observador = {
    /** Um pagamento passou: a casa está viva, zera a contagem dela. */
    aoPagar(venueId) {
      try { olho.registrarSucesso(venueId); } catch { /* nunca atrapalha o pagamento */ }
    },

    /**
     * Uma cobrança falhou. Devolve o aviso mandado, ou `null`.
     *
     * Não lança NUNCA: isto roda no caminho que já está falhando, e uma falha
     * da ponte não pode virar uma segunda falha em cima da primeira.
     */
    aoFalhar(err, checkId) {
      /**
       * DECIDE SÍNCRONO se há o que esperar, e só então devolve promessa.
       *
       * A primeira versão era `async` sempre, e o chamador embrulhava o
       * resultado em `depoisDaResposta` — ou seja, pedia à Vercel pra esperar
       * em TODA cobrança que falha, inclusive as que este módulo ignora (teto
       * estourado, erro nosso). Isso apareceu como um `waitUntil` a mais num
       * teste que contava as chamadas do irmão, e ele estava certo: o custo de
       * segurar a função viva não deve ser pago por quem não vai avisar nada.
       *
       * `null` quer dizer "nada a esperar"; qualquer outra coisa é a promessa
       * do aviso.
       */
      const escopo = escopoDaFalha(err);
      if (escopo === 'nao-e-adquirente' || escopo === 'transitorio') return null;
      // `avisar` e não `this.avisar`: desestruturado por um chamador futuro
      // (`const { aoFalhar } = adquirente`), o `this` sumia e isto lançava
      // SÍNCRONO dentro do catch da rota — virando 500 `internal` pra quem
      // está na mesa, com o docblock acima jurando "não lança NUNCA".
      return avisar(err, checkId, escopo);
    },
  };

  /**
   * O corpo do aviso. Função do escopo do `criarObservador`, pra que `aoFalhar`
   * não dependa de `this` — ver a nota acima.
   */
  async function avisar(err, checkId, escopo) {
    {
      try {
        /**
         * A CASA SÓ É BUSCADA QUANDO ELA IMPORTA.
         *
         * Duas razões, e a primeira é um erro que o banco desmentiu: `view.check`
         * é `{id, items}` e `view.venue` é a projeção PÚBLICA, sem `id` — o
         * mesmo campo-que-a-projeção-não-tem que a oitava revisão achou no
         * interruptor da carteira. Passar o id de lá poria TODAS as casas no
         * mesmo balde, e três recusas em três casas DIFERENTES acusariam uma
         * casa quebrada que não existe.
         *
         * A segunda: numa credencial revogada, 100% das requisições passam por
         * aqui. Uma leitura ao banco por requisição seria carga nova em cima de
         * um sistema em apagão — e o escopo `plataforma`, que é o caso do
         * apagão, não precisa de casa nenhuma.
         */
        let venueId = null;
        if (escopo === 'casa' && checkId && store) {
          try {
            const dona = await store.getVenueForCheck(checkId);
            venueId = dona && dona.id;
          } catch { /* sem a casa, cai no balde genérico — melhor que não contar */ }
        }

        /**
         * SEM CASA, NÃO CONTA COMO CASA.
         *
         * O `venueId` nulo caía num balde compartilhado, então três falhas
         * ÚNICAS em três casas DIFERENTES — o que acontece justamente quando o
         * banco está ruim e o adquirente também — paginavam "3 recusas
         * seguidas nesta casa", sem dizer qual. Página falsa e inacionável, na
         * pior hora possível. Achado pela revisão de segurança de 2026-09-21
         * (MEDIUM-3).
         *
         * O escopo de plataforma não passa por aqui: ele não precisa de casa.
         */
        if (escopo === 'casa' && !venueId) {
          process.stderr.write(
            `[adquirente] recusa de casa sem id resolvido (check=${checkId}) — não contada\n`,
          );
          return null;
        }

        const aviso = olho.registrarFalha(err, venueId);
        if (!aviso) return null;

        // O stderr primeiro: se a ponte estiver fora, ainda resta rastro.
        process.stderr.write(
          `[adquirente] ${aviso.escopo.toUpperCase()} casa=${aviso.venueId || '-'}: ${aviso.detail}\n`,
        );
        /**
         * 200 NÃO QUER DIZER ENTREGUE, e por isso o retorno é LIDO.
         *
         * `notifyFounderMoneyEvent` devolve `{ok:false}` SEM lançar quando a
         * ponte responde 200 e nenhum canal entregou. Ignorar isso calava a
         * instância pela janela inteira acreditando que paginou — a mesma
         * lição que o `avisarTetoDisparado` já carrega ("segurança LOW-3 de
         * 40d5c50"), e que eu não apliquei aqui na primeira versão.
         */
        let entregue = false;
        try {
          const r = await notifyFounderMoneyEvent({
            kind: 'account_alert',
            txid: null,
            checkId: null,
            amountCents: 0,
            // O id da casa VAI: sem ele o fundador lê "nesta casa" e não sabe
            // qual. UUID, nunca o NOME — texto escrito pelo dono chegando ao
            // canal do fundador é achado próprio deste repositório.
            detail: aviso.venueId ? `${aviso.detail} (casa ${aviso.venueId})` : aviso.detail,
          });
          entregue = !r || r.ok !== false;
        } catch (e) {
          process.stderr.write(
            `[adquirente] aviso NAO entregue: ${String(e && e.message).slice(0, 140)}\n`,
          );
        }
        if (!entregue) olho.naoEntregue(aviso.chave);
        return aviso;
      } catch {
        return null;   // o aviso é o degrau de baixo; ele nunca derruba a rota
      }
    }
  }

  return observador;
}

module.exports = { criarObservadorDoAdquirente };
