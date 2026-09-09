-- 0029 — o log de reparo passa a dizer QUEM pediu e POR QUE.
--
-- A 0026 poe a imagem anterior no log, e o log grava, pra TODOS os chamadores:
--
--   migration = '0023_repair_payment_row (automatico)'
--   reason    = 'reprojecao da linha a partir do razao, na reentrega de um webhook'
--
-- Sao tres chamadores, e so um deles e uma reentrega de webhook:
--
--   1. `webhook-handler.js` — reentrega do adquirente (o unico que a frase
--      descreve);
--   2. `router.js` — a devolucao fora do trilho, pedida por um DONO logado;
--   3. `reconcile.js` — a varredura noturna, que roda sem ninguem presente.
--
-- E `racha.operator` nao e setado na varredura, entao o `current_user` cai no
-- service role: a procedencia some junto com o motivo.
--
-- Na revisao anterior isto era cosmetico — havia gente presente em dois dos
-- tres caminhos e o terceiro mal existia. O commit que a varredura ganhou fez
-- dela o chamador de MAIOR VOLUME, sem humano nenhum, escrevendo
-- `confirmed_tip_cents` (base da folha, Lei 13.419/2017 + STJ Tema 1102). O
-- log virou o unico registro duravel dessa escrita.
--
-- LGPD art. 37 pede REGISTRO das operacoes de tratamento. Um registro que
-- descreve a operacao errada e prova PIOR que nenhuma numa discussao
-- trabalhista sobre a gorjeta de um periodo (CLT art. 11: cinco anos) ou numa
-- revisao fiscal do fluxo de gorjeta. Achado pela revisao de compliance de
-- 2026-09-09.
--
-- A assinatura ganha `p_source` com DEFAULT: as chamadas antigas seguem
-- valendo e caem em 'desconhecido' — explicito, em vez de uma frase errada.

-- O DROP VEM ANTES DO CREATE, e derruba a assinatura ANTIGA.
--
-- `create or replace` com lista de argumentos diferente cria uma SOBRECARGA:
-- as duas versoes convivem e uma chamada nomeada casa com as duas — `42725:
-- function is not unique`. Aconteceu em producao em 2026-09-08 aplicando a
-- 0018. Sem `p_source` a chamada resolveria pra versao antiga, calada, e o log
-- voltaria a dizer "reentrega de webhook" pra varredura noturna.
--
-- E a ORDEM importa tanto quanto a lista: derrubar depois do create apaga a
-- funcao que a migracao acabou de criar. O censo de `sql-contract.test.js`
-- exige as duas coisas, e pegou este arquivo com o drop no fim.
drop function if exists public.repair_payment_row(
  text, text, integer, integer, text, integer, integer, integer, integer, timestamptz
);

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
  -- Conjunto FECHADO: origem desconhecida nao vira texto livre no log.
  v_motivo := case p_source
    when 'webhook_redelivery'  then 'reprojecao da linha a partir do razao, na reentrega de um webhook'
    when 'owner_offrail_refund' then 'reprojecao apos devolucao registrada FORA do trilho por um dono logado'
    when 'reconciler_sweep'    then 'reprojecao pela varredura noturna de conciliacao, sem operador presente'
    else 'origem nao declarada pelo chamador'
  end;

  -- A MESMA lista branca da 0026: colunas de dinheiro, nunca a linha inteira
  -- (`payer_label` e nome digitado pelo cliente e a tabela e permanente).
  select jsonb_build_object(
           'status', status,
           'confirmed_amount_cents', confirmed_amount_cents,
           'confirmed_tip_cents', confirmed_tip_cents,
           'refunded_amount_cents', refunded_amount_cents,
           'refunded_tip_cents', refunded_tip_cents)
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

-- A 0025 revoga; a assinatura mudou, entao revoga a NOVA. Sem isto a funcao
-- nasce executavel por `public` (default do Postgres) e o claim condicional
-- vira uma escrita de dinheiro aberta.
revoke all on function public.repair_payment_row(
  text, text, integer, integer, text, integer, integer, integer, integer, timestamptz, text
) from public, anon, authenticated;
