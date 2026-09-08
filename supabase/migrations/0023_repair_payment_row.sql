-- 0023 — reparar a LINHA de pagamento sob condicao, nunca as cegas.
--
-- A reparacao (`repairRowFromLedger`) roda em todo caminho de `duplicate`, que
-- e exatamente quando ha DUAS entregas do mesmo webhook em voo. Ela lia a
-- linha, reduzia o razao, decidia o status e escrevia — read-then-write, sem
-- condicao. O intercalamento perde escrita:
--
--   entrega A (reentrega de `charge.paid`): le `refunded = 0` → decide `confirmado`
--   entrega B (`charge.refunded` total):    grava `devolvido`, `refunded 10000/1000`
--   entrega A grava por cima:               `confirmado`, `refunded 0`
--
-- O painel volta a contar como faturamento — e a gorjeta como base da folha
-- (Lei 13.419) — um pagamento que foi devolvido por inteiro. O
-- `refund_mismatch` da conciliacao pega no dia seguinte, mas o numero errado e
-- o que o dono ve e leva pra folha nesse meio tempo.
--
-- Inegociavel #7: claim condicional vai em RPC com o erro CONFERIDO. A
-- condicao aqui e "a linha ainda esta como eu li" — versao otimista sobre os
-- campos que a reparacao decide. Se mudou, nao escreve e diz que nao escreveu.
--
-- Achado pela revisao de seguranca de 2026-09-08.

create or replace function public.repair_payment_row(
  p_txid                     text,
  p_expected_status          text,
  p_expected_refunded_amount integer,
  p_expected_refunded_tip    integer,
  p_status                   text,
  p_confirmed_amount         integer,
  p_confirmed_tip            integer,
  p_refunded_amount          integer,
  p_refunded_tip             integer,
  p_confirmed_at             timestamptz default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  update payments
     set status                 = p_status,
         confirmed_amount_cents = p_confirmed_amount,
         confirmed_tip_cents    = p_confirmed_tip,
         refunded_amount_cents  = p_refunded_amount,
         refunded_tip_cents     = p_refunded_tip,
         -- a data so entra se estiver faltando: reescrever move o faturamento
         -- de dia sozinho, e a serie semanal agrupa por ela.
         confirmed_at           = coalesce(confirmed_at, p_confirmed_at)
   where txid = p_txid
     -- A LINHA TEM QUE ESTAR COMO EU LI. Se outra entrega mexeu nela entre a
     -- leitura e agora, ela sabe mais do que eu: nao escrevo.
     and status = p_expected_status
     and coalesce(refunded_amount_cents, 0) = coalesce(p_expected_refunded_amount, 0)
     and coalesce(refunded_tip_cents, 0)    = coalesce(p_expected_refunded_tip, 0)
  returning txid into v_id;

  return v_id is not null;
end;
$$;

revoke all on function public.repair_payment_row(text, text, integer, integer, text, integer, integer, integer, integer, timestamptz) from public, anon, authenticated;

comment on function public.repair_payment_row is
  'Reprojeta uma linha de payments a partir do razao, SO se ela ainda estiver no estado lido. Ver 0023.';
