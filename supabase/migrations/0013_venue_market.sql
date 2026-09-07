-- O mercado da casa: Brasil ou Espanha.
--
-- Por que uma coluna e não uma inferência: um mercado decide a MOEDA, o trilho
-- de pagamento, se existe linha de serviço na conta e se o pagador precisa dar
-- documento. Deduzir isso do país do CNPJ, do idioma do navegador ou da chave
-- do PSP significa deduzir uma regra de dinheiro — e a revisão #37 já mostrou
-- o que acontece quando a UI adivinha (a demo abriu a folha de cartão real).
-- É um dado do cadastro, então mora no cadastro.
--
-- Default 'br' e NOT NULL: toda casa que existe hoje é brasileira, e uma venue
-- sem mercado seria uma conta sem moeda. O CHECK mantém a coluna honesta —
-- abrir um terceiro mercado é uma migração, não um INSERT com string nova.

alter table public.venues
  add column if not exists market text not null default 'br';

alter table public.venues
  drop constraint if exists venues_market_check;

alter table public.venues
  add constraint venues_market_check check (market in ('br', 'es'));

comment on column public.venues.market is
  'Mercado da casa: br (BRL, Pix, serviço 10% removível, CPF do pagador) ou es (EUR, Bizum, sem linha de serviço, sem documento do pagador). Decide moeda e trilho; ver api/_lib/markets.js.';
