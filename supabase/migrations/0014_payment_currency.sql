-- A MOEDA de cada pagamento, gravada na linha — e o mercado da venue congelado
-- depois do primeiro pagamento.
--
-- Achado por duas revisões independentes (compliance e segurança, 2026-09-07),
-- pelo mesmo caminho por dois motivos diferentes.
--
-- O problema: nenhuma linha de dinheiro dizia em que moeda ela foi cobrada. A
-- moeda era DEDUZIDA em tempo de leitura, do `venues.market`. Então virar o
-- market de uma venue — que é o caminho provável de um piloto às pressas, e
-- está escrito assim no `api/_lib/markets.js` — reetiquetava RETROATIVAMENTE o
-- razão inteiro dela. E a conciliação, que compara centavos por venue, compara
-- 20000 com 20000 e reporta 0,00 de divergência atravessando uma troca de
-- moeda. O inegociável #8 derrotado em silêncio, que é exatamente a falha que a
-- correção de moeda no adaptador existiu pra impedir.
--
-- Duas defesas, porque uma só não fecha:
--
--  1. A COLUNA. Cada pagamento e cada carteira nascem com a moeda escrita.
--     Um registro que se explica não depende de uma tabela de configuração que
--     alguém pode editar depois. `default 'BRL'` preenche o histórico, e está
--     certo: hoje só existem casas brasileiras.
--
--  2. O GATILHO. Depois do primeiro pagamento, o mercado da venue não muda
--     mais. Não existe caminho de aplicação que mexa em `market` — o único
--     jeito é UPDATE direto no banco, e é exatamente contra esse que a guarda
--     precisa existir. Um `CHECK` não serve: ele valida o valor novo, não a
--     transição.
--
-- Mudar o mercado de uma casa que já recebeu dinheiro não é configuração, é
-- migração de dado: precisa de decisão humana sobre o que fazer com o histórico.
-- A mensagem do erro diz isso, porque quem vai ler é alguém num psql às onze
-- da noite.

alter table public.payments
  add column if not exists currency text not null default 'BRL'
  check (currency in ('BRL', 'EUR'));

alter table public.house_accounts
  add column if not exists currency text not null default 'BRL'
  check (currency in ('BRL', 'EUR'));

comment on column public.payments.currency is
  'Moeda desta cobrança, gravada na criação. NUNCA deduzir de venues.market na leitura: o market pode mudar e o pagamento não.';

comment on column public.house_accounts.currency is
  'Moeda do saldo. Um crédito em BRL não quita conta em EUR, nem 1:1 nem convertido.';

create or replace function public.venues_market_is_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.market is distinct from old.market then
    if exists (select 1 from public.payments where venue_id = old.id limit 1)
       or exists (select 1 from public.house_accounts where venue_id = old.id limit 1) then
      raise exception
        'venue % já tem histórico de dinheiro: trocar market de % para % reetiquetaria pagamentos já feitos. Isto é migração de dado, não configuração.',
        old.id, old.market, new.market;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists venues_market_immutable on public.venues;
create trigger venues_market_immutable
  before update on public.venues
  for each row
  execute function public.venues_market_is_immutable();
