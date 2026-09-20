-- AS PALAVRAS DA CASA GANHAM LIMITE NO BANCO.
--
-- O esquema já limitava o que o CLIENTE escreve: `payer_label` é
-- `char_length between 1 and 60` desde a 0001, e `house_accounts.name` desde a
-- 0005. Não limitava o que o DONO escreve — `venues.name`, `venues.city` e
-- `venue_tables.label` nasceram `text` puro. E são justamente esses três que
-- saem, sem autenticação nenhuma, no `/api/check` que todo cliente lê ao
-- encostar o telefone no QR. O campo que o cliente manda tinha trava; o campo
-- que todo cliente LÊ, não.
--
-- O portão de escrita (`_lib/texto-da-casa.js`) já recusa antes de chegar aqui.
-- Isto é a segunda tranca, pela mesma razão que toda regra de dinheiro desta
-- casa tem duas: um caminho de escrita novo — um script de importação, um
-- INSERT à mão pra "só corrigir o nome" — não passa pelo router. Um teste
-- (`texto-da-casa.test.js`) afirma que os números daqui e os do código são os
-- mesmos: um limite MAIOR aqui deixa passar o que o portão recusa (inofensivo);
-- um MENOR faz o portão aprovar e a escrita explodir com erro de Postgres na
-- cara do dono.
--
-- SEGURO PRA APLICAR: medido em produção em 2026-09-16, antes de escrever isto
-- — maior `venues.name` tem 27 caracteres, maior `city` 9, maior `label` 22.
-- Nenhuma linha viola, então a validação não recusa nada. `char_length` conta
-- PONTOS DE CÓDIGO, que é o que o normalizador do Node conta com `[...s]`.

alter table public.venues
  add constraint venues_name_len check (char_length(name) between 1 and 80);

alter table public.venues
  add constraint venues_city_len check (city is null or char_length(city) between 1 and 60);

alter table public.venue_tables
  add constraint venue_tables_label_len check (char_length(label) between 1 and 40);
