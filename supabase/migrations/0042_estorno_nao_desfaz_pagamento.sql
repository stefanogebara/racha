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
--
-- E A OUTRA ORDEM (compliance, PR #36, M-1): `append_house_payment_guarded`
-- (redefinida a partir da 0040, só um bloco novo) recusa com RH006 quando o
-- débito daquele txid já foi estornado. As duas guardas moram sob a trava 42.
--
-- E O CRÍTICO DA SEGURANÇA (PR #36): `house_redeem` (redefinida a partir da 0041)
-- recusa com RH008 um "duplicado" de outra conta ou de outro valor.
--
-- Débito ANTIGO sem `checkId` no payload (anterior à gravação do checkId):
-- `hashtextextended(null)` é nulo e a trava/checagem não acontecem — o estorno
-- segue como antes. Todo REDEEMED gravado pelo `house_redeem` vivo leva o
-- checkId, então isso só vale pra linha histórica (compliance, PR #36, L-1).
-- Produção em 2026-09-25: os 3 REDEEMED têm checkId; nenhum txid em duas contas,
-- nenhum valor divergente — o CRÍTICO nunca foi usado.

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

  -- O DÉBITO DESTE TXID JÁ FOI ESTORNADO: não se lança o pagamento. A outra
  -- ordem da corrida do PR #35 — A estorna ANTES de B lançar — deixava a conta
  -- paga com o débito devolvido (compliance, PR #36, M-1). Sob a trava 42, a
  -- mesma do estorno (0042): quem pegar a trava primeiro decide, nos dois
  -- sentidos. O txid é derivado da conta da carteira, então é único.
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
    -- O "JÁ FEITO" TEM DE SER O MESMO PAGAMENTO: mesma conta, mesmo valor. O
    -- txid saía só da carteira + chave, e a chave vem do cliente — a mesma
    -- chave numa SEGUNDA mesa, ou com valor maior, voltava `duplicate` e o
    -- serviço lançava o pagamento lá sem débito novo: um débito de R$1 pagando
    -- uma conta de R$30 (segurança, PR #36, CRÍTICO). O serviço agora põe conta
    -- e valor no txid; isto é a guarda do banco pra quem não puser.
    if v_prior->>'checkId' is distinct from p_check_id::text
       or coalesce((v_prior->>'principalCents')::bigint, 0) + coalesce((v_prior->>'bonusCents')::bigint, 0) <> p_amount_cents then
      raise exception 'chave de idempotência de outro pagamento' using errcode = 'RH008';
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

-- A busca do estorno pelo txid, SEM a conta da carteira (o append não a sabe),
-- sob a trava da conta: com índice, não varre o razão inteiro a cada pagamento
-- (segurança, PR #36, LOW-1).
create index if not exists house_account_events_estorno_txid_idx
  on public.house_account_events ((payload->>'txid'))
  where type = 'REDEEM_REVERSED';

notify pgrst, 'reload schema';
