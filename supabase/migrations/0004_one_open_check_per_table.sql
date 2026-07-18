-- One open check per table — as a DB-ENFORCED invariant, not application logic.
--
-- check-service.openCheck guarded this with a check-then-act (read "is there an
-- open check?" then insert), which is a TOCTOU: two concurrent POST /api/checks
-- for the same table (owner double-click / two tabs) both read "none" and both
-- open a check → two live checks on one table → a diner can pay one twin while
-- the other resurfaces and gets paid again (review finding, HIGH). The advisory
-- lock in append_check_event is per-check-id, so the two new checks never
-- contend. The fix is a real uniqueness constraint at the row level.
--
-- Prereq: the constraint keys on checks.status, which v0 left unmaintained. We
-- now maintain the ONE transition that matters — → 'fechada' on a CLOSED event —
-- inside the append RPC (same advisory-locked txn), and backfill existing closed
-- checks. 'aberta'/'parcial'/'paga' all count as "open" (<> 'fechada'), so only
-- the close transition needs maintaining for the invariant.

-- 1. Maintain status on close, transactionally, at the single append gate.
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
  if p_type = 'CLOSED' then
    update checks set status = 'fechada', closed_at = coalesce(closed_at, now())
      where id = p_check_id;
  end if;
  return v_seq;
end;
$$;
revoke all on function public.append_check_event(uuid, text, jsonb) from public, anon, authenticated;

-- 2. Backfill: any check with a CLOSED event but a stale 'aberta' cache.
update public.checks set status = 'fechada', closed_at = coalesce(closed_at, now())
  where status <> 'fechada'
    and id in (select check_id from public.check_events where type = 'CLOSED');

-- 3. The backstop: at most one non-closed check per table. Replaces the old
--    non-unique index. (table_id NULL — orphaned checks after a table delete —
--    are distinct in a unique index, so they don't collide, which is correct.)
drop index if exists public.checks_table_open_idx;
create unique index if not exists checks_one_open_per_table
  on public.checks (table_id) where status <> 'fechada';
