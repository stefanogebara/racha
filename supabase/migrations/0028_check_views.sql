-- 0028 — quem ABRIU a conta na mesa. O primeiro degrau do funil, que nao era
-- medido.
--
-- O portao de adocao do CLAUDE.md governa o roteiro: as casas-piloto tem que
-- mostrar >=25% das contas migrando na semana 8, ou o produto para. Sete
-- semanas depois da primeira casa, o banco sabe dizer quantas contas foram
-- ABERTAS (o restaurante digita o total no painel) e quantas foram PAGAS. Nao
-- sabe dizer quantas pessoas viram a tela.
--
-- Sem esse numero, dois mundos opostos produzem exatamente o mesmo relatorio:
--
--   40 pessoas escanearam e 1 pagou   → problema de PRODUTO (a tela perde gente)
--    0 pessoas escanearam             → problema de DISTRIBUICAO (o QR nao esta
--                                        na mesa, o garcom nao fala dele)
--
-- E os dois pedem correcoes opostas. Um portao que nao distingue os dois nao e
-- um portao — e um numero que da pra interpretar do jeito que der na telha.
--
-- Existia telemetria, e ela media outra coisa: `sendBeacon` no cliente so
-- dispara quando a URL traz `?pl=`, o token de prospeccao da Olimpia. Serve pro
-- radar de VENDAS. Um cliente de verdade, na mesa de verdade, abre
-- `/?t=<token>` e nao gera nada.
--
-- LGPD: nao ha dado pessoal aqui. `session_hash` e um id ALEATORIO gerado no
-- proprio navegador (nao e IP, nao e impressao digital de dispositivo), e serve
-- pra nao contar o mesmo telefone duas vezes — o app consulta a conta a cada 4
-- segundos, e contar leitura seria contar polling, nao gente. Base legal:
-- interesse legitimo em medir uso do proprio produto (art. 7º IX), com
-- minimizacao (art. 6º III) por construcao: nao ha o que anonimizar depois se
-- nada identificavel entra.

create table if not exists public.check_views (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  check_id     uuid not null references public.checks(id) on delete cascade,
  venue_id     uuid not null references public.venues(id) on delete cascade,
  table_id     uuid references public.venue_tables(id) on delete set null,
  -- Aleatorio do navegador. Uma abertura por telefone por conta.
  session_hash text not null,
  unique (check_id, session_hash)
);

comment on table public.check_views is
  'Aberturas da conta na mesa: o primeiro degrau do funil de adocao. Sem dado pessoal. Ver 0028.';

create index if not exists check_views_venue_idx on public.check_views (venue_id, at desc);

alter table public.check_views enable row level security;
revoke all on public.check_views from anon, authenticated;
revoke all on sequence public.check_views_id_seq from anon, authenticated;
