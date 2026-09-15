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
-- O QUE ISTO NÃO GUARDA: dado pessoal. As chaves são `check:<uuid>`,
-- `account:<uuid>` e `venue:<uuid>` — nenhum IP, nenhum telefone, nenhum nome.
-- O id de conta de saldo é pseudônimo; a faxina embutida o apaga em até um dia.

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
     or (select count(distinct k) from unnest(p_keys) k) <> array_length(p_keys, 1) then
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
  delete from charge_slots
   where ctid in (
     select ctid from charge_slots
      where created_at < now() - interval '1 day'
      limit 500
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
  insert into charge_slots (claim_id, slot_key)
    select v_claim, k from unnest(p_keys) k;
  return jsonb_build_object('claim_id', v_claim, 'full_index', null, 'counts', to_jsonb(v_counts));
end;
$$;

revoke all on function public.claim_slots(text[], integer[], integer) from public, anon, authenticated;

comment on function public.claim_slots(text[], integer[], integer) is
  'Conta e reserva vagas de cobrança numa instrução só, sob trava consultiva, janela deslizante. Ver 0033.';

-- Devolve a vaga de uma cobrança que o PSP NUNCA criou. Uma vaga só volta
-- quando o adquirente não tem nada: se a cobrança existe lá, a vaga fica,
-- porque um BR Code vivo é exatamente o que o teto conta.
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
  'Devolve as vagas de uma reivindicação cuja cobrança o PSP não criou. Ver 0033.';
