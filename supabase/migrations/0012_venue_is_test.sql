-- Marca venue interno (sandbox do fundador, teste de amigo) pra ele NÃO contar
-- como cliente nas métricas.
--
-- Por que: em 27/jul/2026 o radar de ativação reportava "3 restaurantes, 1
-- ativo, 2 precisando de ação". A verdade era ZERO clientes reais — Beira Mar
-- é o sandbox do fundador, Kitos Food é um amigo que cadastrou só pra ver
-- como ficou, e Okay abandonou o wizard. Métrica que conta teste como cliente
-- faz o fundador olhar pro lugar errado, e é justamente o radar que decide
-- onde ele gasta o dia.
--
-- O filtro por NOME (ehDemo: /demo|demonstra/) pega os "Bar do Zé [demo ...]",
-- mas não pega um teste com nome de restaurante de verdade. Daí a flag.

alter table public.venues
  add column if not exists is_test boolean not null default false;

comment on column public.venues.is_test is
  'Venue interno (sandbox/teste), não é cliente. Excluído do radar de ativação e das métricas de funil.';
