-- 0037 — ABRIR A CONTA É UMA TRANSAÇÃO SÓ: a linha em `checks` e o `OPENED`.
--
-- O `openCheck` do store gravava a linha em `checks` e, noutra ida ao banco, o
-- `OPENED` pelo `append_check_event`. Entre as duas, a conta existia com o razão
-- vazio (`reduce([])` é nulo); e se a função morresse no meio — timeout, deploy,
-- erro transitório na segunda ida — a linha ficava ÓRFÃ pra sempre: o índice
-- `checks_one_open_per_table` a conta como aberta, a mesa responde 409 a toda
-- conta nova, e a mesa morre até alguém rodar SQL à mão. Medido pela revisão de
-- segurança num Postgres com as 36 migrações; o PR #16 pôs o alarme
-- (`[conta-sem-opened]`, achado `critical` na conciliação) e deixou o conserto
-- pra cá. Inegociável #7: condição de banco por RPC atômica, com o erro CHECADO.
--
-- NÃO REESCREVE O CORPO do `append_check_event`: delega, como a 0034 — a 0018
-- conta o que custou reescrever um corpo a partir de uma versão velha. Na mesma
-- transação, a trava consultiva do append é reentrante e o `OPENED` entra com
-- `seq` 1, com o cache de status que o append mantém.
--
-- O 409 da mesa já aberta continua vindo do índice (23505), agora pelo CÓDIGO
-- — o store decidia por regex sobre a mensagem (compliance, PR #16, L-3).
-- A versão de rascunho desta migração tinha outra assinatura (venue explícito,
-- total int). `create or replace` com assinatura diferente CRIA outra função em
-- vez de trocar — duas sobrecargas, e o PostgREST responderia PGRST203
-- (ambígua) a toda abertura (segurança, PR #21, M-3). Nunca foi aplicada em
-- produção; o `drop` garante o mesmo em qualquer banco onde tenha sido.
drop function if exists public.open_check(uuid, uuid, integer, text);
drop function if exists public.open_check(uuid, uuid, bigint, text);

create or replace function public.open_check(
  p_table_id uuid,
  p_total_cents bigint,   -- a coluna é bigint (0001); o parâmetro não pode ser mais estreito
  p_pos_ref text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_venue_id uuid;
begin
  -- A CASA sai da MESA, aqui dentro — não é parâmetro. Recebida de fora, uma
  -- chamada com a casa C e a mesa da casa A criava conta de C na mesa de A; e
  -- mesa nula passava pelo índice de uma aberta por mesa (segurança, PR #21,
  -- LOW-3). Só o service_role executa isto, mas a função não confia no chamador.
  select venue_id into v_venue_id from venue_tables where id = p_table_id;
  if v_venue_id is null then
    raise exception 'open_check: mesa desconhecida' using errcode = '22023';
  end if;

  -- Zero também não: o serviço já recusa conta zerada, e a função não pode ser
  -- a porta que aceita o que o serviço recusa.
  if p_total_cents is null or p_total_cents <= 0 then
    raise exception 'open_check: total inválido' using errcode = '22023';
  end if;

  insert into checks (venue_id, table_id, total_cents, pos_ref)
    values (v_venue_id, p_table_id, p_total_cents, p_pos_ref)
    returning id into v_id;

  -- Se isto lançar, a linha de cima some junto: é o ponto inteiro da função.
  perform public.append_check_event(v_id, 'OPENED', jsonb_build_object('totalCents', p_total_cents), null);

  return v_id;
end;
$$;

revoke all on function public.open_check(uuid, bigint, text) from public, anon, authenticated;

comment on function public.open_check(uuid, bigint, text) is
  'Abre a conta: a linha em checks e o OPENED na mesma transação. 23505 quando a mesa já tem conta aberta (checks_one_open_per_table). Ver 0037.';

-- O PostgREST guarda o esquema em cache: sem recarregar, a função nova não é
-- vista, e o código que a chama cai como se ela não existisse — a mesma queda
-- da ordem de deploy invertida (compliance, PR #21, L-7).
notify pgrst, 'reload schema';
