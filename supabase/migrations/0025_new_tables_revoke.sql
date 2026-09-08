-- 0025 — as duas tabelas novas ganham o REVOKE que todas as outras tem.
--
-- `payment_repair_log` (0022) e `orphan_money_events` (0024) ligaram RLS e
-- pararam ai. Todas as tabelas anteriores fazem as DUAS coisas — 0001, 0003 e
-- 0005 ligam RLS e revogam `anon`/`authenticated`.
--
-- Hoje nao e explorável: RLS sem policy nega os dois papeis. O que isso muda e
-- o custo do ERRO SEGUINTE: os grants continuam la, e um unico
-- `create policy ... using (true)` — a correcao reflexa de quando uma consulta
-- do dashboard devolve `[]` — expoe as duas tabelas pra chave anonima na hora.
-- E `payment_repair_log` guarda historico de dinheiro.
--
-- Defesa em profundidade: a policy passa a ser a segunda tranca, nao a unica.
-- Achado pela revisao de seguranca de 2026-09-08.

revoke all on public.payment_repair_log from anon, authenticated;
revoke all on public.orphan_money_events from anon, authenticated;
revoke all on sequence public.payment_repair_log_id_seq from anon, authenticated;
revoke all on sequence public.orphan_money_events_id_seq from anon, authenticated;
