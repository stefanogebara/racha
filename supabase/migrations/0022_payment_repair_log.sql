-- 0022 — o registro de REPARO de dados: o que foi mexido, por quem, e o antes.
--
-- A 0021 reprojetou linhas de `payments` a partir do razao. A correcao e
-- defensavel (o razao e a verdade; a linha e projecao dele) e o runbook em
-- `docs/runbooks/migrations-0020-0021.md` guarda data, valores e contagens.
-- Mas um arquivo do repositorio e MUTAVEL: nele da pra AFIRMAR o que as linhas
-- eram, nao pra PROVAR. Numa discussao trabalhista ou fiscal sobre a base da
-- gorjeta (Lei 13.419), a diferenca entre afirmar e provar e a discussao
-- inteira. LGPD art. 6º X (responsabilizacao) e art. 37 (registro das
-- operacoes) pedem o mesmo: quem operou, quando, sobre o que.
--
-- Recomendacao da revisao de compliance de 2026-09-08.
--
-- A partir daqui, todo reparo de dados grava a imagem ANTERIOR aqui dentro, na
-- MESMA transacao da correcao. Uma linha por documento tocado.

create table if not exists public.payment_repair_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  migration    text        not null,           -- '0021_backfill_row_projection'
  operator     text        not null,           -- quem rodou (conta, nao "o sistema")
  reason       text        not null,
  txid         text        not null,
  before_row   jsonb,                          -- a imagem ANTERIOR; null = nao capturada
  after_row    jsonb
);

comment on table public.payment_repair_log is
  'Reparos de dados em `payments`: imagem anterior, operador e motivo. Ver 0022.';

create index if not exists payment_repair_log_txid_idx on public.payment_repair_log (txid);

alter table public.payment_repair_log enable row level security;
-- Sem policy: so a service-role le e escreve, igual ao resto do esquema.

-- O registro RETROATIVO da 0021, com a honestidade de dizer o que foi medido
-- e o que nao foi. Os valores anteriores abaixo sao os que a consulta da
-- sessao mostrou ANTES da correcao — copiados aqui como declaracao, nao como
-- captura automatica, porque a tabela ainda nao existia quando ela rodou. Esta
-- e exatamente a lacuna que a tabela fecha daqui pra frente.
insert into public.payment_repair_log (migration, operator, reason, txid, before_row, after_row)
select '0021_backfill_row_projection',
       'stefanogebara@gmail.com (Supabase management API, sessao Claude Code)',
       'Colunas 0015/0016 entraram no esquema antes do codigo que as escreve; linhas da janela ficaram no default. Reprojecao a partir do razao.',
       'ch_nP9yAPKpF2FKEJM1',
       jsonb_build_object(
         'status', 'devolvido', 'amount_cents', 500, 'tip_cents', 100,
         'confirmed_amount_cents', null, 'confirmed_tip_cents', null,
         'refunded_amount_cents', 0, 'refunded_tip_cents', 0,
         'nota', 'medido na sessao, antes da correcao'),
       to_jsonb(p) - 'psp_payload_masked'
  from public.payments p
 where p.txid = 'ch_nP9yAPKpF2FKEJM1'
   and not exists (
     select 1 from public.payment_repair_log l
      where l.txid = 'ch_nP9yAPKpF2FKEJM1'
        and l.migration = '0021_backfill_row_projection');

-- As 18 linhas que so tinham `confirmed_*` nulo entram como UMA declaracao
-- agregada: nenhum valor foi sobrescrito nelas (nulo -> valor do razao), entao
-- nao ha imagem anterior que se perca.
insert into public.payment_repair_log (migration, operator, reason, txid, before_row, after_row)
select '0021_backfill_row_projection',
       'stefanogebara@gmail.com (Supabase management API, sessao Claude Code)',
       '18 linhas confirmadas sem confirmed_*_cents (anteriores a 0015): preenchidas a partir do evento PAYMENT_CONFIRMED. Nenhum valor sobrescrito.',
       '(agregado: 18 linhas)',
       jsonb_build_object('confirmed_amount_cents', null, 'confirmed_tip_cents', null, 'linhas', 18),
       null
 where not exists (
   select 1 from public.payment_repair_log l
    where l.txid = '(agregado: 18 linhas)'
      and l.migration = '0021_backfill_row_projection');
