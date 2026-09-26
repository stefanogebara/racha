-- 0044 — O DONO DEVOLVE AO SALDO um débito que nunca chegou à conta.
--
-- Até aqui o conserto do `house_redeem_missing_payment_row` era SQL na mão de
-- quem opera o Racha (`docs/runbooks/saldo-debitado-sem-pagamento.md`). A
-- página da carteira ganha um botão (compliance, PR #42, H-2), e ele usa o
-- MESMO estorno do serviço — que já recusa o pagamento que entrou (RH007), o
-- débito que não existe (RH010) e responde `duplicate` no repetido.
--
-- O que muda aqui é o REGISTRO: o `REDEEM_REVERSED` gravava sempre
-- `reason: 'check_append_refused'`. O estorno pedido pelo dono grava
-- `owner_recredit` e o AUTOR (o id do usuário, não o e-mail). A lista de
-- motivos é fechada no banco, e `owner_recredit` sem autor é recusado.
--
-- ASSINATURA NOVA, com dois parâmetros opcionais. `create or replace` com
-- parâmetro a mais criaria uma SOBRECARGA — as duas versões convivendo, e a
-- chamada de três argumentos ficaria ambígua. Então DROP da de três e CREATE
-- da de cinco, na mesma transação; os chamadores de três argumentos (o
-- serviço, por nome) seguem funcionando pelos valores padrão. O `revoke` da
-- 0006 some com o DROP e é refeito abaixo.
--
-- Corpo: o da 0043 (RH010 incluído), mais o motivo e o autor.

drop function if exists public.house_redeem_reverse(uuid, text, text);

create or replace function public.house_redeem_reverse(
  p_account_id uuid, p_txid text, p_now text,
  p_reason text default 'check_append_refused', p_actor text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_orig jsonb;
  v_seq integer;
  u record;
begin
  -- O MOTIVO é de uma lista fechada, e o estorno pedido pelo DONO tem autor:
  -- "devolvido" sem quem e sem por quê é só o saldo mudando (inegociável #6).
  if p_reason is null or p_reason not in ('check_append_refused', 'owner_recredit') then
    raise exception 'house_redeem_reverse: motivo inválido' using errcode = '22023';
  end if;
  if p_reason = 'owner_recredit' and coalesce(length(p_actor), 0) = 0 then
    raise exception 'house_redeem_reverse: estorno do dono sem autor' using errcode = '22023';
  end if;

  -- O débito original PRIMEIRO, sem trava: o razão da carteira é só-anexar, e
  -- é dele que sai a conta onde o pagamento seria lançado.
  select payload into v_orig
    from house_account_events
   where account_id = p_account_id and type = 'REDEEMED'
     and payload->>'txid' = p_txid
   limit 1;
  if v_orig is null then
    raise exception 'unknown redeem txid %', p_txid using errcode = 'RH010';
  end if;

  -- A trava da CONTA (42) antes da trava da CARTEIRA (43). Nada mais toma as
  -- duas — o `append_house_payment_guarded` toma só a 42, o `house_redeem` só a
  -- 43 —, então não há ciclo nem deadlock.
  perform pg_advisory_xact_lock(hashtextextended(v_orig->>'checkId', 42));
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text, 43));


  if exists (
    select 1 from house_account_events
     where account_id = p_account_id and type = 'REDEEM_REVERSED'
       and payload->>'txid' = p_txid
  ) then
    return jsonb_build_object('duplicate', true);
  end if;

  -- (DEPOIS do "já estornado": um estorno repetido sobre um estorno já feito
  -- responde duplicate, nunca 'landed' — segurança, PR #36, LOW-3.)
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
      'txid', p_txid, 'at', p_now, 'reason', p_reason
    ) || case when p_actor is null then '{}'::jsonb else jsonb_build_object('actor', p_actor) end);
  return jsonb_build_object('duplicate', false, 'seq', v_seq);
end;
$$;

revoke all on function public.house_redeem_reverse(uuid, text, text, text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
