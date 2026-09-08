-- Os tipos de evento e os métodos que o código JÁ usa, e o banco recusava.
--
-- Achado pela revisão de segurança de 2026-09-08, e é o achado mais caro da
-- série porque não tinha sintoma nenhum em teste: TODA a suíte usa o store de
-- memória, cujo `appendEvent` aceita qualquer string. Nada no repositório
-- tocava SQL. Então três tipos de evento foram escritos, testados, revisados e
-- comitados enquanto o banco de produção os recusaria com 23514 — todos eles.
--
-- O que estava quebrado em PRODUÇÃO, hoje, antes desta migração:
--
--  - `PAYMENT_DISPUTED` (que é anterior a esta série): o `charge.dispute.created`
--    chega, o append estoura, o `try/catch` da rota escreve uma linha em stderr
--    e devolve **200**. A Stripe é informada de que tratamos o chargeback. A
--    disputa nunca entra no log, então `disputeDueBy` nunca existe, então os
--    achados de prazo que acabei de escrever NUNCA disparam. Os 40 dias de
--    prova do Bizum vencem em silêncio absoluto.
--  - `PAYMENT_REFUND_REVERSED`: estoura, vira 500, a Stripe reenvia e
--    desabilita o endpoint. O estorno que falhou nunca é revertido e o razão
--    segue dizendo que o cliente foi reembolsado.
--  - `PAYMENT_DISPUTE_CLOSED`: idem, e a anomalia que ele existe pra limpar
--    nunca é limpa.
--
-- É a forma exata do inegociável #7: um 200 silencioso por cima de uma
-- afirmação de dinheiro quebrada, com stderr num log serverless como único
-- sinal. O mesmo desenho do incidente de doze dias que abriu essa regra.
--
-- E `method` tinha o mesmo buraco: `('pix','card','house_account')` — sem
-- `bizum`. Toda cobrança espanhola falharia na inserção. Hoje não é
-- explorável porque a Espanha falha fechada atrás de `RACHA_ES_ENABLED`, mas
-- é bloqueio de lançamento sentado na mesma lacuna de censo.
--
-- O teste que faltava (e que agora existe) atravessa a fronteira JS/SQL: lê o
-- último `check (… in (…))` destas migrações e exige igualdade de conjunto com
-- `EVENT_TYPES` e com os métodos que o código grava.

alter table public.check_events drop constraint if exists check_events_type_check;
alter table public.check_events add constraint check_events_type_check
  check (type in (
    'OPENED', 'ADJUSTED', 'PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'CLOSED',
    'PAYMENT_DISPUTED', 'PAYMENT_REFUND_REVERSED', 'PAYMENT_DISPUTE_CLOSED',
    -- Anomalia registrada: o caso fora de ordem, que não pode ser aplicado nem
    -- recusado. Ver `PAYMENT_ANOMALY` no `check-state.js`.
    'PAYMENT_ANOMALY',
    -- Resolução de pendência pelo dono, com autor e motivo. Sem ela a marca do
    -- estorno que falhou é permanente, e casa que nunca fica verde é casa que
    -- para de olhar.
    'PAYMENT_ISSUE_RESOLVED'
  ));

alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check
  check (method in ('pix', 'card', 'house_account', 'bizum'));
