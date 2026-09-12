-- 0032 — o REGISTRO de que a retencao rodou.
--
-- A 0031 construiu o expurgo e ele funciona. A metade que DETECTA nao existia:
-- o unico rastro de uma execucao era uma linha de stderr e uma mensagem numa
-- ponte que vira no-op silencioso sem `RACHA_NOTIFY_SECRET`. "A ausencia da
-- batida diaria e o alarme" so vale se alguma coisa alertar sobre a ausencia —
-- e nada alertava. Pior: em regime a batida diz zero todo dia, que e a coisa
-- mais ignoravel que existe numa caixa de entrada.
--
-- Isto e PROVA DE EXECUCAO — art. 6 X, responsabilizacao e prestacao de contas
-- — mais o registro de resposta do art. 18 §4. NAO e o art. 37: aquele pede o
-- registro das OPERACOES de tratamento, e esse registro e o
-- docs/compliance/data-map.md. Chamar esta tabela de "o art. 37" faria alguem
-- concluir depois que a obrigacao esta cumprida por um log de execucao enquanto
-- a ROPA de verdade envelhece. Ate aqui o "comprovante" de uma resposta do art.
-- 18 §4 era uma linha no terminal de quem executou.
--
-- A gravacao acontece DENTRO das funcoes, na mesma transacao do expurgo: um
-- registro que pode divergir do que aconteceu nao e registro.

create table if not exists public.retention_runs (
  id             bigserial primary key,
  at             timestamptz not null default now(),
  -- 'purge' = a varredura diaria. 'erasure_request' = pedido de titular.
  kind           text not null check (kind in ('purge', 'erasure_request')),
  payer_labels   integer not null default 0,
  payer_hints    integer not null default 0,
  house_accounts integer not null default 0,
  check_views    integer not null default 0,
  -- So pro pedido do titular: QUAL pagamento foi atendido.
  --
  -- E dado pessoal pseudonimizado (o txid resolve pro cadastro do pagador no
  -- painel da adquirente — ver docs/compliance/retencao.md), e fica aqui porque
  -- o art. 18 §4 exige poder responder pelo que foi feito. Nao acrescenta
  -- exposicao: o mesmo txid ja vive na linha de `payments` que a execucao
  -- tocou. O que se apaga e o NOME; o registro de que se apagou fica.
  txid           text,
  -- DISJUNCAO ESTRUTURAL, nao convencional. `payer_labels` significa coisas
  -- diferentes conforme o `kind` (linhas varridas pela purga diaria vs. linhas
  -- tocadas por um txid), e nada no esquema dizia isso: qualquer agregado
  -- futuro sem filtro de kind sairia errado em silencio. Agora um registro de
  -- purga nao pode carregar txid, e um pedido de titular nao pode vir sem.
  constraint retention_runs_kind_txid check ((kind = 'erasure_request') = (txid is not null)),
  -- Contagens de purga so existem na purga.
  constraint retention_runs_purge_counts check (
    kind = 'purge' or (payer_hints = 0 and house_accounts = 0 and check_views = 0)
  )
);

create index if not exists retention_runs_at_idx on public.retention_runs (at desc);

-- AS CONSTRAINTS FORA DO `create table`.
--
-- Este arquivo foi editado depois de ter sido commitado uma vez, e ganhou as
-- duas `check` no meio do `create table if not exists`. Em qualquer ambiente
-- onde a versao anterior ja tivesse rodado, o `create table` e pulado inteiro e
-- as constraints somem em silencio — enquanto o `revoke` e os `create or
-- replace` aplicam normalmente, entao PARECE aplicado. Aqui elas entram por
-- `alter table`, idempotente, que roda nos dois casos.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'retention_runs_kind_txid') then
    alter table public.retention_runs
      add constraint retention_runs_kind_txid check ((kind = 'erasure_request') = (txid is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'retention_runs_purge_counts') then
    alter table public.retention_runs
      add constraint retention_runs_purge_counts check (
        kind = 'purge' or (payer_hints = 0 and house_accounts = 0 and check_views = 0)
      );
  end if;
end $$;

alter table public.retention_runs enable row level security;
revoke all on public.retention_runs from anon, authenticated;
-- A SEQUENCIA tambem. O `alter default privileges` do Supabase concede em
-- TABELAS e em SEQUENCIAS, e RLS nao cobre sequencia — grant e o unico controle
-- naquele objeto. A migracao 0025 existe so por causa disso, e a 0028 (que
-- tambem cria `bigserial`) faz as duas linhas. Esta fazia tres de quatro.
revoke all on sequence public.retention_runs_id_seq from anon, authenticated;

-- O COMMENT e a copia que chega no Postgres: e ela que aparece no `\\d+`, no
-- navegador de tabelas do Supabase e num dump de esquema pra auditoria. Dizia
-- "art. 37" enquanto o cabecalho deste mesmo arquivo argumenta que chamar isto
-- de art. 37 e o erro que deixa a ROPA de verdade envelhecer. A unica versao
-- que alguem de fora le era a errada.
comment on table public.retention_runs is
  'Prova de execucao da retencao (LGPD art. 6 X) e registro das respostas do art. 18 §4. NAO e o art. 37 — a ROPA e docs/compliance/data-map.md. Ver docs/compliance/retencao.md.';

-- A propria tabela tem prazo: 5 anos, o mesmo do registro contabil, porque e
-- registro de conformidade e nao dado operacional. E o prazo e EXECUTADO pela
-- propria purga, la embaixo — nao dito num comentario.
--
-- O portao de compliance decidiu contra mim aqui, e a razao e boa: esta e a
-- tabela que registra as pessoas que pediram explicitamente pra serem
-- esquecidas, e era a unica com prazo escrito e nao cumprido. Em qualquer outro
-- lugar "dito e nao feito" e risco de processo; aqui aponta pros titulares com
-- a pretensao mais forte.

create or replace function public.purge_expired_personal_data(
  p_label_days integer default 90,
  p_wallet_days integer default 90,
  p_views_days integer default 90
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_labels integer := 0;
  v_hints integer := 0;
  v_extra integer := 0;
  v_wallets integer := 0;
  v_views integer := 0;
begin
  if p_label_days is null or p_wallet_days is null or p_views_days is null
     or p_label_days < 30 or p_wallet_days < 30 or p_views_days < 7 then
    raise exception 'purge_expired_personal_data: prazo curto demais (% % %)',
      p_label_days, p_wallet_days, p_views_days
      using errcode = '22023';
  end if;

  update public.payments p
     set payer_label = null, updated_at = now()
    from public.checks c
   where p.check_id = c.id
     and p.payer_label is not null
     and c.status = 'fechada'
     and c.closed_at is not null
     and c.closed_at < now() - make_interval(days => p_label_days);
  get diagnostics v_labels = row_count;

  update public.payments p
     set payer_label = null, updated_at = now()
   where p.payer_label is not null
     and p.created_at < now() - make_interval(days => p_label_days * 2);
  get diagnostics v_extra = row_count;
  v_labels := v_labels + v_extra;

  update public.payments
     set psp_payload_masked = psp_payload_masked - 'payer_hint' - 'payer_doc_hint',
         updated_at = now()
   where psp_payload_masked ?| array['payer_hint', 'payer_doc_hint'];
  get diagnostics v_hints = row_count;

  update public.house_accounts a
     set phone = null, name = '—', updated_at = now()
   where a.phone is not null
     and a.principal_cents = 0
     and not exists (
       select 1 from public.house_bonus_lots l
        where l.account_id = a.id and l.remaining_cents > 0 and l.expires_at > now()
     )
     and not exists (
       select 1 from public.house_account_events e
        where e.account_id = a.id
          and e.created_at >= now() - make_interval(days => p_wallet_days)
     )
     and a.updated_at < now() - make_interval(days => p_wallet_days);
  get diagnostics v_wallets = row_count;

  delete from public.check_views
   where at < now() - make_interval(days => p_views_days);
  get diagnostics v_views = row_count;

  -- O PROPRIO REGISTRO tem prazo, e ele e cumprido aqui. Nao entra em contagem
  -- nenhuma: e higiene da tabela de conformidade, nao dado de cliente expurgado,
  -- e somar os dois faria o numero do art. 18 mentir.
  delete from public.retention_runs
   where at < now() - interval '5 years';

  -- A LINHA DO REGISTRO, na mesma transacao. Se o expurgo reverter, o registro
  -- reverte junto — e e por isso que ela mora aqui e nao no chamador.
  insert into public.retention_runs (kind, payer_labels, payer_hints, house_accounts, check_views)
    values ('purge', v_labels, v_hints, v_wallets, v_views);

  return jsonb_build_object(
    'payer_labels', v_labels,
    'payer_hints', v_hints,
    'house_accounts', v_wallets,
    'check_views', v_views
  );
end;
$$;

create or replace function public.erase_payment_label(p_txid text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer := 0;
begin
  if p_txid is null or length(p_txid) < 4 then
    raise exception 'erase_payment_label: txid obrigatorio' using errcode = '22023';
  end if;
  update public.payments
     set payer_label = null, updated_at = now()
   where txid = p_txid;
  get diagnostics v_n = row_count;

  -- Registra SEMPRE, inclusive quando nao achou linha: "pediram e nao havia" e
  -- uma resposta do art. 18 §4 tanto quanto "pediram e apagamos".
  insert into public.retention_runs (kind, payer_labels, txid)
    values ('erasure_request', v_n, p_txid);

  return v_n;
end;
$$;

revoke all on function public.erase_payment_label(text) from public, anon, authenticated;
revoke all on function public.purge_expired_personal_data(integer, integer, integer)
  from public, anon, authenticated;
