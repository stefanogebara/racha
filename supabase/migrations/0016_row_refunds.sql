-- Quanto de cada pagamento já foi ESTORNADO, na própria linha.
--
-- Regressão que EU introduzi ao consertar o estorno parcial, achada pela
-- revisão de compliance de 2026-09-08.
--
-- O estorno parcial passou a funcionar no razão — o rateio entre consumo e
-- gorjeta ficou proporcional, o acumulado virou delta. Mas o status da linha é
-- tri-estado (`pendente`/`confirmado`/`devolvido`) e não sabe dizer
-- "parcialmente estornado". Marcar `devolvido` num estorno de R$ 5,00 sobre
-- R$ 33,90 fazia três coisas erradas ao mesmo tempo:
--
--  1. `status_lag` ALTO em toda cobrança parcialmente estornada, pra sempre —
--     porque o log diz "confirmado com estorno parcial" e a linha diz
--     "devolvido".
--  2. A linha saía da soma de `rowConfirmedCents`, então a conciliação via o
--     pagamento INTEIRO sumir de um lado e continuar do outro:
--     `ledger_drift` CRÍTICO, pra sempre, sem nada faltando de verdade. Um
--     alerta que dispara em comportamento correto está morto em duas semanas —
--     o mesmo modo de falha que eu tinha acabado de fechar na disputa que
--     nunca encerrava (inegociável #8).
--  3. O painel e a série semanal filtram por `status='confirmado'`, então o
--     pagamento sumia inteiro do faturamento E DA GORJETA. Num estorno de
--     R$ 5,00 a linha de gorjeta caía 308¢ em vez dos 45¢ que o rateio
--     proporcional tinha calculado — desfazendo, no relatório, a correção que
--     eu tinha feito no razão (Lei 13.419/2017 + STJ Tema 1102).
--
-- A correção: a linha passa a dizer QUANTO foi estornado, e o status só vira
-- `devolvido` quando o estorno é total. Quem soma dinheiro soma líquido.

alter table public.payments
  add column if not exists refunded_amount_cents integer not null default 0,
  add column if not exists refunded_tip_cents integer not null default 0;

comment on column public.payments.refunded_amount_cents is
  'Consumo já estornado nesta cobrança (acumulado). O status só vira devolvido quando o estorno é TOTAL — tri-estado não sabe dizer "parcial".';
comment on column public.payments.refunded_tip_cents is
  'Gorjeta já estornada. O painel soma líquido: confirmado menos estornado. Nunca dropar a linha inteira de um estorno parcial.';
