'use strict';

/**
 * O ÚNICO LUGAR QUE CONSTRÓI UM CLIENTE DO SUPABASE.
 *
 * Todo salto de rede do Racha tem prazo — o Pagar.me (`pagarme-psp.js`), o
 * Saipos (`pos/saipos.js`), as cinco pontes de aviso (`notify.js`). Todos menos
 * o BANCO, que é o único que TODA requisição atravessa. Um Postgrest que aceita
 * a conexão e pendura consumia os 120 s do `maxDuration`, a plataforma matava a
 * função, e nada saía: nem a resposta, nem o `catch` que escreve o alerta. A
 * malha inteira de "um alerta de dinheiro não pode sumir" (inegociável #8) era
 * alcançável por omissão. Medido em 2026-09-16 contra um servidor que aceita e
 * não responde: 6 s e subindo, sem teto.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POR QUE `AbortController` E NÃO `AbortSignal.timeout`
 *
 * O `postgrest-js` 2.110.7 REPETE erro de rede em método idempotente — 3 vezes,
 * com espera de 1 s, 2 s e 4 s. E a linha que decide isso é:
 *
 *     if (fetchError?.name === 'AbortError' || fetchError?.code === 'ABORT_ERR')
 *       throw fetchError;            // cancelamento deliberado: não repete
 *     if (!RETRYABLE_METHODS.includes(this.method)) throw fetchError;
 *     if (this.retryEnabled && attemptCount < 3) { ...espera...; continue; }
 *
 * `AbortSignal.timeout(T)` aborta com **TimeoutError**, que não casa com
 * nenhuma das duas pontas daquele `if` — então o prazo vira o gatilho da
 * repetição em vez do teto dela. Medido nos dois, contra o mesmo servidor
 * pendurado, com T = 1500 ms:
 *
 *     AbortSignal.timeout   → 13085 ms em 4 idas
 *     AbortController.abort →  1518 ms em 1 ida
 *
 * Oito vírgula sete vezes o número escrito no código. Um prazo de 10 s escrito
 * com a forma óbvia teria teto REAL de 47 s, e o comentário ao lado juraria 10.
 * `abort()` sem `reason` aborta com **AbortError**, que casa, e o teto passa a
 * ser o que está escrito. O teste `prazo-do-banco.test.js` MEDE os dois — é ele
 * que fica vermelho se uma versão nova do postgrest-js mudar essa linha.
 *
 * O que continua repetindo, de propósito, é a resposta 503/520: o Postgrest
 * devolve 503 enquanto recarrega o cache de esquema (logo depois de uma
 * migração), e ali a resposta vem RÁPIDA — o custo é a espera entre as idas,
 * não o prazo. Essa repetição salva o minuto seguinte a um deploy de migração.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Dez segundos. Uma consulta sadia do Supabase volta em 20–200 ms; o que passa
 * de dez não vai voltar útil, e a função ainda tem 110 s pra classificar o erro,
 * gritar e responder. Ajustável por env pra uma casa com relatório pesado, com
 * piso e teto — um `RACHA_DB_TIMEOUT_MS=0` de dedo torto não pode desligar a
 * guarda em silêncio, que é o modo de falha desta caixa inteira.
 */
const PADRAO_MS = 10_000;
const PISO_MS = 1_000;
const TETO_MS = 60_000;

function prazoConfigurado() {
  const cru = process.env.RACHA_DB_TIMEOUT_MS;
  if (cru === undefined || cru === '') return PADRAO_MS;
  const n = Number(cru);
  if (!Number.isFinite(n) || n < PISO_MS || n > TETO_MS) {
    process.stderr.write(
      `[banco] RACHA_DB_TIMEOUT_MS=${JSON.stringify(cru)} fora de [${PISO_MS}, ${TETO_MS}] — usando ${PADRAO_MS} ms\n`,
    );
    return PADRAO_MS;
  }
  return n;
}

/**
 * O `fetch` com prazo. Exportado pra que o teste possa medi-lo sem subir um
 * cliente inteiro.
 *
 * O aviso no stderr é metade do conserto: uma guarda que corta em silêncio
 * troca "a função morreu sem log" por "a consulta falhou sem log", e a segunda
 * é mais difícil de achar que a primeira. Sai o MÉTODO e o CAMINHO — nunca a
 * query, que carrega ids de conta, nem os cabeçalhos, que carregam a chave.
 */
function fetchComPrazo(prazoMs, fetchBase = fetch) {
  return function fetchDoBanco(entrada, init = {}) {
    const ac = new AbortController();
    // Sem `reason`: é o `AbortError` que o postgrest-js reconhece como
    // cancelamento deliberado. Ver o bloco acima — trocar isto por
    // `AbortSignal.timeout` multiplica o teto por quatro sem mudar o número.
    const corte = setTimeout(() => ac.abort(), prazoMs);
    if (typeof corte.unref === 'function') corte.unref();
    /**
     * O sinal de QUEM CHAMOU continua valendo — inclusive quando ele JÁ abortou.
     *
     * Escrito só como `addEventListener('abort', ...)`, o caso que o comentário
     * nomeava era exatamente o que não funcionava: num sinal já abortado o
     * evento já disparou, o ouvinte nunca roda, e a requisição saía no nosso
     * `ac.signal`, que não está abortado. A guarda não disparava pra entrada que
     * a própria frase citava. E o ouvinte nunca era removido, então um sinal
     * longevo acumulava um por requisição até o aviso de vazamento do Node.
     * Achado pela revisão de segurança de 2026-09-16 (LOW-4).
     */
    const repassar = () => ac.abort();
    if (init.signal) {
      if (init.signal.aborted) ac.abort();
      else init.signal.addEventListener('abort', repassar, { once: true });
    }
    const soltar = () => {
      clearTimeout(corte);
      if (init.signal) init.signal.removeEventListener('abort', repassar);
    };
    return fetchBase(entrada, { ...init, signal: ac.signal }).then(
      (r) => { soltar(); return r; },
      (e) => {
        soltar();
        if (ac.signal.aborted && !(init.signal && init.signal.aborted)) {
          let onde = String(entrada);
          try { onde = `${init.method || 'GET'} ${new URL(onde).pathname}`; } catch { /* entrada não-URL */ }
          process.stderr.write(`[banco] PRAZO ESTOURADO em ${prazoMs} ms: ${onde}\n`);
        }
        throw e;
      },
    );
  };
}

/**
 * @param {string} url
 * @param {string} chave
 * @param {object} [extras] opções repassadas ao `createClient` (o `auth` de
 *   cada chamador difere: o de dados não guarda sessão, o de login também não
 *   renova token).
 */
function criarClienteSupabase(url, chave, extras = {}) {
  const { createClient } = require('@supabase/supabase-js');
  const prazoMs = prazoConfigurado();
  return createClient(url, chave, {
    ...extras,
    // `global.fetch` desce pro postgrest E pro gotrue — o login também pendurava,
    // e um `/api/panel` que espera pra sempre pelo GoTrue é o mesmo buraco com
    // outro nome.
    global: { ...(extras.global || {}), fetch: fetchComPrazo(prazoMs) },
  });
}

module.exports = { criarClienteSupabase, fetchComPrazo, prazoConfigurado, PADRAO_MS, PISO_MS, TETO_MS };
