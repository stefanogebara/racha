-- 0040 — A CARTEIRA DA CASA RECUSA COM CÓDIGO, não com frase.
--
-- As RPCs da carteira levantavam o erro genérico (P0001) e o store decidia
-- pelo TEXTO da mensagem (/saldo insuficiente/, /excede o que falta/…). Uma
-- tradução, um "Saldo" com maiúscula ou um driver que reformate a mensagem e
-- a recusa de dinheiro vira 500 — e a frase em português ia crua pra tela do
-- cliente. Inegociável #7: decisão por CÓDIGO, CHECADO (achado do censo de RPC
-- de 2026-09-25).
--
-- REDEFINE A PARTIR DA ÚLTIMA VERSÃO DE CADA UMA — `house_redeem` (0006),
-- `house_refund_principal` (0005), `append_house_payment_guarded` (0019) — e
-- muda SÓ as linhas de `raise`: cada uma ganha `using errcode`. O censo "a
-- ÚLTIMA definição guarda tudo que ela já teve" confere o resto. Mesmas
-- assinaturas: `create or replace` troca, não cria sobrecarga.
--
-- Códigos (classe RH = Racha, carteira da casa):
--   RH001 saldo insuficiente · RH002 conta fechada · RH003 excede o que falta
--   RH004 conta sem eventos  · RH005 conta da carteira desconhecida
--   22023 valor inválido (invalid_parameter_value, como no resto do razão)

create or replace function public.house_redeem(
  p_account_id uuid, p_check_id uuid, p_txid text,
  p_amount_cents bigint, p_now text
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_now timestamptz := p_now::timestamptz;
  v_principal bigint;
  v_bonus_avail bigint;
  v_remaining bigint := p_amount_cents;
  v_bonus_used bigint := 0;
  v_principal_used bigint;
  v_lots jsonb := '[]'::jsonb;
  v_use bigint;
  v_seq integer;
  v_prior jsonb;
  r record;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 43));

  -- idempotency: a retried redeem with the same txid returns the prior debit
  select payload into v_prior
    from house_account_events
   where account_id = p_account_id and type = 'REDEEMED'
     and payload->>'txid' = p_txid
   limit 1;
  if v_prior is not null then
    return jsonb_build_object(
      'duplicate', true, 'seq', null,
      'principalUsedCents', (v_prior->>'principalCents')::bigint,
      'bonusUsedCents', (v_prior->>'bonusCents')::bigint
    );
  end if;

  select principal_cents into v_principal
    from house_accounts where id = p_account_id and active;
  if not found then
    raise exception 'unknown house account %', p_account_id using errcode = 'RH005';
  end if;

  select coalesce(sum(remaining_cents), 0) into v_bonus_avail
    from house_bonus_lots
   where account_id = p_account_id and remaining_cents > 0 and expires_at > v_now;

  if v_principal + v_bonus_avail < p_amount_cents then
    raise exception 'saldo insuficiente' using errcode = 'RH001';
  end if;

  for r in
    select id, event_seq, remaining_cents
      from house_bonus_lots
     where account_id = p_account_id and remaining_cents > 0 and expires_at > v_now
     order by expires_at asc, event_seq asc
  loop
    exit when v_remaining = 0;
    v_use := least(r.remaining_cents, v_remaining);
    update house_bonus_lots set remaining_cents = remaining_cents - v_use where id = r.id;
    v_lots := v_lots || jsonb_build_object('seq', r.event_seq, 'useCents', v_use);
    v_bonus_used := v_bonus_used + v_use;
    v_remaining := v_remaining - v_use;
  end loop;

  v_principal_used := v_remaining;
  if v_principal_used > 0 then
    update house_accounts
       set principal_cents = principal_cents - v_principal_used
     where id = p_account_id;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from house_account_events where account_id = p_account_id;
  insert into house_account_events (account_id, seq, type, payload)
    values (p_account_id, v_seq, 'REDEEMED', jsonb_build_object(
      'txid', p_txid, 'checkId', p_check_id::text, 'at', p_now,
      'principalCents', v_principal_used, 'bonusCents', v_bonus_used,
      'lots', v_lots
    ));

  return jsonb_build_object(
    'duplicate', false, 'seq', v_seq,
    'principalUsedCents', v_principal_used, 'bonusUsedCents', v_bonus_used
  );
end;
$$;

create or replace function public.house_refund_principal(
  p_account_id uuid, p_amount_cents bigint, p_now text
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_principal bigint;
  v_seq integer;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 43));

  select principal_cents into v_principal
    from house_accounts where id = p_account_id;
  if not found then
    raise exception 'unknown house account %', p_account_id using errcode = 'RH005';
  end if;
  if v_principal < p_amount_cents then
    raise exception 'saldo insuficiente' using errcode = 'RH001';
  end if;

  update house_accounts
     set principal_cents = principal_cents - p_amount_cents
   where id = p_account_id;

  select coalesce(max(seq), 0) + 1 into v_seq
    from house_account_events where account_id = p_account_id;
  insert into house_account_events (account_id, seq, type, payload)
    values (p_account_id, v_seq, 'PRINCIPAL_REFUNDED', jsonb_build_object(
      'amountCents', p_amount_cents, 'at', p_now, 'settlement', 'manual'
    ));

  return jsonb_build_object('seq', v_seq, 'principalCents', v_principal - p_amount_cents);
end;
$$;

create or replace function public.append_house_payment_guarded(
  p_check_id uuid, p_txid text, p_amount_cents bigint
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
  v_existing integer;
  v_total bigint;
  v_paid bigint;
  v_refunded bigint;
  v_reversed bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_check_id::text, 42));

  select seq into v_existing
    from check_events
   where check_id = p_check_id and type = 'PAYMENT_CONFIRMED'
     and payload->>'txid' = p_txid
   limit 1;
  if found then
    return v_existing;
  end if;

  if exists (select 1 from check_events where check_id = p_check_id and type = 'CLOSED') then
    raise exception 'conta fechada' using errcode = 'RH002';
  end if;

  select (payload->>'totalCents')::bigint into v_total
    from check_events
   where check_id = p_check_id and type in ('OPENED', 'ADJUSTED')
   order by seq desc limit 1;
  if v_total is null then
    raise exception 'conta sem eventos' using errcode = 'RH004';
  end if;

  -- paid: first occurrence per txid (mirrors the JS reducer's idempotency)
  select coalesce(sum((e.payload->>'amountCents')::bigint), 0) into v_paid
    from (
      select distinct on (payload->>'txid') payload
        from check_events
       where check_id = p_check_id and type = 'PAYMENT_CONFIRMED'
       order by payload->>'txid', seq
    ) e;
  select coalesce(sum((payload->>'amountCents')::bigint), 0) into v_refunded
    from check_events
   where check_id = p_check_id and type = 'PAYMENT_REFUNDED';
  -- O estorno DESFEITO: o dinheiro voltou pro restaurante, então ele não pode
  -- continuar descontado do que foi pago.
  select coalesce(sum((payload->>'amountCents')::bigint), 0) into v_reversed
    from check_events
   where check_id = p_check_id and type = 'PAYMENT_REFUND_REVERSED';

  if (v_paid - greatest(v_refunded - v_reversed, 0)) + p_amount_cents > v_total then
    raise exception 'excede o que falta pagar' using errcode = 'RH003';
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from check_events where check_id = p_check_id;
  insert into check_events (check_id, seq, type, payload)
    values (p_check_id, v_seq, 'PAYMENT_CONFIRMED', jsonb_build_object(
      'txid', p_txid, 'amountCents', p_amount_cents, 'tipCents', 0,
      'method', 'house_account'
    ));
  return v_seq;
end;
$$;

notify pgrst, 'reload schema';
