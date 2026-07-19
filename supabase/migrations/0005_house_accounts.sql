-- House Accounts (saldo da casa) — v1.
-- Prepaid per-venue credit: principal (never expires, refundable) + bonus
-- lots (expire; 30-day legal floor). The append-only event ledger is the
-- audit source of truth; principal_cents + house_bonus_lots are the
-- OPERATIONAL balances, maintained ONLY inside the locked RPCs below (single
-- writer path — this is not the unmaintained-cache pattern; reconciliation
-- cross-checks columns vs reduced ledger).
-- Money = integer centavos (bigint). Service-role only: RLS on, no policies.

-- Venue config -----------------------------------------------------------
alter table public.venues
  add column if not exists house_enabled boolean not null default false,
  add column if not exists house_bonus_bp integer not null default 1000
    check (house_bonus_bp between 0 and 5000),
  add column if not exists house_validity_days integer not null default 90
    check (house_validity_days between 30 and 365),
  add column if not exists house_min_load_cents bigint not null default 2000
    check (house_min_load_cents >= 100),
  add column if not exists house_max_load_cents bigint not null default 50000
    check (house_max_load_cents >= 100);

-- Redeems land in payments like any other payment ------------------------
alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check
  check (method in ('pix', 'card', 'house_account'));

-- Accounts ----------------------------------------------------------------
create table if not exists public.house_accounts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  -- Normalized digits. One account per phone per venue; the bearer
  -- credential is account_token (the phone must NEVER unlock the balance).
  phone text not null check (phone ~ '^[0-9]{10,13}$'),
  name text not null check (char_length(name) between 1 and 60),
  account_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  -- Operational principal balance — written ONLY by the house_* RPCs.
  principal_cents bigint not null default 0 check (principal_cents >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, phone)
);

create table if not exists public.house_account_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.house_accounts(id) on delete cascade,
  seq integer not null,
  type text not null check (type in ('OPENED', 'LOAD_CONFIRMED', 'REDEEMED', 'PRINCIPAL_REFUNDED')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (account_id, seq)
);

-- Bonus lots: one per bonus-granting load, FIFO-consumed by earliest expiry.
create table if not exists public.house_bonus_lots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.house_accounts(id) on delete cascade,
  event_seq integer not null,          -- seq of the granting LOAD_CONFIRMED
  granted_cents bigint not null check (granted_cents > 0),
  remaining_cents bigint not null check (remaining_cents >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (account_id, event_seq)
);
create index if not exists house_lots_spend_idx
  on public.house_bonus_lots (account_id, expires_at)
  where remaining_cents > 0;

-- Load charges (bonus + validity SNAPSHOTTED at charge time — a config
-- change between charge and webhook never changes what was promised).
create table if not exists public.house_loads (
  txid text primary key,
  account_id uuid not null references public.house_accounts(id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  bonus_cents bigint not null default 0 check (bonus_cents >= 0),
  validity_days integer not null check (validity_days between 1 and 3650),
  status text not null default 'pendente' check (status in ('pendente', 'confirmado')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index if not exists house_loads_account_idx on public.house_loads (account_id);

drop trigger if exists house_accounts_touch on public.house_accounts;
create trigger house_accounts_touch before update on public.house_accounts
  for each row execute function public.touch_updated_at();

-- Helpers -----------------------------------------------------------------
-- ISO-8601 UTC serializer so SQL-written payloads parse identically to the
-- JS-written ones (Date.parse both ways).
create or replace function public.house_iso(ts timestamptz)
returns text language sql immutable
set search_path = public
as $$ select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Atomic account creation: row + OPENED event in one transaction.
create or replace function public.house_open_account(
  p_venue_id uuid, p_phone text, p_name text
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row house_accounts%rowtype;
begin
  insert into house_accounts (venue_id, phone, name)
    values (p_venue_id, p_phone, p_name)
    returning * into v_row;
  insert into house_account_events (account_id, seq, type, payload)
    values (v_row.id, 1, 'OPENED', '{}'::jsonb);
  return jsonb_build_object(
    'id', v_row.id, 'venueId', v_row.venue_id, 'phone', v_row.phone,
    'name', v_row.name, 'accountToken', v_row.account_token,
    'createdAt', house_iso(v_row.created_at)
  );
end;
$$;

-- Confirm a load: idempotent by txid; credits principal + creates the bonus
-- lot; serialized per account (advisory lock, salt 43 ≠ checks' 42).
create or replace function public.house_confirm_load(
  p_txid text, p_confirmed_at text
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_load house_loads%rowtype;
  v_seq integer;
  v_expires_iso text;
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

  v_expires_iso := house_iso(p_confirmed_at::timestamptz
                             + make_interval(days => v_load.validity_days));
  v_payload := jsonb_build_object(
    'txid', p_txid, 'at', p_confirmed_at,
    'principalCents', v_load.amount_cents,
    'bonusCents', v_load.bonus_cents
  );
  if v_load.bonus_cents > 0 then
    v_payload := v_payload || jsonb_build_object('bonusExpiresAt', v_expires_iso);
  end if;

  insert into house_account_events (account_id, seq, type, payload)
    values (v_load.account_id, v_seq, 'LOAD_CONFIRMED', v_payload);
  update house_accounts
     set principal_cents = principal_cents + v_load.amount_cents
   where id = v_load.account_id;
  if v_load.bonus_cents > 0 then
    insert into house_bonus_lots (account_id, event_seq, granted_cents, remaining_cents, expires_at)
      values (v_load.account_id, v_seq, v_load.bonus_cents, v_load.bonus_cents,
              p_confirmed_at::timestamptz + make_interval(days => v_load.validity_days));
  end if;
  update house_loads
     set status = 'confirmado', confirmed_at = p_confirmed_at::timestamptz
   where txid = p_txid;

  return jsonb_build_object('duplicate', false, 'accountId', v_load.account_id, 'seq', v_seq);
end;
$$;

-- Redeem: validate + consume INSIDE the lock (bonus first, FIFO by earliest
-- expiry, then principal). Raises 'saldo insuficiente' — the app maps → 409.
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
  r record;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 43));

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
    'seq', v_seq, 'principalUsedCents', v_principal_used, 'bonusUsedCents', v_bonus_used
  );
end;
$$;

-- Refund principal (registro contábil; settlement is manual in v1).
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
    raise exception 'invalid amount';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 43));

  select principal_cents into v_principal
    from house_accounts where id = p_account_id;
  if not found then
    raise exception 'unknown house account %', p_account_id;
  end if;
  if v_principal < p_amount_cents then
    raise exception 'saldo insuficiente';
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

-- Service-role only ------------------------------------------------------
alter table public.house_accounts enable row level security;
alter table public.house_account_events enable row level security;
alter table public.house_bonus_lots enable row level security;
alter table public.house_loads enable row level security;

revoke all on public.house_accounts, public.house_account_events,
  public.house_bonus_lots, public.house_loads from anon, authenticated;
revoke all on function public.house_open_account(uuid, text, text) from public, anon, authenticated;
revoke all on function public.house_confirm_load(text, text) from public, anon, authenticated;
revoke all on function public.house_redeem(uuid, uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.house_refund_principal(uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.house_iso(timestamptz) from public, anon, authenticated;
