-- House Accounts hardening — fixes from the 2026-07-19 adversarial review.
--
-- 1. append_house_payment_guarded: the check-side append for credit redeems,
--    validated INSIDE the per-check advisory lock (salt 42). Two concurrent
--    redeems on one check could both pass the app-side remaining check and
--    overpay the check with prepaid credit — invisible to reconciliation
--    (review finding #6, HIGH). Unlike Pix (money arrived; overpay is
--    flagged + refundable), credit overpay must be REFUSED and compensated.
-- 2. house_redeem_reverse: the compensation — puts the exact REDEEMED
--    breakdown back (principal + lots), idempotent by txid.
-- 3. house_redeem v2: idempotent by txid (client idempotencyKey → same txid
--    on retry must not double-debit; review finding #10).
-- 4. house_confirm_load v2: bonus expiry snapped to END OF DAY
--    America/Sao_Paulo so the mandated "expira em DD/MM/AAAA" copy never
--    overstates validity (review finding #16). BRT is UTC-3 year-round
--    (no DST since 2019).

-- 1. Guarded check append for house redeems ---------------------------------
create or replace function public.append_house_payment_guarded(
  p_check_id uuid, p_txid text, p_amount_cents bigint
) returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_seq integer;
  v_total bigint;
  v_paid bigint;
  v_refunded bigint;
  v_existing integer;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_check_id::text, 42));

  -- at-least-once safety: same txid already confirmed → return that seq
  select seq into v_existing
    from check_events
   where check_id = p_check_id and type = 'PAYMENT_CONFIRMED'
     and payload->>'txid' = p_txid
   limit 1;
  if found then
    return v_existing;
  end if;

  if exists (select 1 from check_events where check_id = p_check_id and type = 'CLOSED') then
    raise exception 'conta fechada';
  end if;

  select (payload->>'totalCents')::bigint into v_total
    from check_events
   where check_id = p_check_id and type in ('OPENED', 'ADJUSTED')
   order by seq desc limit 1;
  if v_total is null then
    raise exception 'conta sem eventos';
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

  if (v_paid - v_refunded) + p_amount_cents > v_total then
    raise exception 'excede o que falta pagar';
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
revoke all on function public.append_house_payment_guarded(uuid, text, bigint) from public, anon, authenticated;

-- 2. Reversal (compensation for a refused check append) ---------------------
create or replace function public.house_redeem_reverse(
  p_account_id uuid, p_txid text, p_now text
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_orig jsonb;
  v_seq integer;
  u record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 43));

  select payload into v_orig
    from house_account_events
   where account_id = p_account_id and type = 'REDEEMED'
     and payload->>'txid' = p_txid
   limit 1;
  if v_orig is null then
    raise exception 'unknown redeem txid %', p_txid;
  end if;
  if exists (
    select 1 from house_account_events
     where account_id = p_account_id and type = 'REDEEM_REVERSED'
       and payload->>'txid' = p_txid
  ) then
    return jsonb_build_object('duplicate', true);
  end if;

  update house_accounts
     set principal_cents = principal_cents + (v_orig->>'principalCents')::bigint
   where id = p_account_id;
  for u in select * from jsonb_to_recordset(coalesce(v_orig->'lots', '[]'::jsonb))
             as x(seq integer, "useCents" bigint)
  loop
    update house_bonus_lots
       set remaining_cents = remaining_cents + u."useCents"
     where account_id = p_account_id and event_seq = u.seq;
  end loop;

  select coalesce(max(seq), 0) + 1 into v_seq
    from house_account_events where account_id = p_account_id;
  insert into house_account_events (account_id, seq, type, payload)
    values (p_account_id, v_seq, 'REDEEM_REVERSED', jsonb_build_object(
      'txid', p_txid, 'at', p_now, 'reason', 'check_append_refused'
    ));
  return jsonb_build_object('duplicate', false, 'seq', v_seq);
end;
$$;
revoke all on function public.house_redeem_reverse(uuid, text, text) from public, anon, authenticated;

-- 3. house_redeem v2: idempotent by txid ------------------------------------
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
    raise exception 'invalid amount';
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
    raise exception 'unknown house account %', p_account_id;
  end if;

  select coalesce(sum(remaining_cents), 0) into v_bonus_avail
    from house_bonus_lots
   where account_id = p_account_id and remaining_cents > 0 and expires_at > v_now;

  if v_principal + v_bonus_avail < p_amount_cents then
    raise exception 'saldo insuficiente';
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

-- 4. house_confirm_load v2: end-of-day São Paulo expiry ---------------------
create or replace function public.house_confirm_load(
  p_txid text, p_confirmed_at text
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_load house_loads%rowtype;
  v_seq integer;
  v_expires timestamptz;
  v_payload jsonb;
begin
  select * into v_load from house_loads where txid = p_txid;
  if not found then
    raise exception 'unknown house load %', p_txid;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_load.account_id::text, 43));

  if exists (
    select 1 from house_account_events
     where account_id = v_load.account_id
       and type = 'LOAD_CONFIRMED'
       and payload->>'txid' = p_txid
  ) then
    return jsonb_build_object('duplicate', true, 'accountId', v_load.account_id, 'seq', null);
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from house_account_events where account_id = v_load.account_id;

  -- Last valid instant = 23:59:59.999 São Paulo on (confirm date + validity
  -- days), so the displayed calendar date is exactly right for the customer.
  v_expires := (((p_confirmed_at::timestamptz at time zone 'America/Sao_Paulo')::date
                 + v_load.validity_days + 1)::timestamp at time zone 'America/Sao_Paulo')
               - interval '1 millisecond';

  v_payload := jsonb_build_object(
    'txid', p_txid, 'at', p_confirmed_at,
    'principalCents', v_load.amount_cents,
    'bonusCents', v_load.bonus_cents
  );
  if v_load.bonus_cents > 0 then
    v_payload := v_payload || jsonb_build_object('bonusExpiresAt', house_iso(v_expires));
  end if;

  insert into house_account_events (account_id, seq, type, payload)
    values (v_load.account_id, v_seq, 'LOAD_CONFIRMED', v_payload);
  update house_accounts
     set principal_cents = principal_cents + v_load.amount_cents
   where id = v_load.account_id;
  if v_load.bonus_cents > 0 then
    insert into house_bonus_lots (account_id, event_seq, granted_cents, remaining_cents, expires_at)
      values (v_load.account_id, v_seq, v_load.bonus_cents, v_load.bonus_cents, v_expires);
  end if;
  update house_loads
     set status = 'confirmado', confirmed_at = p_confirmed_at::timestamptz
   where txid = p_txid;

  return jsonb_build_object('duplicate', false, 'accountId', v_load.account_id, 'seq', v_seq);
end;
$$;

-- 5. Event-type check now includes REDEEM_REVERSED --------------------------
alter table public.house_account_events drop constraint if exists house_account_events_type_check;
alter table public.house_account_events add constraint house_account_events_type_check
  check (type in ('OPENED', 'LOAD_CONFIRMED', 'REDEEMED', 'REDEEM_REVERSED', 'PRINCIPAL_REFUNDED'));
