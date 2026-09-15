-- 0033 — o TETO DE COBRANÇAS VIVAS vira uma reivindicação ATÔMICA no banco.
--
-- Terceira forma dele, e as duas anteriores foram medidas ao contrário pela
-- revisão de segurança de 2026-09-15:
--
--  · a primeira contava as pendentes e comparava. A janela entre ler e gravar
--    é uma ida inteira ao PSP, então trezentos pedidos simultâneos criavam
--    trezentas cobranças e nenhum era recusado; e sessenta cobranças de UM
--    CENTAVO de quem tinha o QR da mesa trancavam a mesa inteira;
--  · a segunda pôs um balde por ORIGEM na memória da função e uma reserva
--    "em voo" local. O balde vive por instância (três instâncias, um IP, e a
--    mesa trancada de novo), a janela dele era de dez minutos contra quinze de
--    vida da cobrança (uma origem atravessava três janelas), ele contava
--    pedido INVÁLIDO (noventa corpos lixo do wi-fi do salão trancavam quem
--    estava na mesa, com zero cobrança criada), e a reserva não era atômica
--    nem dentro da instância (214 criadas contra teto 200).
--
-- Todos esses defeitos moravam na MEMÓRIA da função. Aqui a contagem e a
-- reserva são uma instrução só, sob trava consultiva, no único lugar que todas
-- as instâncias compartilham — é o padrão do inegociável #7 (RPC com o erro
-- checado), usado aqui não porque a reivindicação MOVE dinheiro, mas porque
-- é o único jeito de ela ser verdadeira.
--
-- A janela é DESLIZANTE (conta linha por `created_at`), então não há borda de
-- janela pra atravessar. E quem chama reivindica DEPOIS da validação e logo
-- antes do PSP: pedido inválido não ocupa vaga.
--
-- O QUE ISTO NÃO GUARDA: IP, telefone, nome. As chaves, TODAS — a lista
-- anterior omitia duas (compliance LOW-2 de 7a65e93):
--  · cobrança e recarga, janela de 15 min: `check:<uuid>:<geração do QR>` (a
--    geração é hash de um token aleatório, não o token), `account:<uuid>`,
--    `venue:<uuid>`;
--  · aviso ao operador, janela de 6 h: `alerta:check:<uuid>:<geração>`,
--    `alerta:venue:<uuid>`, e os de suspensão `alerta:suprimido:venue:<uuid>` e
--    `alerta:suprimido:global`; o da impressão da 0033, janela de 1 h:
--    `alerta:impressao:<md5>`;
--  · contadores de aviso, janela de 1 dia: `alerta-dia:venue:<uuid>:mesa`,
--    `alerta-dia:venue:<uuid>:recarga` e `alerta-dia:global`.
-- Dado pessoal aqui, PSEUDÔNIMO: o id de conta de saldo, e o id de conta da mesa
-- — este resolve pros pagamentos dela e, por uns meses, pro rótulo de quem pagou,
-- o mesmo critério que faz do `txid` dado pessoal em `retencao.md` (a versão
-- anterior deste texto dizia que as linhas de aviso não carregavam dado pessoal;
-- compliance LOW-C de 3a10835). PRAZO: cada linha carrega a PRÓPRIA janela
-- (`window_seconds`), e o expurgo diário (`purge_expired_personal_data`,
-- redefinido abaixo) apaga a que passou dela: as de cobrança e recarga ficam até
-- cerca de 24 horas, as de aviso até cerca de 48.

create table if not exists public.charge_slots (
  claim_id uuid not null,
  slot_key text not null check (char_length(slot_key) between 1 and 120),
  created_at timestamptz not null default now(),
  primary key (claim_id, slot_key)
);
create index if not exists charge_slots_key_created_idx
  on public.charge_slots (slot_key, created_at);
create index if not exists charge_slots_created_idx
  on public.charge_slots (created_at);

-- A JANELA MORA NA LINHA, e entra por `alter table`, idempotente — a lição da
-- 0032: num ambiente onde uma versão anterior deste arquivo já rodou, o `create
-- table if not exists` acima é pulado inteiro, e uma coluna posta dentro dele
-- sumiria em silêncio. Sem a janela na linha, o expurgo diário só sabia cortar
-- tudo num prazo fixo, e o prazo fixo de quinze minutos zerava todo dia o
-- contador DIÁRIO de avisos (revisão de segurança de 7a65e93, L1).
alter table public.charge_slots
  add column if not exists window_seconds integer not null default 900
  check (window_seconds between 60 and 86400);

alter table public.charge_slots enable row level security;
revoke all on public.charge_slots from anon, authenticated;

create or replace function public.claim_slots(
  p_keys text[],
  p_limits integer[],
  p_window_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ordenadas text[];
  v_counts integer[] := '{}';
  v_n integer;
  v_claim uuid;
  i integer;
begin
  if p_keys is null or p_limits is null
     or coalesce(array_length(p_keys, 1), 0) = 0
     or array_length(p_keys, 1) <> coalesce(array_length(p_limits, 1), -1)
     or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 86400
     or (select count(distinct k) from unnest(p_keys) k) <> array_length(p_keys, 1)
     -- LIMITE NULO É GUARDA QUE NUNCA DISPARA: `v_n >= null` é null, o `if` passa
     -- reto e a chave concede sem fim. Revisão de segurança de 2026-09-15 (LOW-1).
     or array_position(p_limits, null) is not null
     or not (0 < all(p_limits)) then
    raise exception 'claim_slots: argumentos inválidos'
      using errcode = '22023';
  end if;

  -- Trava na ordem das chaves ORDENADAS: duas reivindicações com as mesmas
  -- chaves em ordem diferente não se travam uma à outra.
  select array_agg(k order by k) into v_ordenadas from unnest(p_keys) k;
  for i in 1 .. array_length(v_ordenadas, 1) loop
    perform pg_advisory_xact_lock(hashtextextended('claim_slots:' || v_ordenadas[i], 0));
  end loop;

  -- Faxina: da própria chave, pela janela; e um lote limitado de linhas com
  -- mais de um dia, de qualquer chave — a tabela não cresce sem um cron.
  delete from charge_slots
   where slot_key = any(p_keys)
     and created_at < now() - make_interval(secs => p_window_seconds);
  -- `skip locked`, e não é detalhe: sem ele esta faxina fechava CICLO de trava.
  -- A reivindicação A (`venue:X`) segura as linhas velhas de X na faxina da
  -- própria chave e espera aqui pelas de Y; a B (`venue:Y`) segura as de Y e
  -- espera pelas de X. Medido pela revisão de segurança de 2026-09-15 com uma
  -- pilha de linhas de dois dias: 364 `deadlock detected`, cada vítima um 500
  -- numa recarga, e a pilha sem sair do lugar. Linha travada por outra
  -- reivindicação é pulada: quem a segura já está cuidando dela, e o expurgo
  -- diário varre o resto.
  delete from charge_slots
   where ctid in (
     select ctid from charge_slots
      where created_at < now() - interval '1 day'
      limit 500
      for update skip locked
   );

  for i in 1 .. array_length(p_keys, 1) loop
    select count(*) into v_n
      from charge_slots
     where slot_key = p_keys[i]
       and created_at >= now() - make_interval(secs => p_window_seconds);
    v_counts := v_counts || v_n;
    if v_n >= p_limits[i] then
      return jsonb_build_object('claim_id', null, 'full_index', i - 1, 'counts', to_jsonb(v_counts));
    end if;
  end loop;

  v_claim := gen_random_uuid();
  insert into charge_slots (claim_id, slot_key, window_seconds)
    select v_claim, k, p_window_seconds from unnest(p_keys) k;
  return jsonb_build_object('claim_id', v_claim, 'full_index', null, 'counts', to_jsonb(v_counts));
end;
$$;

revoke all on function public.claim_slots(text[], integer[], integer) from public, anon, authenticated;

comment on function public.claim_slots(text[], integer[], integer) is
  'Conta e reserva vagas de cobrança numa instrução só, sob trava consultiva, janela deslizante. Ver 0033.';

-- Devolve as vagas de uma reivindicação cujo PSP NUNCA foi chamado — o pedido
-- foi recusado depois da vaga e antes do adquirente. Depois de chamado, a vaga
-- FICA, dê certo o resto ou não: o adquirente pode ter criado algo, e uma
-- devolução que o CHAMADOR provoca (um rótulo que o Postgres recusa guardar)
-- desligava o teto. Este texto dizia o contrário — que a vaga voltava num
-- timeout do PSP ou numa falha do registro — e é a cópia que fica no catálogo.
-- (Segurança HIGH-1 de 2ed7ca4; texto: compliance LOW-1 de 7a65e93.)
create or replace function public.release_slots(p_claim_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  delete from charge_slots where claim_id = p_claim_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.release_slots(uuid) from public, anon, authenticated;

comment on function public.release_slots(uuid) is
  'Devolve as vagas de uma reivindicação cujo PSP nunca foi chamado. Depois de chamado, a vaga fica. Ver 0033.';

-- O EXPURGO DIÁRIO também varre o livro de vagas. Redefinição EXATA da 0032 com
-- uma linha a mais (o `delete from public.charge_slots`), porque a faxina da
-- reivindicação só roda quando alguém reivindica: com o piloto parado, linhas
-- de conta de saldo ficariam pra sempre. Este expurgo roda todo dia e pagina se
-- parar. Mesma assinatura — o `sql-contract` barra troca de assinatura — e as
-- permissões da 0032 seguem valendo no `create or replace`. Revisão de
-- compliance de 2026-09-15 (MEDIUM-3).
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

  -- O LIVRO DE VAGAS DO TETO (0033) também tem prazo, e ele é cumprido AQUI.
  -- A reivindicação só varre o que ela mesma toca — a própria chave, e um lote
  -- limitado de linhas com mais de um dia —, então uma conta FECHADA deixava
  -- as linhas dela até alguém reivindicar de novo, e com o piloto parado elas
  -- ficariam pra sempre. (Compliance de 2ed7ca4, MEDIUM-3.)
  --
  -- PELA JANELA DE CADA LINHA. O corte fixo de um dia fazia a linha de cobrança
  -- viver ~48 h; o de quinze minutos que o substituiu zerava, todo dia no
  -- expurgo, o contador DIÁRIO de avisos — doze linhas de uma hora sumiam e o
  -- décimo terceiro aviso passava (reproduzido pela revisão de segurança de
  -- 7a65e93, L1). Cada linha sabe a própria janela, e sai quando passa dela.
  --
  -- Com `skip locked` porque sem ele este DELETE disputava linhas com a faxina
  -- da própria chave de uma reivindicação: se o Postgres escolhesse o expurgo
  -- como vítima do deadlock, o expurgo de dado pessoal DO DIA inteiro voltava
  -- atrás. Linha travada fica pra quem a trava, ou pro dia seguinte.
  --
  -- FORA DAS CONTAGENS do registro — e o motivo não é "não é dado de cliente",
  -- que era o que este texto dizia e o data-map desmente: o id de conta de
  -- saldo nas chaves `account:` é pseudônimo e É dado pessoal. O registro prova
  -- que ESTE delete rodou, porque mora na mesma transação; as colunas dele
  -- contam dado de cliente expurgado por prazo de RETENÇÃO, o número de uma
  -- resposta do art. 18, e somar a ele linhas de controle que vivem minutos
  -- faria esse número mentir. (Compliance LOW-7 de 7a65e93.)
  delete from public.charge_slots
   where ctid in (
     select ctid from public.charge_slots
      where created_at < now() - make_interval(secs => window_seconds)
      for update skip locked
   );

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


-- A IMPRESSÃO DIGITAL DESTA MIGRAÇÃO, pro portão de deploy e pro cron.
--
-- A sonda anterior do `deploy.mjs` pedia um COMPORTAMENTO — `claim_slots` com
-- limite nulo recusado com 22023 — que a versão anterior deste arquivo já
-- tinha. Aplicada a 0033 de 2ed7ca4 sobre a cadeia inteira, a sonda passou e o
-- expurgo instalado ainda cortava em um dia, sem `skip locked` (reproduzido
-- pela revisão de segurança de 7a65e93, M2). Um comportamento escolhido a dedo
-- prova só aquele comportamento. Isto prova o TEXTO: md5 do corpo, do
-- `security definer` e do `search_path` das três funções, e das colunas do
-- livro. Um banco com qualquer outra versão responde outro número.
--
-- O número esperado mora em `api/_lib/store/impressao-0033.js`, e o
-- `sql-teto-vivo` o recalcula no Postgres de verdade: editar este arquivo sem
-- atualizar o número deixa a suíte vermelha, não o deploy verde.
create or replace function public.charge_slots_fingerprint()
returns text
language sql
stable
set search_path = public
as $$
  select md5(
    (select string_agg(p.prosrc || '|' || p.prosecdef::text || '|'
                       || coalesce(array_to_string(p.proconfig, ','), ''),
                       E'\n' order by f.ordem)
       from unnest(array[
              'public.claim_slots(text[],integer[],integer)'::regprocedure,
              'public.release_slots(uuid)'::regprocedure,
              'public.purge_expired_personal_data(integer,integer,integer)'::regprocedure
            ]) with ordinality as f(fn, ordem)
       join pg_catalog.pg_proc p on p.oid = f.fn)
    || E'\n' ||
    (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                       || case when a.attnotnull then ' not null' else '' end,
                       ',' order by a.attnum)
       from pg_catalog.pg_attribute a
      where a.attrelid = 'public.charge_slots'::regclass
        and a.attnum > 0 and not a.attisdropped)
  );
$$;

revoke all on function public.charge_slots_fingerprint() from public, anon, authenticated;

comment on function public.charge_slots_fingerprint() is
  'md5 do texto das funções do teto e das colunas do livro — o portão de deploy e o cron comparam com api/_lib/store/impressao-0033.js. Ver 0033.';
