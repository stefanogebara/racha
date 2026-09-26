-- 0044 — O DONO DEVOLVE AO SALDO um débito que nunca chegou à conta.
--
-- Até aqui o conserto do `house_redeem_missing_payment_row` era SQL na mão de
-- quem opera o Racha (`docs/runbooks/saldo-debitado-sem-pagamento.md`). A
-- página da carteira ganha um botão (compliance, PR #42, H-2), e ele usa o
-- MESMO estorno do serviço — que já recusa o pagamento que entrou (RH007), o
-- débito que não existe (RH010) e responde `duplicate` no repetido.
--
-- O QUE MUDA NO ESTORNO:
--
-- 1. O REGISTRO. O `REDEEM_REVERSED` gravava sempre
--    `reason: 'check_append_refused'`. O estorno pedido pelo dono grava
--    `owner_recredit` e QUEM (`by`: o id do usuário, não o e-mail — o mesmo
--    nome do `PAYMENT_ISSUE_RESOLVED.by`). A lista de motivos é fechada, e
--    `owner_recredit` sem autor é recusado. Os dois com RH011, código próprio
--    (segurança, PR #44, L-3).
--
-- 2. O BÔNUS QUE VENCEU NO MEIO (compliance, PR #44, H-1). O estorno devolvia
--    o bônus ao LOTE original, com a validade original. O estorno automático
--    roda em segundos e isso nunca importou; o do dono vem minutos ou horas
--    depois, e um lote que venceu nesse meio voltava VENCIDO — o botão e o
--    extrato diziam "+R$ X" e o saldo usável subia menos: o cliente perdia
--    bônus por uma falha nossa (CDC arts. 6º III, 14, 30). Agora a parte de
--    lote VENCIDO no instante do estorno volta como um LOTE NOVO de bônus
--    (nunca como principal: principal vira dinheiro, bônus não), com a
--    validade da casa contada do estorno — a mesma regra da recarga
--    (23:59:59.999 de São Paulo no dia de hoje + validade). O evento grava
--    `reissue: { bonusCents, expiresAt, fromLots }`, e o redutor
--    (`account-state.js`) lê o mesmo campo: banco e razão contam igual.
--    SÓ no `owner_recredit` (segurança, PR #44, re-revisão L-1): no estorno
--    AUTOMÁTICO o cliente escolhe o instante — dois pagamentos disparados às
--    23:59:59.9 do último dia do lote, um recusado e estornado depois da
--    meia-noite, e o bônus renasceria com validade cheia, toda vez. O
--    automático roda em segundos e devolve ao lote de origem, como sempre; o
--    do dono exige achado da conciliação, 5 min de espera e o clique do dono.
--
-- ASSINATURA NOVA, com dois parâmetros opcionais. `create or replace` com
-- parâmetro a mais criaria uma SOBRECARGA — as duas versões convivendo, e a
-- chamada de três argumentos ficaria ambígua. Então DROP da de três e CREATE
-- da de cinco; os chamadores de três argumentos (o serviço, por nome) seguem
-- funcionando pelos valores padrão. O `revoke` da 0006 some com o DROP e é
-- refeito abaixo.
--
-- UMA TRANSAÇÃO, explícita (segurança, PR #44, M-1). Aplicada com `psql -f`
-- sem `-1`, cada comando fecharia sozinho: entre o DROP e o CREATE nenhum
-- estorno funcionaria (cliente debitado sem pagamento), e entre o CREATE e o
-- REVOKE a função `security definer` ficaria exposta ao `anon`.
-- COMO FOI APLICADA: pelo `apply_migration` do MCP do Supabase, antes do merge,
-- como as outras (conferida depois pelo md5 do corpo). Se a ferramenta já
-- abrir transação, o `begin` vira aviso e o `commit` fecha a mesma — o DROP, o
-- CREATE e o REVOKE continuam juntos. Pela mão: `psql -1 -v ON_ERROR_STOP=1 -f`.

begin;

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
  v_now timestamptz;
  v_lot_exp timestamptz;
  v_reissue bigint := 0;
  v_from jsonb := '[]'::jsonb;
  v_validity integer;
  v_exp timestamptz;
  v_payload jsonb;
begin
  -- O MOTIVO é de uma lista fechada, e o estorno pedido pelo DONO tem autor:
  -- "devolvido" sem quem e sem por quê é só o saldo mudando (inegociável #6).
  if p_reason is null or p_reason not in ('check_append_refused', 'owner_recredit') then
    raise exception 'house_redeem_reverse: motivo inválido' using errcode = 'RH011';
  end if;
  if p_reason = 'owner_recredit' and coalesce(length(btrim(p_actor)), 0) = 0 then
    raise exception 'house_redeem_reverse: estorno do dono sem autor' using errcode = 'RH011';
  end if;
  v_now := p_now::timestamptz;

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
  -- O PAGAMENTO JÁ ENTROU NA CONTA com este txid: não se estorna.
  if exists (
    select 1 from check_events
     where check_id = (v_orig->>'checkId')::uuid and type = 'PAYMENT_CONFIRMED'
       and payload->>'txid' = p_txid
  ) then
    raise exception 'pagamento já lançado na conta — não se estorna' using errcode = 'RH007';
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from house_account_events where account_id = p_account_id;

  update house_accounts
     set principal_cents = principal_cents + (v_orig->>'principalCents')::bigint
   where id = p_account_id;

  -- Cada lote usado: se ainda vale AGORA — ou se o estorno é o AUTOMÁTICO —, o
  -- bônus volta pra ele; se venceu (ou sumiu da tabela) num estorno do DONO,
  -- vai pro lote novo.
  for u in select * from jsonb_to_recordset(coalesce(v_orig->'lots', '[]'::jsonb))
             as x(seq integer, "useCents" bigint)
  loop
    select expires_at into v_lot_exp
      from house_bonus_lots where account_id = p_account_id and event_seq = u.seq;
    if p_reason <> 'owner_recredit' or (v_lot_exp is not null and v_lot_exp > v_now) then
      update house_bonus_lots
         set remaining_cents = remaining_cents + u."useCents"
       where account_id = p_account_id and event_seq = u.seq;
    else
      v_reissue := v_reissue + u."useCents";
      v_from := v_from || to_jsonb(u.seq);
    end if;
  end loop;

  v_payload := jsonb_build_object('txid', p_txid, 'at', p_now, 'reason', p_reason)
    || case when p_actor is null then '{}'::jsonb else jsonb_build_object('by', btrim(p_actor)) end;

  if v_reissue > 0 then
    select v.house_validity_days into v_validity
      from house_accounts a join venues v on v.id = a.venue_id
     where a.id = p_account_id;
    -- A mesma regra da recarga: último instante válido = 23:59:59.999 de São
    -- Paulo em (hoje + validade), pra data mostrada ao cliente ser exata.
    v_exp := (((v_now at time zone 'America/Sao_Paulo')::date
               + coalesce(v_validity, 90) + 1)::timestamp at time zone 'America/Sao_Paulo')
             - interval '1 millisecond';
    v_payload := v_payload || jsonb_build_object('reissue', jsonb_build_object(
      'bonusCents', v_reissue, 'expiresAt', house_iso(v_exp), 'fromLots', v_from));
    insert into house_bonus_lots (account_id, event_seq, granted_cents, remaining_cents, expires_at)
      values (p_account_id, v_seq, v_reissue, v_reissue, v_exp);
  end if;

  insert into house_account_events (account_id, seq, type, payload)
    values (p_account_id, v_seq, 'REDEEM_REVERSED', v_payload);
  return jsonb_build_object('duplicate', false, 'seq', v_seq, 'reissuedBonusCents', v_reissue);
end;
$$;

revoke all on function public.house_redeem_reverse(uuid, text, text, text, text) from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
