-- 0021 — a LINHA reprojetada a partir do razao (correcao de dados, unica vez).
--
-- As colunas `confirmed_*_cents` (0015) e `refunded_*_cents` (0016) entraram no
-- esquema antes de o codigo que as escreve chegar a producao. Toda linha
-- gravada nessa janela ficou com o default: zero estornado, confirmado nulo.
--
-- O que isso deixou para tras, medido em producao em 2026-09-08:
--   - 1 linha `devolvido` com `refunded_* = 0` e o razao dizendo 500 + 100;
--   - 18 linhas `confirmado` sem valor confirmado (essas o `confirmedMoney`
--     ja resolve caindo no registrado — ficam corretas de todo jeito, e sao
--     preenchidas aqui so pra linha parar de depender do fallback).
--
-- O razao e a verdade (inegociavel #6): a linha e uma projecao dele. Entao a
-- correcao nao "escolhe" numero nenhum — ela recalcula da soma dos eventos.
-- Idempotente por construcao: rodar de novo escreve os mesmos valores.

-- A TABELA DE REPARO, criada aqui, porque este arquivo escreve nela.
--
-- Ela nasceu na 0022 — depois desta — e este arquivo insere nela em tres
-- pontos. Aplicado na ordem numerica (que e o modelo que o `sql-contract.test`
-- usa, e o de qualquer replay do esquema), a 0021 morria com `42P01`. Em
-- producao passou porque foi aplicada a mao; um banco novo, o staging e uma
-- restauracao de desastre nao passariam — e o canario sintetico do staging
-- depende de conseguir construir o esquema a partir destes arquivos.
--
-- Pior desta rodada: o primeiro dos tres inserts passou a ser a PRIMEIRA
-- instrucao do arquivo, entao ele deixou de falhar no meio e passou a falhar
-- na largada — a semantica de aplicacao parcial mudou sem ninguem pedir.
-- `if not exists` nos dois lugares mantem as duas ordens validas.
-- Achado pela revisao de seguranca de 2026-09-08.


create table if not exists public.payment_repair_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  migration    text        not null,
  operator     text        not null,
  reason       text        not null,
  txid         text        not null,
  before_row   jsonb,
  after_row    jsonb
);
-- 1) o acumulado ESTORNADO, liquido das reversoes de estorno que falhou.
-- A imagem ANTERIOR das linhas que o passo 1 vai tocar. Este passo nao tinha
-- registro nenhum — e o passo 3, que e o que pode mexer na base da folha de um
-- periodo fechado, tambem nao. So o passo 2 tinha. O arquivo e a 0022
-- afirmavam a politica em geral; ela valia pra um terco dela.
-- Achado pela revisao de seguranca de 2026-09-08.
with mov as (
  select (payload->>'txid') as txid,
         sum(case when type = 'PAYMENT_REFUNDED'         then (payload->>'amountCents')::bigint
                  when type = 'PAYMENT_REFUND_REVERSED'  then -(payload->>'amountCents')::bigint
                  else 0 end) as amt,
         sum(case when type = 'PAYMENT_REFUNDED'         then (payload->>'tipCents')::bigint
                  when type = 'PAYMENT_REFUND_REVERSED'  then -(payload->>'tipCents')::bigint
                  else 0 end) as tip
    from check_events
   where type in ('PAYMENT_REFUNDED', 'PAYMENT_REFUND_REVERSED')
     and payload ? 'txid'
   group by 1
)
insert into public.payment_repair_log (migration, operator, reason, txid, before_row, after_row)
select '0021_backfill_row_projection',
       coalesce(current_setting('racha.operator', true), current_user),
       'reprojecao do acumulado estornado a partir do razao',
       p.txid,
       jsonb_build_object(
         'status', p.status,
         'refunded_amount_cents', p.refunded_amount_cents,
         'refunded_tip_cents', p.refunded_tip_cents),
       jsonb_build_object(
         'refunded_amount_cents', greatest(0, mov.amt)::integer,
         'refunded_tip_cents', greatest(0, mov.tip)::integer)
  from public.payments p join mov on mov.txid = p.txid
 where p.refunded_amount_cents is distinct from greatest(0, mov.amt)::integer
    or p.refunded_tip_cents    is distinct from greatest(0, mov.tip)::integer;

with mov as (
  select (payload->>'txid') as txid,
         sum(case when type = 'PAYMENT_REFUNDED'         then (payload->>'amountCents')::bigint
                  when type = 'PAYMENT_REFUND_REVERSED'  then -(payload->>'amountCents')::bigint
                  else 0 end) as amt,
         sum(case when type = 'PAYMENT_REFUNDED'         then (payload->>'tipCents')::bigint
                  when type = 'PAYMENT_REFUND_REVERSED'  then -(payload->>'tipCents')::bigint
                  else 0 end) as tip
    from check_events
   where type in ('PAYMENT_REFUNDED', 'PAYMENT_REFUND_REVERSED')
     and payload ? 'txid'
   group by 1
)
update payments p
   set refunded_amount_cents = greatest(0, mov.amt)::integer,
       refunded_tip_cents    = greatest(0, mov.tip)::integer
  from mov
 where mov.txid = p.txid
   and (p.refunded_amount_cents is distinct from greatest(0, mov.amt)::integer
     or p.refunded_tip_cents    is distinct from greatest(0, mov.tip)::integer);

-- 2) o valor CONFIRMADO, do evento de confirmacao daquele txid.
--
-- `coalesce(...,0)` na gorjeta NAO e decoracao: `JSON.stringify` DROPA a chave
-- quando `tipCents` e `undefined`, e `payload->>'tipCents'` de uma chave
-- ausente e NULL. Sem o coalesce, este passo escreveria
-- `confirmed_tip_cents = NULL` por cima de um valor bom — e ai o
-- `confirmedMoney` cai na gorjeta PEDIDA e o `tip_mismatch` nem roda
-- (`Number.isFinite(null)` e falso). A base da folha voltaria calada pro que
-- foi cobrado em vez do que foi arrecadado.
--
-- REPROJECAO, nao preenchimento de nulos: uma linha com valor confirmado
-- ERRADO e o caso que importa, e `where … is null` passava por cima dele.
--
-- E POR ISSO ESTE ARQUIVO NAO E PRA SE RODAR DE NOVO A ESMO. Ele torna iguais,
-- por decreto, os DOIS lados que o detector compara (`amount_mismatch` e
-- `tip_mismatch` conferem a coluna confirmada contra o razao): rodar depois de
-- um defeito de escrita apagaria a evidencia em vez de investiga-la. Por isso
-- a imagem ANTERIOR de toda linha tocada vai pra `payment_repair_log`
-- (migracao 0022) ANTES da escrita — "reparar" nunca pode significar "sumir
-- com o rastro". Alerta da revisao de seguranca de 2026-09-08.

with conf as (
  select distinct on ((payload->>'txid'))
         (payload->>'txid') as txid,
         coalesce((payload->>'amountCents')::bigint, 0) as amt,
         coalesce((payload->>'tipCents')::bigint, 0) as tip
    from check_events
   where type = 'PAYMENT_CONFIRMED' and payload ? 'txid'
   order by (payload->>'txid'), seq asc
)
insert into public.payment_repair_log (migration, operator, reason, txid, before_row, after_row)
select '0021_backfill_row_projection',
       coalesce(current_setting('racha.operator', true), current_user),
       'reprojecao do valor confirmado a partir do razao',
       p.txid,
       -- LISTA BRANCA, não `to_jsonb(p) - 'psp_payload_masked'`.
       --
       -- Aquilo era subtrair-um-e-guardar-o-resto: o campo removido era o que
       -- ja estava mascarado, e o que ficava incluia `payer_label` — nome que o
       -- CLIENTE digitou — numa tabela feita pra ser permanente. E a proxima
       -- coluna que `payments` ganhar (um documento, um telefone) entraria
       -- sozinha, sem ninguem notar. Um log de reparo precisa das colunas de
       -- DINHEIRO, nao da linha. Ver `mask.js`, que acerta isso no mesmo commit
       -- e diz por que. Achado pela revisao de seguranca de 2026-09-08.
       jsonb_build_object(
         'txid', p.txid, 'status', p.status,
         'amount_cents', p.amount_cents, 'tip_cents', p.tip_cents,
         'confirmed_amount_cents', p.confirmed_amount_cents,
         'confirmed_tip_cents', p.confirmed_tip_cents,
         'refunded_amount_cents', p.refunded_amount_cents,
         'refunded_tip_cents', p.refunded_tip_cents,
         'confirmed_at', p.confirmed_at),
       jsonb_build_object('confirmed_amount_cents', conf.amt, 'confirmed_tip_cents', conf.tip)
  from public.payments p join conf on conf.txid = p.txid
 where p.confirmed_amount_cents is distinct from conf.amt::integer
    or p.confirmed_tip_cents    is distinct from conf.tip::integer;

with conf as (
  select distinct on ((payload->>'txid'))
         (payload->>'txid') as txid,
         coalesce((payload->>'amountCents')::bigint, 0) as amt,
         coalesce((payload->>'tipCents')::bigint, 0) as tip
    from check_events
   where type = 'PAYMENT_CONFIRMED' and payload ? 'txid'
   order by (payload->>'txid'), seq asc
)
update payments p
   set confirmed_amount_cents = conf.amt::integer,
       confirmed_tip_cents    = conf.tip::integer
  from conf
 where conf.txid = p.txid
   and (p.confirmed_amount_cents is distinct from conf.amt::integer
     or p.confirmed_tip_cents    is distinct from conf.tip::integer);

-- 3) o STATUS da linha, que so pode ser `devolvido` no estorno TOTAL.
--    Ver a 0016: `devolvido` num estorno parcial some com o pagamento inteiro
--    do faturamento e da gorjeta.
--
-- ATENCAO ao rodar esta terceira parte: ela pode mexer na BASE DA FOLHA de um
-- periodo ja fechado. Uma linha que sai de `devolvido` volta a contar em
-- `tipsCents`, e a distribuicao da gorjeta daquele mes (Lei 13.419, criterios
-- da CCT) foi calculada sobre o numero antigo — os empregados receberam a
-- menos. Se esta instrucao alterar alguma linha, o restaurante PRECISA ser
-- avisado; nao basta a linha mudar. Nesta execucao (2026-09-08) ela nao
-- alterou nada: o unico `devolvido` tinha estorno total.
-- A imagem ANTERIOR do passo 3 — o de maior risco de auditoria do arquivo,
-- porque ele devolve a gorjeta de uma linha pra `tipsCents` de um periodo que
-- pode estar fechado. Era o unico com `returning` e nenhum registro durável:
-- quem estava olhando o console via, e mais ninguem.
insert into public.payment_repair_log (migration, operator, reason, txid, before_row, after_row)
select '0021_backfill_row_projection',
       coalesce(current_setting('racha.operator', true), current_user),
       'status devolvido -> confirmado (estorno PARCIAL, nao total) — REVER A FOLHA do periodo',
       p.txid,
       jsonb_build_object(
         'status', p.status,
         'confirmed_amount_cents', p.confirmed_amount_cents,
         'confirmed_tip_cents', p.confirmed_tip_cents,
         'refunded_amount_cents', p.refunded_amount_cents,
         'refunded_tip_cents', p.refunded_tip_cents,
         'confirmed_at', p.confirmed_at),
       jsonb_build_object('status', 'confirmado')
  from public.payments p
 where p.status = 'devolvido'
   and p.confirmed_amount_cents is not null
   and (p.refunded_amount_cents < p.confirmed_amount_cents
     or p.refunded_tip_cents    < p.confirmed_tip_cents);

update payments p
   set status = 'confirmado'
 where p.status = 'devolvido'
   and p.confirmed_amount_cents is not null
   and (p.refunded_amount_cents < p.confirmed_amount_cents
     or p.refunded_tip_cents    < p.confirmed_tip_cents)
returning p.txid, p.check_id, p.confirmed_tip_cents;
