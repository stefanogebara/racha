-- 0034 — o LANÇAMENTO CONDICIONAL: conferir e gravar viram um passo só.
--
-- A rota `/api/checks/record-restitution` lia o razão, calculava quanto o dono
-- PODE declarar como devolvido fora do trilho, e depois gravava. Entre as duas
-- coisas não havia nada. A revisão de segurança de ec86b37 mediu contra o store
-- de verdade: duas chamadas simultâneas, cada uma no teto de R$ 50, gravaram
-- R$ 100 de devolução contra um direito de R$ 50 — `paidCents` caiu abaixo do
-- total, a conta PAGA voltou a 'parcial', o telefone de quem já tinha pagado
-- voltou a dizer que a mesa devia, e uma cobrança nova podia ser emitida contra
-- quem não devia nada (CDC art. 42). O mesmo estrago sai de um `curl` repetido:
-- a rota é operada à mão pelo runbook e não tinha chave de idempotência.
--
-- O teto é uma pergunta de AUTORIZAÇÃO, e o inegociável #7 diz como se faz uma
-- dessas: RPC atômica, com o erro CHECKADO. Aqui isso é o compare-and-append —
-- o chamador diz qual era o último `seq` que ele viu, e o lançamento só entra se
-- o razão não tiver mudado desde então. Qualquer coisa que mexa na conta no
-- meio do caminho (outra devolução, um estorno do PSP, um pagamento atrasado)
-- invalida a conta que o chamador fez, que é exatamente o que se quer.
--
-- NÃO REESCREVE O CORPO do `append_check_event`: delega. A 0018 conta o que
-- custou reescrever um corpo a partir de uma versão velha — o bloco de cache do
-- status sumiu em silêncio e travou a mesa da demonstração em produção. A trava
-- consultiva é reentrante na mesma transação, então a chamada interna é de
-- graça e a janela fica fechada de ponta a ponta.
create or replace function public.append_check_event_if_unchanged(
  p_check_id uuid,
  p_type text,
  p_payload jsonb,
  p_psp_event_id text default null,
  p_expected_seq integer default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_atual integer;
begin
  if p_expected_seq is null or p_expected_seq < 0 then
    raise exception 'append_check_event_if_unchanged: expected_seq obrigatório'
      using errcode = '22023';
  end if;

  -- A MESMA trava do append, tomada ANTES da leitura: sem ela, as duas
  -- chamadas leem o mesmo `max(seq)` e as duas acham que nada mudou.
  perform pg_advisory_xact_lock(hashtextextended(p_check_id::text, 42));

  select coalesce(max(seq), 0) into v_atual from check_events where check_id = p_check_id;
  if v_atual <> p_expected_seq then
    raise exception 'append_check_event_if_unchanged: o razão mudou (esperado %, atual %)',
      p_expected_seq, v_atual
      using errcode = '40001';   -- serialization_failure: o chamador refaz a conta
  end if;

  return public.append_check_event(p_check_id, p_type, p_payload, p_psp_event_id);
end;
$$;

revoke all on function public.append_check_event_if_unchanged(uuid, text, jsonb, text, integer) from public, anon, authenticated;

comment on function public.append_check_event_if_unchanged(uuid, text, jsonb, text, integer) is
  'Compare-and-append no razão: só grava se o último seq da conta ainda for o que o chamador viu. 40001 quando mudou. Ver 0034.';

-- A IDEMPOTÊNCIA DA DEVOLUÇÃO FORA DO TRILHO.
--
-- O `psp_event_id` cobre o que vem do adquirente; a devolução por fora não vem
-- de lugar nenhum — quem a digita é o dono, e a REFERÊNCIA (o comprovante do
-- Pix, "dinheiro no caixa às 21h40") é o que identifica aquele ato no mundo.
-- Um `curl` que dá timeout e é repetido registrava a mesma devolução duas
-- vezes, e a cópia do erro de 500 chega a MANDAR conferir antes de repetir —
-- prova de que a gente sabia que a repetição era provável e não a tratava.
--
-- Índice PARCIAL: só sobre as devoluções fora do trilho, e sobre a referência
-- normalizada (aparar espaço, caixa baixa) — "PIX E2E123" e "pix e2e123 " são o
-- mesmo comprovante, e deixar as duas passarem seria ter escrito o índice pra
-- nada. A colisão volta como 23505 e a rota responde a MESMA coisa que
-- respondeu da primeira vez.
create unique index if not exists check_events_offrail_refund_uidx
  on public.check_events (
    check_id,
    (payload->>'txid'),
    (lower(btrim(payload->>'reference')))
  )
  where type = 'PAYMENT_REFUNDED' and (payload->>'offRail') = 'true';
