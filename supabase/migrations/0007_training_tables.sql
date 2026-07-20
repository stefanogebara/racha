-- Mesa de treino (workshop pré-turno do playbook de onboarding):
-- o garçom escaneia e paga uma conta de mentira SEM sujar os números da
-- casa. O flag exclui a mesa das métricas de ativação e dos totais do
-- painel; o fluxo de pagamento continua idêntico (a experiência é o
-- treino — método sunday: "a experiência dissolve o medo").
alter table public.venue_tables
  add column if not exists training boolean not null default false;
