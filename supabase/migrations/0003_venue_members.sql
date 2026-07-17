-- Owner auth: identity lives in Supabase Auth (GoTrue, auth.users); this table
-- is the AUTHORIZATION link — which authenticated user owns which venue. The
-- API verifies a Supabase access token → user, then checks membership here
-- before serving/mutating any restaurant-facing data. Diners never authenticate
-- (the whole product is no-login), so only the owner surfaces are gated.
create table if not exists public.venue_members (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  unique (venue_id, user_id)
);
create index if not exists venue_members_user_idx on public.venue_members (user_id);
create index if not exists venue_members_venue_idx on public.venue_members (venue_id);

-- Service-role only (RLS on, no policies) — the API enforces ownership.
alter table public.venue_members enable row level security;
revoke all on public.venue_members from anon, authenticated;
