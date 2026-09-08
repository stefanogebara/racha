-- IDEMPOTÊNCIA no lugar certo: o id do evento do PSP, único, na hora do append.
--
-- Achado pela revisão de segurança de 2026-09-08, e fecha quatro coisas de uma
-- vez porque as quatro são a mesma coisa vista de ângulos diferentes.
--
-- **O que estava acontecendo.** A Stripe manda `refund.failed` E
-- `refund.updated` com status `failed` pro MESMO estorno que falhou, e o
-- adaptador mapeia os dois pra `refund_failed`. Endpoint em versão de API
-- antiga recebe `charge.refund.updated` como um terceiro. Isso não é cenário
-- de reenvio: é a entrega NORMAL de uma falha.
--
-- Cada uma aplicava uma reversão. Reproduzido: um estorno de 900 do qual 500
-- tinha dado certo era APAGADO inteiro, a conta voltava pra `paga`, o
-- write-back dizia "pago" pro POS e a mesa fechava. O cliente com R$ 5,00 de
-- volta na conta dele e os nossos livros dizendo que não.
--
-- E a corrida: `loadEvents` lê, depois `append_check_event` grava numa
-- transação separada. O lock por conta ordena `seq`, não protege o intervalo.
-- Duas entregas simultâneas do mesmo `charge.refunded` liam `jaEstornado=0`,
-- calculavam o mesmo delta, e as duas passavam pela validação contra estado
-- velho. R$ 10,00 estornados pra um estorno de R$ 5,00.
--
-- **Por que aqui e não em cada espécie.** Já havia três mecanismos de
-- idempotência de três qualidades diferentes — o `duplicate` por txid do
-- pagamento, o delta-zero do estorno acumulado, e o `disputeStatus === 'lost'`
-- que acabei de escrever. Um mecanismo na fronteira do append é o único que
-- escala pro próximo tipo de evento, e é o único que fecha a corrida, porque
-- roda DENTRO da transação que já tem o lock.
--
-- Nulo é permitido: eventos que não vêm de webhook (abertura de conta, ajuste,
-- fechamento) não têm id de PSP, e um índice único ignora nulos.

alter table public.check_events
  add column if not exists psp_event_id text;

create unique index if not exists check_events_psp_event_id_key
  on public.check_events (psp_event_id)
  where psp_event_id is not null;

comment on column public.check_events.psp_event_id is
  'Id do evento do PSP (evt_… na Stripe). Único quando presente: a segunda entrega do mesmo evento colide e vira no-op, dentro da mesma transação do lock.';

-- DERRUBA a assinatura antiga ANTES de criar a nova.
--
-- `create or replace function` só substitui quando a assinatura bate exatamente.
-- Um parâmetro a mais cria uma SOBRECARGA, e as duas versões passam a conviver
-- — e aí uma chamada com três argumentos nomeados casa com as DUAS e o Postgres
-- devolve `42725: function … is not unique`.
--
-- Isso não é hipotético: aconteceu ao aplicar esta migração em produção em
-- 2026-09-08. O código que estava no ar chamava com três argumentos, e entre a
-- aplicação da migração e este `drop` toda confirmação de pagamento teria
-- falhado. Foi pego em segundos porque a verificação incluía CHAMAR a função
-- nas duas formas, em vez de só olhar a assinatura.
--
-- O `drop` vem antes do `create` de propósito: entre um e outro não existe
-- janela em que as duas coexistam.
drop function if exists public.append_check_event(uuid, text, jsonb);

create or replace function public.append_check_event(
  p_check_id uuid,
  p_type text,
  p_payload jsonb,
  p_psp_event_id text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_check_id::text, 42));

  -- Já vimos este evento do PSP? Dentro do lock, então a resposta não muda
  -- entre a leitura e a gravação — que é justamente o intervalo em que duas
  -- entregas simultâneas se atropelavam.
  if p_psp_event_id is not null then
    select seq into v_seq from check_events
      where psp_event_id = p_psp_event_id limit 1;
    if found then
      return -v_seq;  -- negativo = já aplicado, nada foi gravado agora
    end if;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from check_events where check_id = p_check_id;
  insert into check_events (check_id, seq, type, payload, psp_event_id)
    values (p_check_id, v_seq, p_type, p_payload, p_psp_event_id);
  return v_seq;
end;
$$;

revoke all on function public.append_check_event(uuid, text, jsonb, text) from public, anon, authenticated;
