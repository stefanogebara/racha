-- 0024 — evento de dinheiro que nao tem conta pra pendurar.
--
-- Um cancelamento parcial, um alerta de repasse ou um chargeback pode chegar
-- com um txid que nao resolve pra nenhuma conta nossa: cobranca de outro
-- ambiente, linha apagada, cobranca do adquirente que nao passou por aqui.
--
-- A rota tratava isso com 503 "pra o PSP reenviar" — e o reenvio NAO TEM PRA
-- ONDE CONVERGIR: nao existe estado que possa mudar. Sem `RACHA_NOTIFY_SECRET`
-- (uma degradacao que o codigo trata como suportada) todo reenvio devolveria
-- 503 ate a Pagar.me desabilitar o endpoint — o que derruba TODA confirmacao
-- de Pix, e nao so este evento. Achado pela revisao de seguranca de
-- 2026-09-08.
--
-- Entao o evento orfao ganha uma casa. Nao e o razao (nao ha conta), e nao e o
-- stderr (some): e uma tabela que a conciliacao diaria pode ler e alguem pode
-- limpar. Inegociavel #8 — um evento de dinheiro nunca desaparece calado.

create table if not exists public.orphan_money_events (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  kind        text        not null,     -- unusable_money_event, account_alert, …
  psp         text,                     -- 'pagarme' | 'stripe'
  event_type  text,                     -- o tipo cru do PSP
  txid        text,
  psp_event_id text unique,             -- reentrega nao duplica a linha
  amount_cents bigint,
  payload     jsonb,                    -- MASCARADO pelo chamador
  resolved_at timestamptz,
  resolved_by text,
  note        text
);

comment on table public.orphan_money_events is
  'Eventos de dinheiro sem conta correspondente. Lidos pela conciliacao; fechados a mao. Ver 0024.';

create index if not exists orphan_money_events_open_idx
  on public.orphan_money_events (at desc) where resolved_at is null;

alter table public.orphan_money_events enable row level security;
-- Sem policy: service-role apenas, como o resto do esquema.
