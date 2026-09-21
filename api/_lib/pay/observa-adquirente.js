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

  return {
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
    async aoFalhar(err, checkId) {
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
        if (escopoDaFalha(err) === 'casa' && checkId && store) {
          try {
            const dona = await store.getVenueForCheck(checkId);
            venueId = dona && dona.id;
          } catch { /* sem a casa, cai no balde genérico — melhor que não contar */ }
        }

        const aviso = olho.registrarFalha(err, venueId);
        if (!aviso) return null;

        // O stderr primeiro: se a ponte estiver fora, ainda resta rastro.
        process.stderr.write(
          `[adquirente] ${aviso.escopo.toUpperCase()} casa=${aviso.venueId || '-'}: ${aviso.detail}\n`,
        );
        try {
          await notifyFounderMoneyEvent({
            kind: 'account_alert',
            txid: null,
            checkId: null,
            amountCents: 0,
            detail: aviso.detail,
          });
        } catch (e) {
          process.stderr.write(
            `[adquirente] aviso NAO entregue: ${String(e && e.message).slice(0, 140)}\n`,
          );
        }
        return aviso;
      } catch {
        return null;   // o aviso é o degrau de baixo; ele nunca derruba a rota
      }
    },
  };
}

module.exports = { criarObservadorDoAdquirente };
