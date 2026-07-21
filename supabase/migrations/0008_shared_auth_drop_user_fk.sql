-- Login compartilhado com o Seatable: a identidade (auth.users) passa a viver no
-- projeto Supabase do Seatable, enquanto os DADOS do Racha (venues/checks/
-- venue_members) ficam no projeto do Racha. Com isso, venue_members.user_id
-- referencia um usuário de OUTRO projeto — o FK cross-project é impossível, então
-- soltamos a constraint. A coluna continua `uuid not null` (o id do usuário do
-- Seatable); a integridade de "quem é dono" é garantida pela API (requireVenueOwner)
-- + o token verificado contra o GoTrue do Seatable (AUTH_SUPABASE_URL/KEY no router).
-- Greenfield: o Racha ainda não tem base de usuário real (só a conta demo), então
-- não há dado a migrar.
alter table public.venue_members drop constraint if exists venue_members_user_id_fkey;
