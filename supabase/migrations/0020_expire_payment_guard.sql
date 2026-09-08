-- 0020 — expirar uma cobranca so enquanto ela ainda esta PENDENTE.
--
-- O buraco: a rota do `payment_intent.payment_failed` fazia
--
--     recordPayment({ status: 'expirado', pspPayloadMasked: null, confirmedAt: null })
--
-- que o store executa como um UPDATE cego por txid — sem olhar o estado atual
-- da linha, e escrevendo NULL por cima da data e do payload.
--
-- A Stripe nao garante ordem de entrega, e reenvia por conta propria o que
-- levou 5xx. Entao a sequencia real e possivel: o pagador recusa no app do
-- banco (`payment_failed`), tenta de novo no MESMO PaymentIntent e passa
-- (`succeeded`), e a entrega do primeiro evento chega DEPOIS. A linha
-- confirmada virava `expirado` com `confirmed_at` nulo: o pagamento sumia do
-- faturamento do dia E da gorjeta (base da folha, Lei 13.419), e sumia da
-- serie semanal, que agrupa por essa data. O razao continuava dizendo que
-- pagou — entao a conciliacao gritava `ledger_drift` critico pra sempre, ate
-- alguem consertar na mao.
--
-- A regra e uma so, e por isso e uma claim CONDICIONAL, no banco, dentro da
-- transacao: `expirado` so pisa em `pendente`. Um pagamento confirmado, ja
-- devolvido, ou ja expirado nao se mexe. E `confirmed_at` e
-- `psp_payload_masked` nunca sao apagados por este caminho.
--
-- Inegociavel #7: claim condicional vai em RPC com o erro CONFERIDO — nunca um
-- UPDATE + filtro do PostgREST. E o retorno diz o que aconteceu, pra quem
-- chama nao ter que adivinhar: `true` = expirou agora, `false` = a linha
-- estava em outro estado (ou nao existe) e foi deixada em paz.
--
-- Achado pela revisao de seguranca de 2026-09-08.

create or replace function public.expire_payment_if_pending(p_txid text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  update payments
     set status = 'expirado'
   where txid = p_txid
     and status = 'pendente'
  returning txid into v_id;

  return v_id is not null;
end;
$$;

revoke all on function public.expire_payment_if_pending(text) from public, anon, authenticated;

comment on function public.expire_payment_if_pending(text) is
  'Expira uma cobranca SO enquanto pendente. Nunca apaga confirmed_at nem psp_payload_masked. Ver 0020.';
