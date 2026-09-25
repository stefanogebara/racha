-- 0042 — O ESTORNO NÃO DESFAZ UM PAGAMENTO QUE ENTROU.
--
-- A corrida que sobrou do PR #35 (as duas revisões): dois pedidos com a MESMA
-- chave ao mesmo tempo. A tem o append recusado (409) e vai estornar; B, antes
-- do estorno de A, vê o débito como não estornado (duplicate) e, se a conta
-- abriu espaço, lança o pagamento; aí o estorno de A entra — conta paga, débito
-- devolvido, a casa no prejuízo. A conciliação acusava (`house_payment_row_
-- without_redeem`), mas o certo é não acontecer.
--
-- REDEFINE A PARTIR DA 0006 (a versão viva de `house_redeem_reverse`),
-- mudando SÓ o começo: lê o débito, trava a CONTA e a CARTEIRA nessa ordem, e
-- recusa (RH007) se aquele txid já é PAYMENT_CONFIRMED na conta.

create or replace function public.house_redeem_reverse(
  p_account_id uuid, p_txid text, p_now text
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_orig jsonb;
  v_seq integer;
  u record;
begin
  -- O débito original PRIMEIRO, sem trava: o razão da carteira é só-anexar, e
  -- é dele que sai a conta onde o pagamento seria lançado.
  select payload into v_orig
    from house_account_events
   where account_id = p_account_id and type = 'REDEEMED'
     and payload->>'txid' = p_txid
   limit 1;
  if v_orig is null then
    raise exception 'unknown redeem txid %', p_txid;
  end if;

  -- A trava da CONTA (42) antes da trava da CARTEIRA (43). Nada mais toma as
  -- duas — o `append_house_payment_guarded` toma só a 42, o `house_redeem` só a
  -- 43 —, então não há ciclo nem deadlock.
  perform pg_advisory_xact_lock(hashtextextended(v_orig->>'checkId', 42));
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 43));

  -- O PAGAMENTO JÁ ENTROU NA CONTA com este txid: não se estorna. Dois pedidos
  -- com a mesma chave ao mesmo tempo — A levou 409, B (duplicado) lançou depois
  -- que a conta abriu espaço — e o estorno de A deixava a conta paga sem
  -- débito (as duas revisões do PR #35). Recusa com código; o serviço trata
  -- como pagamento concluído, que é o que ele é.
  if exists (
    select 1 from check_events
     where check_id = (v_orig->>'checkId')::uuid and type = 'PAYMENT_CONFIRMED'
       and payload->>'txid' = p_txid
  ) then
    raise exception 'pagamento já lançado na conta — não se estorna' using errcode = 'RH007';
  end if;
  if exists (
    select 1 from house_account_events
     where account_id = p_account_id and type = 'REDEEM_REVERSED'
       and payload->>'txid' = p_txid
  ) then
    return jsonb_build_object('duplicate', true);
  end if;

  update house_accounts
     set principal_cents = principal_cents + (v_orig->>'principalCents')::bigint
   where id = p_account_id;
  for u in select * from jsonb_to_recordset(coalesce(v_orig->'lots', '[]'::jsonb))
             as x(seq integer, "useCents" bigint)
  loop
    update house_bonus_lots
       set remaining_cents = remaining_cents + u."useCents"
     where account_id = p_account_id and event_seq = u.seq;
  end loop;

  select coalesce(max(seq), 0) + 1 into v_seq
    from house_account_events where account_id = p_account_id;
  insert into house_account_events (account_id, seq, type, payload)
    values (p_account_id, v_seq, 'REDEEM_REVERSED', jsonb_build_object(
      'txid', p_txid, 'at', p_now, 'reason', 'check_append_refused'
    ));
  return jsonb_build_object('duplicate', false, 'seq', v_seq);
end;
$$;

notify pgrst, 'reload schema';
