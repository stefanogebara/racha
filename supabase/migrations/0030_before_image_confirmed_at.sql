-- 0030 — a imagem ANTERIOR volta a guardar `confirmed_at`.
--
-- A 0026 gravava seis campos na imagem anterior, entre eles `confirmed_at`. A
-- 0029 — a migracao de PROCEDENCIA, escrita justamente pra fortalecer esse
-- registro — reconstruiu o `jsonb_build_object` com cinco. Conserto pela
-- metade: ela melhorou o "quem pediu" e piorou o "o que era antes", em
-- silencio, no mesmo arquivo.
--
-- E a coluna importa mais agora do que quando a 0026 a incluiu. A serie
-- acabou de acrescentar `confirmed_at_missing` como `high`, porque uma linha
-- `confirmado` sem data some do faturamento, da base de gorjeta e da conferencia
-- de destino. Se o reparo mexer nessa coluna (o `coalesce` preenche o nulo), a
-- imagem anterior e' a unica prova de qual era o estado — LGPD art. 37, e CLT
-- art. 11 (cinco anos) numa discussao sobre a gorjeta de um periodo.
--
-- Achado pela revisao de seguranca de 2026-09-09 (LOW-4).
--
-- So o corpo muda; a assinatura e' a mesma da 0029, entao NAO ha `drop` (nao ha
-- sobrecarga a derrubar) e o `revoke` da 0029 segue valendo. `create or replace`
-- com a MESMA lista de argumentos substitui no lugar.

create or replace function public.repair_payment_row(
  p_txid                     text,
  p_expected_status          text,
  p_expected_refunded_amount integer,
  p_expected_refunded_tip    integer,
  p_status                   text,
  p_confirmed_amount         integer,
  p_confirmed_tip            integer,
  p_refunded_amount          integer,
  p_refunded_tip             integer,
  p_confirmed_at             timestamptz default null,
  p_source                   text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      text;
  v_antes   jsonb;
  v_motivo  text;
begin
  v_motivo := case p_source
    when 'webhook_redelivery'   then 'reprojecao da linha a partir do razao, na reentrega de um webhook'
    when 'owner_offrail_refund' then 'reprojecao apos devolucao registrada FORA do trilho por um dono logado'
    when 'reconciler_sweep'     then 'reprojecao pela varredura noturna de conciliacao, sem operador presente'
    else 'origem nao declarada pelo chamador'
  end;

  -- A lista branca da 0026, INTEIRA: colunas de dinheiro mais a data de
  -- confirmacao. Nunca a linha toda — `payer_label` e' nome digitado pelo
  -- cliente e esta tabela e' permanente.
  select jsonb_build_object(
           'status', status,
           'confirmed_amount_cents', confirmed_amount_cents,
           'confirmed_tip_cents', confirmed_tip_cents,
           'refunded_amount_cents', refunded_amount_cents,
           'refunded_tip_cents', refunded_tip_cents,
           'confirmed_at', confirmed_at)
    into v_antes
    from payments where txid = p_txid;

  update payments
     set status                 = p_status,
         confirmed_amount_cents = p_confirmed_amount,
         confirmed_tip_cents    = p_confirmed_tip,
         refunded_amount_cents  = p_refunded_amount,
         refunded_tip_cents     = p_refunded_tip,
         confirmed_at           = coalesce(confirmed_at, p_confirmed_at)
   where txid = p_txid
     and status = p_expected_status
     and coalesce(refunded_amount_cents, 0) = coalesce(p_expected_refunded_amount, 0)
     and coalesce(refunded_tip_cents, 0)    = coalesce(p_expected_refunded_tip, 0)
  returning txid into v_id;

  if v_id is not null then
    insert into payment_repair_log (migration, operator, reason, txid, before_row, after_row)
    values ('0023_repair_payment_row (' || coalesce(p_source, 'desconhecido') || ')',
            coalesce(current_setting('racha.operator', true), current_user),
            v_motivo,
            p_txid,
            v_antes,
            jsonb_build_object(
              'status', p_status,
              'confirmed_amount_cents', p_confirmed_amount,
              'confirmed_tip_cents', p_confirmed_tip,
              'refunded_amount_cents', p_refunded_amount,
              'refunded_tip_cents', p_refunded_tip));
  end if;

  return v_id is not null;
end;
$$;

revoke all on function public.repair_payment_row(
  text, text, integer, integer, text, integer, integer, integer, integer, timestamptz, text
) from public, anon, authenticated;
