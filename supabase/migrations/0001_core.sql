-- Racha core schema — v0.
-- Event-sourced checks: check_events is the source of truth; checks carries a
-- derived cache for queries. Service-role only: RLS ENABLED with NO policies on
-- every table (anon/authenticated denied by default; the API uses service role).
-- All money columns are integer centavos (bigint) — no numerics, no floats.

create extension if not exists pgcrypto;

-- Venues (restaurants). CNPJ present because receipts must show it and the
-- PSP subaccount maps to it. psp_recipient_id = the split-settlement target.
create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  cnpj text not null,
  city text,
  pos_provider text not null default 'manual'
    check (pos_provider in ('manual', 'colibri', 'simphony')),
  -- POS credentials deliberately NOT stored here (review finding: plaintext
  -- jsonb). When colibri lands, credentials go in Supabase Vault, referenced
  -- by id only.
  pos_vault_ref text,
  -- PSP subaccount / recipient for splits. Nullable only during onboarding:
  -- the payment API layer MUST refuse to create charges for a venue without
  -- it (funds would settle to the platform account = BACEN Res. 494 custody
  -- territory). Enforced in code + fintech-compliance gate.
  psp_recipient_id text,
  servico_basis_points integer not null default 1000
    check (servico_basis_points between 0 and 3000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.venue_tables (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  label text not null,                 -- "Mesa 12"
  -- Rotatable: a photographed QR must not grant indefinite visibility into
  -- future checks (review finding). Regeneration = update qr_token +
  -- qr_rotated_at; old token dies with the update.
  qr_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  qr_rotated_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (venue_id, label)
);

create table if not exists public.checks (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  table_id uuid references public.venue_tables(id) on delete set null,
  pos_ref text,                        -- POS-side check/comanda id (colibri etc.)
  -- Derived cache (reduce(check_events)); the event log wins on conflict.
  status text not null default 'aberta'
    check (status in ('aberta', 'parcial', 'paga', 'fechada')),
  total_cents bigint not null default 0 check (total_cents >= 0),
  paid_cents bigint not null default 0 check (paid_cents >= 0),
  tip_cents bigint not null default 0 check (tip_cents >= 0),
  overpaid_cents bigint not null default 0 check (overpaid_cents >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists checks_venue_status_idx on public.checks (venue_id, status);
create index if not exists checks_table_open_idx on public.checks (table_id)
  where status <> 'fechada';

-- The event log. seq is per-check, assigned by the append RPC (never by
-- clients); UNIQUE(check_id, seq) makes concurrent appends safe.
create table if not exists public.check_events (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.checks(id) on delete cascade,
  seq integer not null,
  type text not null check (type in ('OPENED', 'ADJUSTED', 'PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'CLOSED')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (check_id, seq)
);

-- Payment intents/results, keyed by PSP txid for webhook idempotency.
-- amount vs tip separated: tips are employee remuneration (Lei 13.419/2017)
-- and feed the payroll report, never the check total.
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.checks(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  txid text not null unique,
  method text not null check (method in ('pix', 'card')),
  amount_cents bigint not null check (amount_cents >= 0),
  tip_cents bigint not null default 0 check (tip_cents >= 0),
  status text not null default 'pendente'
    check (status in ('pendente', 'confirmado', 'expirado', 'devolvido')),
  -- Diner-entered display name, no login. Bounded (review finding: unbounded
  -- attacker-controlled text) and ALWAYS rendered escaped, never as HTML.
  payer_label text check (payer_label is null or char_length(payer_label) between 1 and 60),
  -- MASKED PSP webhook subset — the webhook handler strips payer PII
  -- (CPF, full name, account) BEFORE this insert; storing the raw payload is
  -- an LGPD finding, not a debugging convenience. Full payloads live at the
  -- PSP dashboard when forensics need them.
  psp_payload_masked jsonb,
  -- Payroll/report queries key on confirmed_at (competência), NEVER
  -- created_at (review finding: boundary-of-month tips landed in the wrong
  -- period).
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payments_check_idx on public.payments (check_id);
create index if not exists payments_venue_day_idx on public.payments (venue_id, created_at);

-- Atomic event append. RPC (not PostgREST update+filters — Seatable lesson
-- 2026-07-14), serialized PER CHECK with a transaction-scoped advisory lock
-- (review findings: the old optimistic seq retry (a) let racing lifecycle
-- events both land, poisoning the log, and (b) aborted with a raw
-- unique_violation under 3+ concurrent payers — the product's core scenario).
-- With the lock, concurrent appends for the same check queue up and each gets
-- a clean, gap-free seq; the reducer stays total as defense-in-depth.
create or replace function public.append_check_event(
  p_check_id uuid,
  p_type text,
  p_payload jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_check_id::text, 42));
  select coalesce(max(seq), 0) + 1 into v_seq
    from check_events where check_id = p_check_id;
  insert into check_events (check_id, seq, type, payload)
    values (p_check_id, v_seq, p_type, p_payload);
  return v_seq;
end;
$$;

-- updated_at maintenance (search_path pinned — advisor WARN otherwise)
create or replace function public.touch_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists venues_touch on public.venues;
create trigger venues_touch before update on public.venues
  for each row execute function public.touch_updated_at();
drop trigger if exists checks_touch on public.checks;
create trigger checks_touch before update on public.checks
  for each row execute function public.touch_updated_at();
drop trigger if exists payments_touch on public.payments;
create trigger payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();

-- Service-role only: RLS on, zero policies.
alter table public.venues enable row level security;
alter table public.venue_tables enable row level security;
alter table public.checks enable row level security;
alter table public.check_events enable row level security;
alter table public.payments enable row level security;

revoke all on public.venues, public.venue_tables, public.checks,
  public.check_events, public.payments from anon, authenticated;
revoke all on function public.append_check_event(uuid, text, jsonb) from public, anon, authenticated;
