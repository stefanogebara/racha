'use strict';

/**
 * A CONTA SEM `OPENED` — quando ela é janela, e quando ela é órfã.
 *
 * Até a migração 0037, `openCheck` gravava a linha em `checks` e, noutra ida
 * ao banco, o `OPENED`. Se o processo morria entre as duas, a linha virava
 * ÓRFÃ: o índice `checks_one_open_per_table` a conta como aberta, a mesa não
 * abre outra conta (409), e toda leitura precisa pular a linha. Desde a 0037 a
 * `open_check` grava as duas numa transação — a órfã só existe de ANTES dela
 * (ou de uma instância com código velho durante o deploy), e por isso cada
 * disparo daqui é anomalia real, não janela.
 *
 * Pular calado foi o defeito da quarta rodada: a leitura pública devolvia 404
 * `check_not_found` — o mesmo byte de "o garçom ainda não abriu" —, sem uma
 * linha de log, e a conciliação dizia `ok`. Uma mesa trancada pra sempre, e
 * ninguém sabendo. Inegociável #7: o silêncio é o inimigo.
 *
 * Então há UM número pra separar janela de órfã, e todo leitor que pula uma
 * conta sem `OPENED` pergunta a ele: a leitura escreve o alarme, a conciliação
 * diária emite achado `critical` (que pagina). O conserto de verdade é a RPC
 * que insere e grava o `OPENED` na mesma transação — com ela, isto só dispara
 * se algo quebrar o que a RPC promete.
 *
 * Puro: sem I/O. Quem escreve o log é o store.
 */

/** A janela normal entre as duas escritas é de milissegundos; 30 s é folga. */
const JANELA_DE_ABERTURA_MS = 30_000;

/**
 * Há quanto tempo, em ms, a conta existe sem `OPENED` — e se já passou da
 * janela. Data ilegível ou ausente conta como ÓRFÃ: na dúvida, alarme. Um
 * alarme falso custa uma olhada; um silêncio custa uma mesa.
 *
 * @returns {{ idadeMs: number|null, orfa: boolean }}
 */
function idadeSemOpened(openedAt, agoraMs, janelaMs = JANELA_DE_ABERTURA_MS) {
  const ms = Date.parse(openedAt);
  if (!Number.isFinite(ms) || !Number.isFinite(agoraMs)) return { idadeMs: null, orfa: true };
  const idadeMs = agoraMs - ms;
  return { idadeMs, orfa: idadeMs > janelaMs };
}

/** A linha de alarme — um formato só, pra quem procura no log achar sempre. */
function linhaDeAlarme(checkId, idadeMs, onde) {
  const idade = idadeMs == null ? '?' : `${Math.round(idadeMs / 1000)}s`;
  return `[conta-sem-opened] check=${checkId} idade=${idade} em=${onde}\n`;
}

module.exports = { JANELA_DE_ABERTURA_MS, idadeSemOpened, linhaDeAlarme };
