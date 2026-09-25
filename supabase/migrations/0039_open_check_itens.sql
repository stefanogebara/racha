-- 0039 — O `OPENED` LEVA OS ITENS, como o `ADJUSTED` da 0038.
--
-- A conta mostrava os itens do `checks.pos_ref`, lido numa ida ao banco, e o
-- total do razão, lido noutra. Um ajuste no meio mostrava itens velhos com o
-- total novo por uma leitura (compliance e segurança, PR #29). O leitor passa a
-- tirar os itens do ÚLTIMO `OPENED`/`ADJUSTED` — a mesma leitura que dá o total
-- (`itensDoRazao`). A 0038 pôs os itens no `ADJUSTED`; esta põe no `OPENED`.
--
-- REDEFINE A `open_check` A PARTIR DA 0037, que é a versão em produção (o corpo
-- abaixo é o dela, com uma mudança só: o payload do `OPENED`). Mesma
-- assinatura, então `create or replace` troca em vez de criar sobrecarga.
--
-- O `pos_ref` NÃO É SÓ ITENS: a coluna nasceu como "id da comanda no POS"
-- (0001). Os itens só entram no evento se o texto for uma lista de itens de
-- verdade — objetos com `name` texto e `priceCents` inteiro — que SOMA o
-- total. Qualquer outra coisa abre a conta como antes, sem itens no evento, e o
-- leitor cai no `pos_ref`, como sempre fez.

create or replace function public.open_check(
  p_table_id uuid,
  p_total_cents bigint,
  p_pos_ref text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_venue_id uuid;
  v_itens jsonb;
  v_ruins integer;
  v_soma bigint;
  v_payload jsonb;
begin
  select venue_id into v_venue_id from venue_tables where id = p_table_id;
  if v_venue_id is null then
    raise exception 'open_check: mesa desconhecida' using errcode = '22023';
  end if;

  if p_total_cents is null or p_total_cents <= 0 then
    raise exception 'open_check: total inválido' using errcode = '22023';
  end if;

  insert into checks (venue_id, table_id, total_cents, pos_ref)
    values (v_venue_id, p_table_id, p_total_cents, p_pos_ref)
    returning id into v_id;

  -- Os itens do evento — só se o `pos_ref` for uma lista de itens que soma o
  -- total. O `begin/exception` isola o texto que não é JSON (um id de POS).
  v_payload := jsonb_build_object('totalCents', p_total_cents);
  begin
    v_itens := p_pos_ref::jsonb;
  exception when others then
    v_itens := null;
  end;
  if v_itens is not null and jsonb_typeof(v_itens) = 'array'
     and jsonb_array_length(v_itens) between 1 and 200 then
    select count(*) into v_ruins
      from jsonb_array_elements(v_itens) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(jsonb_typeof(e->'name'), '') <> 'string'
        or coalesce(jsonb_typeof(e->'priceCents'), '') <> 'number'
        or coalesce(e->>'priceCents', '') !~ '^[0-9]{1,15}$';
    if v_ruins = 0 then
      select coalesce(sum((e->>'priceCents')::bigint), 0) into v_soma from jsonb_array_elements(v_itens) e;
      if v_soma = p_total_cents then
        v_payload := jsonb_build_object('totalCents', p_total_cents, 'items', v_itens);
      end if;
    end if;
  end if;

  -- Se isto lançar, a linha de cima some junto: é o ponto inteiro da função.
  perform public.append_check_event(v_id, 'OPENED', v_payload, null);

  return v_id;
end;
$$;

revoke all on function public.open_check(uuid, bigint, text) from public, anon, authenticated;

comment on function public.open_check(uuid, bigint, text) is
  'Abre a conta: a linha em checks e o OPENED (com os itens, quando o pos_ref é uma lista de itens que soma o total) na mesma transação. 23505 quando a mesa já tem conta aberta. Ver 0037 e 0039.';

notify pgrst, 'reload schema';
