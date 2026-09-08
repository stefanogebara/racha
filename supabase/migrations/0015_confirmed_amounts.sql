-- Os valores CONFIRMADOS, ao lado dos registrados.
--
-- Achado pela revisão de compliance de 2026-09-08, e a correção óbvia era a
-- errada.
--
-- O problema: `registerCharge` grava o valor PEDIDO e `recordPayment` só mexe
-- em status/payload/confirmed_at — nunca nos valores. O painel do dono soma
-- `amount_cents` e `tip_cents` dessas linhas, então numa divergência (pedimos
-- 3390, o PSP confirmou 2450) ele mostra 3390 de faturamento e a gorjeta
-- PEDIDA. A linha rotulada "gorjeta" é a base da folha (Lei 13.419/2017 + STJ
-- Tema 1102), e era o número errado — enquanto a mesma tela, no card da conta,
-- mostrava o valor confirmado. Duas verdades sobre o mesmo dinheiro, e
-- `today.anomalies` conta só anomalias do log, então a tela lia 0.
--
-- A correção óbvia — fazer o `recordPayment` sobrescrever os valores — DESTRÓI
-- o detector: é justamente comparar a linha (pedido) com o log (confirmado)
-- que produz `amount_mismatch` e `ledger_drift`. Sobrescrever fazia os dois
-- registros concordarem sempre e a divergência virar invisível.
--
-- Então: colunas SEPARADAS. O pedido fica onde está, o confirmado entra ao
-- lado, o painel soma o confirmado e a conciliação continua comparando pedido
-- contra log. Nulo é normal: pagamento pendente, ou confirmado antes desta
-- migração — o painel cai no valor registrado nesse caso, que é o que aquele
-- histórico quer dizer.

alter table public.payments
  add column if not exists confirmed_amount_cents integer,
  add column if not exists confirmed_tip_cents integer;

comment on column public.payments.confirmed_amount_cents is
  'Consumo que o PSP realmente confirmou. NULL = pendente ou anterior à coluna. O painel soma esta; a conciliação compara amount_cents (pedido) contra o log.';
comment on column public.payments.confirmed_tip_cents is
  'Gorjeta que o PSP realmente confirmou. É a base da folha (Lei 13.419) — nunca somar tip_cents pra isso.';
