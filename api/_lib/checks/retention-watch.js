'use strict';

/**
 * A retenção está viva? — puro, testável, e fora da rota de propósito.
 *
 * A primeira versão disto era um bloco dentro do `/api/cron/reconcile`, e o
 * teste dela era censo de fonte: `expect(rota).toMatch(/48/)`. A revisão de
 * segurança rodou cinco mutações contra aquele bloco e TODAS passaram verdes —
 * inclusive `const retencaoAtrasada = false && retencao`, que é o guarda
 * simplesmente desligado. O motivo é estrutural: o `router` não exporta a rota,
 * então não havia como exercer a decisão, só como procurar substring no
 * arquivo. Censo de fonte não prova comportamento.
 *
 * Então a decisão saiu pra cá, onde uma tabela de casos a exercita de verdade.
 *
 * A regra, escrita na direção que falha FECHADA: só é saudável um expurgo
 * confirmado e recente. Qualquer outra coisa — nunca rodou, data ilegível, data
 * no futuro, store que não sabe responder, erro ao ler — é atraso. A primeira
 * versão perguntava o contrário ("está atrasado?") e por isso `NaN` e
 * `undefined` respondiam "não" e viravam silêncio.
 */

/** Duas diárias de folga: um dia perdido é deploy demorado, dois é defeito. */
const LIMITE_HORAS = 48;

/**
 * @param {{at?: string}|null|undefined} ultima  o último expurgo, ou null
 * @param {{agoraMs?: number, erro?: string}} [ctx]
 * @returns {{atrasada: boolean, horas: number|null, linha: string}}
 */
function avaliarRetencao(ultima, ctx = {}) {
  const agora = Number.isFinite(ctx.agoraMs) ? ctx.agoraMs : Date.now();

  if (ctx.erro) {
    return { atrasada: true, horas: null,
      linha: '\n⚠ RETENÇÃO: não foi possível ler o registro de execução.' };
  }

  const t = ultima && ultima.at ? Date.parse(ultima.at) : NaN;
  // `Number.isFinite` cobre data ilegível; o `< 0` cobre data no futuro, que
  // também não é prova de que rodou.
  const horas = Number.isFinite(t) ? Math.floor((agora - t) / 3_600_000) : null;
  const fresca = horas !== null && horas >= 0 && horas < LIMITE_HORAS;

  if (fresca) return { atrasada: false, horas, linha: '' };
  if (horas === null) {
    return { atrasada: true, horas: null,
      linha: '\n⚠ RETENÇÃO: nunca rodou (ou o registro está ilegível). '
        + 'O aviso de privacidade promete exclusão em 90 dias.' };
  }
  return { atrasada: true, horas,
    linha: `\n⚠ RETENÇÃO: última execução há ${horas}h (limite ${LIMITE_HORAS}h).` };
}

module.exports = { avaliarRetencao, LIMITE_HORAS };
