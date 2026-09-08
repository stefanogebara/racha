-- A guarda SQL da carteira nunca soube que estorno pode ser DESFEITO.
--
-- Achado pela revisão de segurança de 2026-09-08 (MEDIUM-4), e é o mesmo
-- padrão do 0017: o lado SQL do razão ficou pra trás quando o lado JS ganhou
-- tipos de evento novos.
--
-- `append_house_payment_guarded` calcula o quanto já foi pago somando
-- `PAYMENT_CONFIRMED` e subtraindo `PAYMENT_REFUNDED`. Desde que existe
-- `PAYMENT_REFUND_REVERSED` — o estorno que falhou, com o dinheiro voltando
-- pro restaurante — essa conta SUBTRAI um estorno que foi desfeito. A projeção
-- SQL enxerga a conta como mais em aberto do que ela está, e admite um resgate
-- de saldo da casa que o redutor em JS consideraria pagamento a mais.
--
-- Duas contagens do mesmo dinheiro discordando é exatamente o que o
-- inegociável #8 existe pra proibir, e aqui a que discorda é a que AUTORIZA
-- gastar saldo.
--
-- Redefinida com a mesma assinatura e o mesmo corpo, mudando só o cálculo de
-- `v_refunded`: estornado menos revertido, nunca abaixo de zero.

-- MESMA assinatura do 0006, de propósito: um parâmetro a mais criaria uma
-- SOBRECARGA em vez de substituir, e as duas versões conviveriam — com o
-- chamador acertando a antiga, que é a errada. `create or replace` só
-- substitui quando a assinatura bate exatamente.
create or replace function public.append_house_payment_guarded(
  p_check_id uuid, p_txid text, p_amount_cents bigint
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
  v_existing integer;
  v_total bigint;
  v_paid bigint;
  v_refunded bigint;
  v_reversed bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_check_id::text, 42));

  select seq into v_existing
    from check_events
   where check_id = p_check_id and type = 'PAYMENT_CONFIRMED'
     and payload->>'txid' = p_txid
   limit 1;
  if found then
    return v_existing;
  end if;

  if exists (select 1 from check_events where check_id = p_check_id and type = 'CLOSED') then
    raise exception 'conta fechada';
  end if;

  select (payload->>'totalCents')::bigint into v_total
    from check_events
   where check_id = p_check_id and type in ('OPENED', 'ADJUSTED')
   order by seq desc limit 1;
  if v_total is null then
    raise exception 'conta sem eventos';
  end if;

  -- paid: first occurrence per txid (mirrors the JS reducer's idempotency)
  select coalesce(sum((e.payload->>'amountCents')::bigint), 0) into v_paid
    from (
      select distinct on (payload->>'txid') payload
        from check_events
       where check_id = p_check_id and type = 'PAYMENT_CONFIRMED'
       order by payload->>'txid', seq
    ) e;
  select coalesce(sum((payload->>'amountCents')::bigint), 0) into v_refunded
    from check_events
   where check_id = p_check_id and type = 'PAYMENT_REFUNDED';
  -- O estorno DESFEITO: o dinheiro voltou pro restaurante, então ele não pode
  -- continuar descontado do que foi pago.
  select coalesce(sum((payload->>'amountCents')::bigint), 0) into v_reversed
    from check_events
   where check_id = p_check_id and type = 'PAYMENT_REFUND_REVERSED';

  if (v_paid - greatest(v_refunded - v_reversed, 0)) + p_amount_cents > v_total then
    raise exception 'excede o que falta pagar';
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from check_events where check_id = p_check_id;
  insert into check_events (check_id, seq, type, payload)
    values (p_check_id, v_seq, 'PAYMENT_CONFIRMED', jsonb_build_object(
      'txid', p_txid, 'amountCents', p_amount_cents, 'tipCents', 0,
      'method', 'house_account'
    ));
  return v_seq;
end;
$$;

revoke all on function public.append_house_payment_guarded(uuid, text, bigint)
  from public, anon, authenticated;
