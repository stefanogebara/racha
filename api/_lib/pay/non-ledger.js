'use strict';

/**
 * Evento de DINHEIRO que não vira lançamento — o tratamento, num lugar só.
 *
 * `NON_LEDGER_KINDS` é a espécie "mexeu em dinheiro e o razão não sabe
 * traduzir": cancelamento parcial (saiu dinheiro e não sabemos quanto),
 * disputa aberta, estorno que falhou, alerta de conta. O portão do webhook
 * devolve cada um como status e diz, em comentário, que quem trata é o
 * CHAMADOR.
 *
 * Havia três chamadores e só dois tratavam. `/api/webhooks/psp` — a rota do
 * trilho que está em produção de verdade — devolvia 200 sem gravar nada e sem
 * avisar ninguém: a linha seguia `confirmado` pelo valor cheio, o razão
 * também, e a conciliação diária compara os DOIS ENTRE SI, concorda, e reporta
 * VERDE por cima de dinheiro que saiu da conta. O inegociável #8 derrotado na
 * forma exata que ele foi escrito pra proibir. Achado pela revisão de
 * segurança de 2026-09-08.
 *
 * Este módulo existe separado da rota porque a rota não era testável: o defeito
 * era um `if` que faltava num arquivo de 1500 linhas que nenhum teste carrega.
 *
 * Duas coisas acontecem aqui, e a primeira é a que faltava em todo lugar:
 *
 *  1. ANOMALIA NO RAZÃO. Um alerta degrada — sem `RACHA_NOTIFY_SECRET` ele
 *     vira uma linha de stderr que ninguém lê. A anomalia é durável: entra no
 *     log, o redutor a projeta, e a conciliação passa a ficar VERMELHA naquela
 *     conta até alguém resolver. É o canário que pageia em vez de logar.
 *  2. O aviso ao fundador, pra alguém saber hoje e não no fechamento do mês.
 */

const { appendValidated } = require('../checks/append-validated');
const { maskPixPayload } = require('./mask');

/**
 * `refund_progress` fica de fora dos dois lados: é estado intermediário de um
 * estorno que ainda vai terminar em `succeeded` ou `failed`, e os dois têm
 * tratamento próprio. Marcar aqui deixaria a conta vermelha por um estorno que
 * deu certo.
 */
// `payment_failed` ENTRA AQUI, e não é remendo: uma recusa no app do banco é
// rotina, e alertar em cada uma treina quem recebe a ignorar o canal — o mesmo
// raciocínio que tirou a batida diária do WhatsApp.
//
// Também é o que impede um acidente pior. Desde que `notifyFounderMoneyEvent`
// ESTOURA num kind desconhecido, um `payment_failed` chegando aqui derrubaria a
// requisição inteira: o registro durável já foi gravado, o webhook devolveria
// 5xx, a Pagar.me reentregaria pra sempre e o endpoint acabaria desligado — "o
// que derruba toda confirmação de Pix", como diz o comentário abaixo. A
// armadilha já estava documentada no `router.js`; o que mudou foi o preço dela.
// Achado pelas duas revisões de 2026-09-12.
const SEM_ALARDE = new Set(['refund_progress', 'payment_failed']);

/**
 * O `orderCode` que a gente aceita gravar: `<uuid>:<n>:<n>:<n>`.
 *
 * Lista de permissão de CARACTERES, e não o formato exato de propósito: o que
 * se está defendendo é a quebra de linha que fabrica uma linha dentro do aviso
 * do fundador, o objeto aninhado que o filtro de tipo da máscara derrubava, o
 * CPF (que tem ponto, traço e espaço) e os 500 caracteres que a Stripe deixa a
 * casa escrever no `metadata`. Prender ao formato `<uuid>:<n>:<n>:<n>` também
 * fecharia tudo isso, e ao custo de derrubar em silêncio o dia em que o id da
 * conta mudar de forma — um controle que só quem lê o código descobriria.
 *
 * Devolve objeto pra ser espalhado: vazio quando não serve.
 */
const FORMA_DO_ORDER_CODE = /^[A-Za-z0-9:_-]{1,80}$/;
function orderCodeUtil(valor) {
  return typeof valor === 'string' && FORMA_DO_ORDER_CODE.test(valor)
    ? { orderCode: valor } : {};
}

function createNonLedgerHandler({ store, notify, append = appendValidated }) {
  if (!store || typeof notify !== 'function') {
    throw new Error('createNonLedgerHandler: missing dependencies');
  }
  // A gravação do órfão é o ÚNICO caminho durável quando não há conta. Um
  // `typeof … === 'function'` na hora de usar transformaria a ausência em
  // silêncio; aqui ela é erro na CONSTRUÇÃO, alto e cedo (inegociável #7 —
  // nada de degradar aberto num caminho de dinheiro).
  if (typeof store.recordOrphanMoneyEvent !== 'function') {
    throw new Error('createNonLedgerHandler: store sem recordOrphanMoneyEvent');
  }
  /**
   * @param {{status: string, type?: string|null, txid?: string|null, raw?: object}} result
   * @returns {Promise<{persisted: boolean, notified: boolean}>}
   */
  /**
   * @param {object} result o que o portão devolveu
   * @param {{alert?: boolean}} [opts] `alert:false` só grava a marca — pra
   *   quem já manda o próprio alerta com detalhe que só ele tem (a rota da
   *   Stripe carrega a conta conectada no aviso). Dois alertas pelo mesmo
   *   evento treinam quem lê a ignorar os dois.
   */
  return async function handleNonLedgerMoneyEvent(result, opts = {}) {
    // `opts.psp` é o adquirente, dito pelo chamador. `opts.alert` desliga o
    // aviso pra quem manda o próprio.
    const kind = result.status;
    const txid = result.txid || null;
    const quieto = SEM_ALARDE.has(kind);
    /**
     * "Não achei a conta" e "não consegui procurar" NÃO são a mesma coisa.
     *
     * Isto era um `catch` vazio com o comentário "sem check ligado" — uma
     * interpretação que o código não tinha como justificar: um 5xx do
     * Supabase, um `statement_timeout` ou uma conexão cortada saíam
     * indistinguíveis de "este txid não tem conta". E `found` é a ÚNICA entrada
     * do portão da rota: com `found = false` o registro durável deixava de ser
     * exigido e um alerta bastava pra responder 200. Ou seja, um soluço do
     * banco fazia a Pagar.me marcar como entregue um cancelamento parcial que
     * ninguém registrou. Achado pela revisão de segurança de 2026-09-08.
     *
     * Três estados, então: achou, não existe, e NÃO SEI. O último exige
     * reenvio.
     */
    let found = null;
    let buscaFalhou = false;
    if (txid) {
      try { found = await store.findCheckByTxid(txid); }
      catch (e) {
        buscaFalhou = true;
        process.stderr.write(`[webhook] busca do check falhou pra ${txid}: ${String(e.message).slice(0, 120)}\n`);
      }
    }
    /**
     * `money_without_check` NUNCA vira anomalia numa conta.
     *
     * O tratador procura a conta DE NOVO, depois de o aplicador já ter concluído
     * que ela não existe. Entre as duas buscas cabe a segunda tentativa de
     * gravar a linha — e ela costuma ganhar, porque o webhook do cartão chega
     * segundos depois da captura. Aí `found` vira verdadeiro e este ramo
     * pendurava um `PAYMENT_ANOMALY` **critical** ("evento de dinheiro que o
     * razão não sabe lançar") numa conta cujo pagamento está prestes a ser
     * confirmado normalmente: a casa fica vermelha na conciliação por um
     * pagamento que está bem, e só um humano tira. Canário gritando lobo é o
     * modo de falha do próprio #8.
     *
     * Pulando o apêndice, `persisted` fica falso e o `needsRetry` devolve 503 —
     * o adquirente reenvia, o aplicador acha a conta que agora existe, e o
     * pagamento entra no razão pelo caminho normal. O desfecho certo sai de não
     * fazer nada, que é o melhor tipo. Achado pela quarta revisão de segurança
     * de 2026-09-16 (MEDIUM-2).
     */
    const semContaPorDefinicao = kind === 'money_without_check';
    let persisted = false;
    if (found && !quieto && !semContaPorDefinicao) {
      try {
        await append(store, found.id, 'PAYMENT_ANOMALY', {
          txid,
          reason: `${kind}${result.type ? ` (${result.type})` : ''}: evento de dinheiro que o razão não sabe lançar`,
          severity: 'critical',
        // SUFIXO na chave. `psp_event_id` é único no banco inteiro, e na rota
        // da Stripe a MESMA entrega pode gravar tanto um lançamento próprio
        // (uma disputa, com o prazo) quanto esta anomalia. Chave crua faria o
        // segundo append virar no-op calado — o defeito que o censo de chaves
        // pegou aqui, e que a correção à mão tinha achado só nos outros dois
        // lugares. Achado pelo censo em 2026-09-08.
        }, (result.raw && result.raw.eventId) ? `${result.raw.eventId}:non_ledger` : null);
        persisted = true;
      } catch (e) {
        process.stderr.write(`[webhook] anomalia não gravada: ${String(e.message).slice(0, 120)}\n`);
      }
    }
    /**
     * SEM conta pra pendurar a marca, o evento ainda tem que sobrar em algum
     * lugar durável.
     *
     * Um txid que não resolve pra conta nenhuma (cobrança de outro ambiente,
     * linha apagada) não tem razão onde entrar — e a rota respondia 503 "pra o
     * PSP reenviar" sobre um estado que NUNCA vai mudar. Sem
     * `RACHA_NOTIFY_SECRET`, isso era 503 em laço até o endpoint ser
     * desabilitado, o que derruba toda confirmação de Pix. Agora vai pra
     * `orphan_money_events` (migração 0024) e a rota pode responder 200 com o
     * evento guardado. Achado pela revisão de segurança de 2026-09-08.
     */
    if (!found && !buscaFalhou && !quieto) {
      try {
        await store.recordOrphanMoneyEvent({
          kind, txid, eventType: result.type || null,
          // QUAL adquirente — dito por quem SABE.
          //
          // Eu tinha adivinhado pelo prefixo do txid, e a adivinhação erra
          // justo no caso urgente: id de cobrança da Stripe também começa com
          // `ch_`, e um `payout.failed` chega sem txid nenhum. Um repasse da
          // Stripe que falhou era arquivado como Pagar.me, e o alerta mandava
          // o operador abrir o painel errado no meio de um incidente.
          psp: opts.psp || null,
          pspEventId: (result.raw && result.raw.eventId) || null,
          // O valor RECEBIDO quando existe. Num `unusable_money_event` o
          // `amountCents` é `undefined` de propósito (o parser estourou, é por
          // isso que é inutilizável) — e aí a linha provava que algo
          // aconteceu sem guardar nada sobre o dinheiro. O bruto da API é o
          // que sobra, e é melhor que nada.
          amountCents: (result.raw && result.raw.amountCents)
            ?? (result.raw && result.raw.raw && (
              Number(result.raw.raw.paid_amount) || Number(result.raw.raw.amount)
            )) ?? null,
          // MASCARADO: o corpo cru do PSP traz documento do pagador.
          /**
           * O `orderCode` VIAJA POR FORA DO MASCARADOR.
           *
           * `maskPixPayload` é lista de PERMISSÃO de escalares e derruba tudo o
           * que não está nela — inclusive isto, que é irmão do corpo do PSP e
           * não campo dele. O commit anterior jurava que o órfão carregava o
           * endereço da conta, e o runbook mandava consultar
           * `payload->>'orderCode'`: medido, o payload salvo era `{}` e a
           * consulta devolvia NULL sempre. Promessa em três artefatos, zero em
           * produção (compliance HIGH-2 de 2026-09-16).
           *
           * Mesclado DEPOIS da máscara, e de propósito: ele é
           * `<checkId>:<n>:<n>:<n>` — chave interna e três inteiros, sem dado
           * pessoal — então acrescentá-lo à lista de permissão do mascarador
           * afrouxaria um controle de segurança pra carregar um campo que não
           * vem do PSP.
           *
           * MAS PASSAR POR FORA DA MÁSCARA É PASSAR POR FORA DO QUE ELA FAZ.
           *
           * `maskPixPayload` faz duas coisas que o espalhamento não fazia:
           * corta em 128 caracteres e DERRUBA o que não é escalar. O
           * `data-map.md` afirma esse filtro de tipo como controle vivo —
           * "todo objeto aninhado morre no filtro de TIPO" — e a mesclagem
           * reabria os dois buracos para esta chave.
           *
           * E a chave não é nossa quando importa: `money_without_check` existe
           * por definição quando NÃO há linha nossa. Na Stripe Connect o
           * `orderCode` vem de `pi.metadata.charge_ref`, que a casa conectada
           * escreve à vontade — até 500 caracteres de UTF-8, com quebra de
           * linha. E o `reconcile-daily` imprime esse valor direto no aviso do
           * fundador, então um `\n` fabrica linhas DENTRO de um alerta de
           * dinheiro, e um CPF escrito ali ficaria gravado na única tabela que
           * o mapa de dados descreve como "só escalares mascarados".
           *
           * O formato é contrato — o runbook e o aviso o repartem por `:` —
           * então validar não é enfeite: o que não tem a forma não entra, e
           * quem procurar cai no caminho do painel do adquirente, que o
           * runbook já descreve. Achado pela quinta revisão de segurança
           * (2026-09-19, MEDIUM-3).
           */
          payload: {
            ...maskPixPayload(result.raw && result.raw.raw ? result.raw.raw : result.raw),
            ...(orderCodeUtil(result.raw && result.raw.orderCode)),
          },
        });
        persisted = true;
      } catch (e) {
        process.stderr.write(`[webhook] evento órfão não gravado: ${String(e.message).slice(0, 120)}\n`);
      }
    }
    let notified = false;
    if (!quieto && opts.alert !== false) {
      const r = await notify({
        kind, txid: txid || '?', checkId: found ? found.id : null,
        amountCents: (result.raw && result.raw.amountCents) || 0,
        detail: [result.type || null, result.raw && result.raw.status ? `status=${result.raw.status}` : null]
          .filter(Boolean).join(' ') || null,
      });
      notified = Boolean(r && r.ok);
    }
    // `found` sai junto porque a ROTA precisa dele pra decidir o 503: só quem
    // TINHA onde gravar e não gravou é que precisa de reentrega.
    // `found` responde "há onde gravar isto?" — e uma busca que FALHOU não
    // responde "não". Quem decide o 503 na rota é `persisted`; isto sai só como
    // diagnóstico.
    return { persisted, notified, quieto, found: Boolean(found), lookupFailed: buscaFalhou };
  };
}

/**
 * Este evento de dinheiro precisa de REENVIO?
 *
 * A regra em UMA cópia. Ela nasceu na rota do Pix, foi corrigida lá — o aviso
 * degrada e não pode substituir o registro durável — e a rota da Stripe ficou
 * com a versão antiga (`!persistido && !avisado`). Com `RACHA_NOTIFY_SECRET`
 * configurado, que é o estado pretendido em produção, aquele 503 NUNCA podia
 * disparar: um chargeback que não conseguiu ser gravado saía 200 e a Stripe
 * nunca reenviava.
 *
 * Duas rotas, uma regra, e um censo que confere as duas.
 * Achado pela revisão de segurança de 2026-09-08.
 *
 * @param {{persisted: boolean, quieto?: boolean}} r
 */
function needsRetry(r) {
  if (!r || r.quieto) return false;
  return !r.persisted;
}

module.exports = { createNonLedgerHandler, needsRetry, SEM_ALARDE };
