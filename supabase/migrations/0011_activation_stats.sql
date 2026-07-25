-- Radar de ativação: os números do funil de cada restaurante em UMA ida ao banco.
--
-- Por que RPC e não query builder: o radar cruza venues × mesas × contas ×
-- pagamentos. Montar isso no supabase-js viraria N+1 (uma rodada de queries por
-- venue) num cron que roda todo dia. Aqui é um scan só, e a regra de "o que
-- conta como mesa/pagamento de verdade" fica num lugar só.
--
-- Definições que importam:
--   mesas_reais  = ativa E não-treino (mesa de treino não gera dinheiro)
--   pagos        = payments.status 'confirmado' (o único que virou dinheiro)
--   recebedor_ok = tem recipient r*_ E não está num terminal ruim
--                  (refused/suspended/blocked). NULL/intermediário conta como ok:
--                  está em análise, não travado — o cron recipient-status vigia.

create or replace function public.venue_activation_stats()
returns table (
  id uuid,
  name text,
  created_at timestamptz,
  recebedor_ok boolean,
  psp_recipient_status text,
  mesas_reais bigint,
  mesas_total bigint,
  contas bigint,
  pagos_confirmados bigint,
  valor_cents bigint,
  ultimo_pagamento timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.name,
    v.created_at,
    -- coalesce por fora: sem recipient, `NULL ~ regex` daria NULL, e o contrato
    -- desta coluna é booleano de verdade (sem recebedor = false, não "não sei").
    coalesce(
      v.psp_recipient_id ~ '^r[ep]_'
        and coalesce(v.psp_recipient_status, '') not in ('refused', 'suspended', 'blocked'),
      false) as recebedor_ok,
    v.psp_recipient_status,
    count(distinct t.id) filter (where t.active and not coalesce(t.training, false)) as mesas_reais,
    count(distinct t.id) as mesas_total,
    count(distinct c.id) as contas,
    count(distinct p.id) filter (where p.status = 'confirmado') as pagos_confirmados,
    coalesce(sum(p.amount_cents) filter (where p.status = 'confirmado'), 0)::bigint as valor_cents,
    max(p.created_at) filter (where p.status = 'confirmado') as ultimo_pagamento
  from public.venues v
  left join public.venue_tables t on t.venue_id = v.id
  left join public.checks c on c.table_id = t.id
  left join public.payments p on p.check_id = c.id
  group by v.id, v.name, v.created_at, v.psp_recipient_id, v.psp_recipient_status;
$$;

-- Só o service role (cron) chama. O dono não precisa ver o funil dos outros.
revoke all on function public.venue_activation_stats() from public, anon, authenticated;
