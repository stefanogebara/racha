-- 0041 — RETRY DEPOIS DE UM ESTORNO NÃO PAGA A CONTA DE GRAÇA.
--
-- O `house_redeem` é idempotente por txid: um retry com a mesma chave devolve o
-- débito anterior como `duplicate`. Só que um débito ESTORNADO (a conta recusou
-- o pagamento e o serviço devolveu o saldo) também voltava como `duplicate` — e
-- o serviço seguia pro append na conta, que podia ENTRAR se a conta tivesse
-- espaço agora. Conta paga sem débito (compliance, PR #31, LOW-1). A tela
-- mantinha a MESMA chave depois do "a conta mudou", então o segundo toque do
-- cliente era exatamente esse retry.
--
-- REDEFINE A PARTIR DA 0040 (a versão viva), mudando SÓ o bloco de
-- idempotência: um REDEEMED com REDEEM_REVERSED do mesmo txid → RH006.

create or replace function public.house_redeem(
  p_account_id uuid, p_check_id uuid, p_txid text,
  p_amount_cents bigint, p_now text
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_now timestamptz := p_now::timestamptz;
  v_principal bigint;
  v_bonus_avail bigint;
  v_remaining bigint := p_amount_cents;
  v_bonus_used bigint := 0;
  v_principal_used bigint;
  v_lots jsonb := '[]'::jsonb;
  v_use bigint;
  v_seq integer;
  v_prior jsonb;
  r record;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid amount' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 43));

  -- idempotency: a retried redeem with the same txid returns the prior debit
  select payload into v_prior
    from house_account_events
   where account_id = p_account_id and type = 'REDEEMED'
     and payload->>'txid' = p_txid
   limit 1;
  if v_prior is not null then
    -- O DÉBITO ANTERIOR FOI ESTORNADO: não é "já feito". Devolver `duplicate`
    -- aqui deixava o retry com a MESMA chave lançar o pagamento na conta sem
    -- débito nenhum — a conta paga, a carteira intacta, a casa no prejuízo
    -- (compliance, PR #31, LOW-1). Recusa com código: a próxima tentativa é
    -- OUTRO pagamento, com outra chave.
    if exists (
      select 1 from house_account_events
       where account_id = p_account_id and type = 'REDEEM_REVERSED'
         and payload->>'txid' = p_txid
    ) then
      raise exception 'resgate já estornado — nova tentativa' using errcode = 'RH006';
    end if;
    return jsonb_build_object(
      'duplicate', true, 'seq', null,
      'principalUsedCents', (v_prior->>'principalCents')::bigint,
      'bonusUsedCents', (v_prior->>'bonusCents')::bigint
    );
  end if;

  select principal_cents into v_principal
    from house_accounts where id = p_account_id and active;
  if not found then
    raise exception 'unknown house account %', p_account_id using errcode = 'RH005';
  end if;

  select coalesce(sum(remaining_cents), 0) into v_bonus_avail
    from house_bonus_lots
   where account_id = p_account_id and remaining_cents > 0 and expires_at > v_now;

  if v_principal + v_bonus_avail < p_amount_cents then
    raise exception 'saldo insuficiente' using errcode = 'RH001';
  end if;

  for r in
    select id, event_seq, remaining_cents
      from house_bonus_lots
     where account_id = p_account_id and remaining_cents > 0 and expires_at > v_now
     order by expires_at asc, event_seq asc
  loop
    exit when v_remaining = 0;
    v_use := least(r.remaining_cents, v_remaining);
    update house_bonus_lots set remaining_cents = remaining_cents - v_use where id = r.id;
    v_lots := v_lots || jsonb_build_object('seq', r.event_seq, 'useCents', v_use);
    v_bonus_used := v_bonus_used + v_use;
    v_remaining := v_remaining - v_use;
  end loop;

  v_principal_used := v_remaining;
  if v_principal_used > 0 then
    update house_accounts
       set principal_cents = principal_cents - v_principal_used
     where id = p_account_id;
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from house_account_events where account_id = p_account_id;
  insert into house_account_events (account_id, seq, type, payload)
    values (p_account_id, v_seq, 'REDEEMED', jsonb_build_object(
      'txid', p_txid, 'checkId', p_check_id::text, 'at', p_now,
      'principalCents', v_principal_used, 'bonusCents', v_bonus_used,
      'lots', v_lots
    ));

  return jsonb_build_object(
    'duplicate', false, 'seq', v_seq,
    'principalUsedCents', v_principal_used, 'bonusUsedCents', v_bonus_used
  );
end;
$$;

notify pgrst, 'reload schema';
