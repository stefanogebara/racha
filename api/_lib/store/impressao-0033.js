'use strict';

/**
 * A IMPRESSÃO DIGITAL que a migração 0033 ATUAL deixa no banco — o md5 do texto
 * das funções do teto e das colunas do livro. Ver `charge_slots_fingerprint()`
 * no fim de `supabase/migrations/0033_charge_slots.sql`.
 *
 * Lida pelo portão de deploy (`scripts/deploy.mjs`), que se recusa a publicar
 * contra um banco com outra versão, e pelo cron de quinze minutos, que pagina
 * enquanto produção tiver outra. A sonda anterior pedia um comportamento que a
 * versão anterior da 0033 também tinha, e passava sobre ela (revisão de
 * segurança de 7a65e93, M2).
 *
 * O `sql-teto-vivo` recalcula este número no Postgres de verdade e exige que
 * seja este: editar uma das três funções, ou uma coluna do livro, sem
 * atualizar aqui deixa a suíte vermelha — nunca o deploy verde.
 */
const IMPRESSAO_0033 = '3c5748e7ef04fb8aeafffae051ff32cc';

module.exports = { IMPRESSAO_0033 };
