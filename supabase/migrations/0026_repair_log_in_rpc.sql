-- 0026 — o reparo AUTOMATICO tambem grava a imagem anterior.
--
-- A 0022 escreveu a politica: "todo reparo de dados grava a imagem ANTERIOR na
-- MESMA transacao". Ela valia pras migracoes rodadas a mao. O
-- `repair_payment_row` (0023) — que roda em TODA reentrega de webhook, muitas
-- vezes por dia, e reescreve `confirmed_tip_cents`, a base da folha — nao
-- gravava nada.
--
-- Ou seja: a politica cobria o caminho raro e deixava de fora o frequente. Numa
-- discussao trabalhista sobre a gorjeta de um periodo, o que se pode PROVAR era
-- justo o que quase nunca acontece. LGPD art. 37 (registro das operacoes).
-- Achado pela revisao de compliance de 2026-09-08.
--
-- Duas mudancas, e a segunda e a que importa: a imagem e uma LISTA BRANCA de
-- colunas de dinheiro. `to_jsonb(p)` levaria `payer_label` — nome que o cliente
-- digitou — pra uma tabela feita pra ser permanente, e a proxima coluna que
-- `payments` ganhar entraria sozinha. Um log de reparo precisa das colunas de
-- dinheiro, nao da linha.

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
  p_confirmed_at             timestamptz default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
  v_antes jsonb;
begin
  -- A imagem ANTERIOR, antes de escrever, e so das linhas que a guarda de
  -- versao vai mesmo tocar (o mesmo `where` do update).
  select jsonb_build_object(
           'status', status,
           'confirmed_amount_cents', confirmed_amount_cents,
           'confirmed_tip_cents', confirmed_tip_cents,
           'refunded_amount_cents', refunded_amount_cents,
           'refunded_tip_cents', refunded_tip_cents,
           'confirmed_at', confirmed_at)
    into v_antes
    from payments
   where txid = p_txid
     and status = p_expected_status
     and coalesce(refunded_amount_cents, 0) = coalesce(p_expected_refunded_amount, 0)
     and coalesce(refunded_tip_cents, 0)    = coalesce(p_expected_refunded_tip, 0);

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
    values ('0023_repair_payment_row (automatico)',
            coalesce(current_setting('racha.operator', true), current_user),
            'reprojecao da linha a partir do razao, na reentrega de um webhook',
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

revoke all on function public.repair_payment_row(text, text, integer, integer, text, integer, integer, integer, integer, timestamptz) from public, anon, authenticated;

-- E a 0022 tinha `after_row = to_jsonb(p) - 'psp_payload_masked'` no registro
-- retroativo: denylist de um campo, guardando `payer_label`. Ja aplicado em
-- producao, entao a correcao e no dado, nao so no arquivo.
update public.payment_repair_log
   set after_row = after_row
     - 'payer_label' - 'psp_payload_masked' - 'payer_document' - 'pos_ref'
 where after_row is not null;
