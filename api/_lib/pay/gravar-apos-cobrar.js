'use strict';

/**
 * GRAVAR A LINHA DEPOIS DE FALAR COM O ADQUIRENTE — e o que dizer quando ela
 * não grava.
 *
 * Este módulo existe porque a decisão "o que a pessoa na mesa lê quando a
 * escrita falha depois de a gente já ter falado com o adquirente" estava
 * escrita DENTRO de um caminho e os caminhos irmãos não a conheciam. Três
 * revisões acharam a mesma forma em três lugares diferentes:
 *
 *  - o atalho da recusa provada lançava o erro CRU do Supabase — sem `code`,
 *    sem `statusCode` — então virava 500 `internal` → "algo deu errado, tente
 *    de novo" com o botão ARMADO sobre um cartão já capturado. É exatamente o
 *    dano que o conserto anterior dizia ter fechado, alcançado pela linha ao
 *    lado (quinta revisão de compliance, 2026-09-19, CRITICAL-2);
 *  - o trilho da Stripe chamava `registerCharge` pelado: sem nova tentativa,
 *    sem código, sem nada. O mesmo evento, duas frases, conforme o trilho
 *    (mesma revisão, MEDIUM);
 *  - e `23505` na PRIMEIRA ida — que quer dizer "a linha já está lá", ou seja
 *    SUCESSO — caía no atalho da recusa provada (`^23` case), virava 500
 *    permanente e prendia quem tentava pagar (mesma revisão, NEW-1).
 *
 * A resposta é a de sempre neste repositório: a decisão mora num lugar só, e
 * todo caminho de saída passa por ela.
 */

const { linhaJaGravada, valeRepetir } = require('../checks/reconcile');

/**
 * `capturou` é propriedade da CHAMADA, não do nome do trilho.
 *
 * `createWalletCharge` da Pagar.me monta um `credit_card` sem `capture: false`
 * e a v5 captura por padrão: o dinheiro sai dentro da chamada. O
 * `createWalletCharge` da STRIPE, de nome idêntico, devolve um `clientSecret`
 * pro front confirmar com a sheet — nada saiu ainda. Mesmo nome, semântica de
 * dinheiro oposta, e é por isso que quem chama informa `capturou` em vez de
 * este módulo adivinhar pelo trilho.
 */
function erroDeNaoGravou({ capturou, txid, checkId, rail, causa }) {
  process.stderr.write(
    `[cobranca] LINHA NAO GRAVADA apos falar com o adquirente txid=${txid} check=${checkId} `
    + `rail=${rail} capturou=${capturou ? 'sim' : 'nao'}: `
    + `${String((causa && causa.message) || causa).slice(0, 160)}\n`,
  );
  /**
   * DOIS DESFECHOS, porque só quem CAPTUROU tirou dinheiro de alguém.
   *
   * Um código só, para os dois, dizia a quem pagou por Pix que "seu cartão pode
   * já ter sido cobrado" — não há cartão, nada foi cobrado, e a conta nunca vai
   * atualizar sozinha. Alarme falso no trilho principal do Brasil, com o botão
   * de pagar ainda vivo ao lado (CDC art. 6º III e art. 31).
   *
   * No Pix e na Stripe, "tente de novo" é a resposta CERTA: a cobrança existe
   * no adquirente mas é um QR/intent que ninguém autorizou, ele expira sozinho,
   * e ninguém foi debitado. Por isso os dois códigos, em vez de uma frase mais
   * vaga que servisse aos dois.
   */
  const e = new Error(capturou
    ? 'charge captured at the acquirer but not recorded'
    // Ela FOI criada — dizer "could not be created" mandava quem estava de
    // plantão procurar o erro errado, em vez de procurar uma cobrança
    // abandonada no painel do adquirente (quinta revisão, LOW).
    : 'charge created at the acquirer but not recorded — nothing captured');
  e.statusCode = 502;
  e.code = capturou ? 'charge_maybe_captured' : 'charge_not_started';
  e.txid = txid;
  return e;
}

/**
 * Tenta gravar; tenta de novo uma vez se valer a pena; nunca deixa o chamador
 * sem código.
 *
 * @param {() => Promise<any>} gravar  a ida ao store, já com os campos prontos
 * @param {boolean} capturou           a chamada anterior TIROU dinheiro de alguém?
 */
async function gravarAposCobrar({ gravar, capturou, txid, checkId, rail }) {
  try {
    await gravar();
    return;
  } catch (primeiraFalha) {
    /**
     * `23505` PRIMEIRO, antes de qualquer classificação de recusa.
     *
     * A unicidade do `txid` é o único SQLSTATE cujo significado aqui é
     * SUCESSO: a linha que se queria existe. Ela cai dentro de `^23`, que é
     * classe de recusa provada, então a ordem dos dois testes é a diferença
     * entre "pronto, segue" e "500 permanente". O MockPsp deriva o txid de
     * `sha256(chargeRef|valor|gorjeta|recebedor)` e o `chargeRef` carrega o
     * `paidCents`: duas pessoas tocando "pagar R$ 50,00" na mesma conta antes
     * de qualquer uma confirmar produzem o MESMO txid, e a segunda batia aqui.
     */
    if (linhaJaGravada(primeiraFalha)) return;

    /**
     * REPETE QUANDO A SEGUNDA IDA TEM CHANCE — que NÃO é "quando não se sabe".
     *
     * Esta linha já perguntou `recusaProvadaDoErro`, e era a pergunta errada.
     * `recusaProvada` quer dizer "está PROVADO que nada foi gravado" — e o
     * `53300` (pooler cheio), o `40P01` (deadlock) e o `57014` (prazo) estão
     * nela, porque o Postgres garante o rollback deles. São também, os três, os
     * SQLSTATEs canônicos de "tenta 30 ms depois e passa". Perguntar por recusa
     * provada desligava a segunda ida justo nos erros que ela conserta, e
     * deixava MAIS comum o `charge_maybe_captured` que este arquivo existe pra
     * tornar raro (quinta revisão de segurança, 2026-09-19, MEDIUM-1).
     *
     * `valeRepetir` é a outra pergunta, e mora no mesmo classificador: uma
     * segunda ida tem chance? Cai fora dela só a recusa determinística de
     * verdade — CHECK violado, grant revogado, coluna que sumiu — onde repetir
     * contra um banco que já recusou por escrito só dobra a espera. E isso
     * também é segurança: a rota é pública (token de mesa, sem sessão) com idas
     * de 10 s, então o pior caso ia de 20 s pra 40 s numa superfície que
     * qualquer um com uma foto do QR alcança (quarta revisão de segurança,
     * 2026-09-16, MEDIUM-1).
     */
    if (!valeRepetir(primeiraFalha)) {
      throw erroDeNaoGravou({ capturou, txid, checkId, rail, causa: primeiraFalha });
    }

    try {
      await gravar();
    } catch (segundaFalha) {
      if (linhaJaGravada(segundaFalha)) return;  // a primeira escreveu, só a resposta se perdeu
      throw erroDeNaoGravou({ capturou, txid, checkId, rail, causa: segundaFalha });
    }
  }
}

module.exports = { gravarAposCobrar };
