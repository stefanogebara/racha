-- OS ÍNDICES QUE AS LEITURAS DO PAINEL E DA CONCILIAÇÃO PEDEM.
--
-- Medido em 2026-09-16: `payments` tinha `(venue_id, created_at)` — e a leitura
-- mais quente do produto filtra por `(venue_id, status, confirmed_at)`. Coluna
-- vizinha, índice inútil: o `created_at` é quando a cobrança NASCEU e o
-- `confirmed_at` é quando o dinheiro ENTROU, e é o segundo que decide o que o
-- painel mostra e o que a folha recebe.
--
-- HONESTIDADE SOBRE O TAMANHO: produção hoje tem 48 pagamentos e 37 contas.
-- Nesse volume nada disto muda nada — o Postgres varre a tabela inteira mais
-- rápido do que leria um índice. Isto entra porque a leitura acabou de ganhar
-- paginação, e paginação sem índice que sustente a ORDEM é o caso em que cada
-- página reordena o conjunto inteiro: o custo cresce com o quadrado das
-- páginas, e aparece exatamente quando a casa fica grande o bastante pra
-- importar. Índice em tabela pequena é barato; a alternativa é descobrir em
-- produção.
--
-- A ordem das colunas segue a forma da consulta: igualdades primeiro
-- (`venue_id`, `status`), depois a faixa (`confirmed_at`), depois o desempate
-- da paginação (`txid`).

create index if not exists payments_venue_confirmado_idx
  on public.payments (venue_id, status, confirmed_at, txid);

-- A conciliação lê os pagamentos POR CONTA, em lote, ordenados por
-- `(check_id, txid)`. Havia índice só em `check_id`: o desempate saía de um
-- sort por lote de 200 contas.
create index if not exists payments_check_txid_idx
  on public.payments (check_id, txid);

-- O funil de adoção conta contas abertas por janela; havia `(venue_id, status)`
-- e o filtro é `(venue_id, opened_at)`.
create index if not exists checks_venue_opened_idx
  on public.checks (venue_id, opened_at, id);
