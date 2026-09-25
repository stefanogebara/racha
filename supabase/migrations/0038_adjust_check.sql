-- 0038 — AJUSTAR A CONTA É UMA TRANSAÇÃO SÓ: o `ADJUSTED` e os itens.
--
-- O `adjustCheck` gravava o `ADJUSTED` pelo compare-and-append da 0034 e, noutra
-- ida ao banco, os itens (`checks.pos_ref`). Dois ajustes cruzados — A lê seq n
-- e grava n+1; B relê, grava n+2 e escreve os itens dele; a escrita de itens de
-- A, lenta, chega por último — deixavam a conta com o TOTAL de B e os ITENS de
-- A: quem paga "por item" paga um item que o total não tem (segurança, PR #21,
-- MÉDIA; compliance, PR #21, H-1). Sem dinheiro a mais — o teto do que falta
-- segura o valor —, mas conta que não bate é conta que o CDC art. 6º III não
-- deixa mostrar. Inegociável #7: condição de banco por RPC atômica, erro CHECADO.
--
-- NÃO REESCREVE O CORPO do compare-and-append nem do append: delega, como a 0037
-- (a 0018 conta o que custou reescrever um corpo a partir de uma versão velha).
-- A trava consultiva é reentrante na mesma transação, então o `update` dos itens
-- acontece com a conta ainda travada — nenhum outro ajuste entra no meio.
--
-- E O BANCO CONFERE A SOMA: os itens têm de somar o total do evento. O serviço
-- já garante; a função não confia no chamador (a lição da 0037, LOW-3).

create or replace function public.adjust_check(
  p_check_id uuid,
  p_expected_seq integer,
  p_total_cents bigint,
  p_items jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
  v_soma bigint;
  v_ruins integer;
begin
  if p_total_cents is null or p_total_cents <= 0 then
    raise exception 'adjust_check: total inválido' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'adjust_check: itens obrigatórios' using errcode = '22023';
  end if;

  -- Todo item com `priceCents` inteiro e não negativo — antes de somar, pra
  -- um texto ou fração não virar 22P02 sem nome no meio da soma.
  select count(*) into v_ruins
    from jsonb_array_elements(p_items) e
   where jsonb_typeof(e->'priceCents') <> 'number'
      or (e->>'priceCents') !~ '^[0-9]+$';
  if v_ruins > 0 then
    raise exception 'adjust_check: item com valor inválido' using errcode = '22023';
  end if;

  select coalesce(sum((e->>'priceCents')::bigint), 0) into v_soma
    from jsonb_array_elements(p_items) e;
  if v_soma <> p_total_cents then
    raise exception 'adjust_check: os itens somam % e o total é %', v_soma, p_total_cents
      using errcode = '22023';
  end if;

  -- 40001 quando o razão mudou, 22023 sem seq: sobem daqui intactos, e o
  -- serviço decide pelo código (releitura no 40001).
  v_seq := public.append_check_event_if_unchanged(
    p_check_id, 'ADJUSTED', jsonb_build_object('totalCents', p_total_cents), null, p_expected_seq);

  -- Se isto falhar, o `ADJUSTED` de cima some junto: é o ponto inteiro da função.
  update checks set pos_ref = p_items::text where id = p_check_id;
  if not found then
    raise exception 'adjust_check: conta desconhecida' using errcode = '22023';
  end if;

  return v_seq;
end;
$$;

revoke all on function public.adjust_check(uuid, integer, bigint, jsonb) from public, anon, authenticated;

comment on function public.adjust_check(uuid, integer, bigint, jsonb) is
  'Ajusta a conta: ADJUSTED (compare-and-append da 0034) e itens na mesma transação; confere que os itens somam o total. 40001 quando o razão mudou. Ver 0038.';

-- O PostgREST guarda o esquema em cache: sem recarregar, a função nova não é
-- vista (a mesma queda da ordem de deploy invertida — compliance, PR #21, L-7).
notify pgrst, 'reload schema';
