-- 0043 — O PAGAMENTO DA CARTEIRA SÓ ENTRA NA CONTA SE O DÉBITO EXISTE.
--
-- O `append_house_payment_guarded` confiava no valor e no txid que o serviço
-- mandava: lançava `PAYMENT_CONFIRMED` de `p_amount_cents` sem olhar se houve
-- um `REDEEMED` que o pagasse. Hoje só o `house-service` chama, sempre depois
-- do `house_redeem` com o mesmo txid e valor. Mas quem garantia isso era o
-- chamador, e a regra da casa é o banco não confiar nele (a lição da 0037,
-- LOW-3; segurança, PR #36, BAIXA). Um bug no serviço, ou outro chamador no
-- futuro, lançaria pagamento sem débito: dinheiro que ninguém pagou, quitando
-- conta de restaurante.
--
-- AGORA, sob a MESMA trava da conta (42), o lançamento exige um `REDEEMED`
-- com o MESMO txid, a MESMA conta (`checkId`) e principal + bônus = valor.
-- Sem ele: RH009, e nada é gravado.
--
-- RH009 NÃO É 409 (o classificador em `reconcile.js` diz 500): o serviço o
-- trata à parte. Pelo serviço de hoje, RH009 só nasce de um BUG em que o
-- débito deste txid EXISTE com outra conta ou outro valor — então o certo pro
-- cliente é estornar esse débito (CDC art. 42), e é o que o serviço faz: tenta
-- o estorno e diz ao cliente, com certeza, que o saldo não foi debitado
-- (compliance, PR #42, HIGH-1). Se o estorno FALHAR, aí sim sobe o 500, e a
-- conciliação aponta o débito sem pagamento.
--
-- A ORDEM das recusas: idempotência (já lançado → devolve o seq), RH006
-- (débito estornado), RH002 (conta fechada), RH004 (conta sem eventos),
-- RH009 (sem débito), RH003 (excede). O RH009 vem ANTES do RH003: um
-- lançamento sem débito que também excede não pode virar 409 e mandar
-- estornar um débito que não existe.
--
-- E o `house_redeem_reverse` ganha código (RH010) pro débito que não existe —
-- ver o bloco dele abaixo.
--
-- REDEFINE A FUNÇÃO A PARTIR DA 0042, que é a versão em produção (corpo
-- idêntico, mais o bloco do RH009). Mesma assinatura: `create or replace`
-- troca, não cria sobrecarga.

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

  if exists (
    select 1 from house_account_events
     where type = 'REDEEM_REVERSED' and payload->>'txid' = p_txid
  ) then
    raise exception 'débito deste pagamento já estornado' using errcode = 'RH006';
  end if;

  if exists (select 1 from check_events where check_id = p_check_id and type = 'CLOSED') then
    raise exception 'conta fechada' using errcode = 'RH002';
  end if;

  select (payload->>'totalCents')::bigint into v_total
    from check_events
   where check_id = p_check_id and type in ('OPENED', 'ADJUSTED')
   order by seq desc limit 1;
  if v_total is null then
    raise exception 'conta sem eventos' using errcode = 'RH004';
  end if;

  -- O DÉBITO QUE PAGA ESTE LANÇAMENTO: mesmo txid, mesma conta, mesmo valor.
  -- O `coalesce` trata débito antigo sem `bonusCents` como zero de bônus.
  if not exists (
    select 1 from house_account_events
     where type = 'REDEEMED' and payload->>'txid' = p_txid
       and payload->>'checkId' = p_check_id::text
       and coalesce((payload->>'principalCents')::bigint, 0)
         + coalesce((payload->>'bonusCents')::bigint, 0) = p_amount_cents
  ) then
    raise exception 'pagamento sem débito correspondente na carteira' using errcode = 'RH009';
  end if;

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
  select coalesce(sum((payload->>'amountCents')::bigint), 0) into v_reversed
    from check_events
   where check_id = p_check_id and type = 'PAYMENT_REFUND_REVERSED';

  if (v_paid - greatest(v_refunded - v_reversed, 0)) + p_amount_cents > v_total then
    raise exception 'excede o que falta pagar' using errcode = 'RH003';
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

-- O ESTORNO DE UM DÉBITO QUE NÃO EXISTE, COM CÓDIGO (compliance, PR #42,
-- HIGH-1 e LOW-1). O serviço agora tenta estornar no RH009 — e o débito pode
-- não existir. A 0042 lançava 'unknown redeem txid' SEM código (P0001), e só a
-- frase dizia o que era; a regra é decidir pelo código (inegociável #7). RH010
-- = "não há débito com este txid nesta carteira": nada foi debitado. Corpo da
-- 0042, idêntico, mais o `using errcode`.
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
      'txid', p_txid, 'at', p_now, 'reason', 'check_append_refused'
    ));
  return jsonb_build_object('duplicate', false, 'seq', v_seq);
end;
$$;

-- A busca do débito por txid, sem varrer a tabela a cada pagamento (a mesma
-- forma do índice de estorno da 0042).
create index if not exists house_account_events_debito_txid_idx
  on public.house_account_events ((payload->>'txid'))
  where type = 'REDEEMED';

notify pgrst, 'reload schema';
