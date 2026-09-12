-- 0031 — retenção. Fecha a lacuna 1 do docs/compliance/data-map.md: ate hoje
-- nada expirava e nada apagava.
--
-- ANONIMIZA, nao apaga. O razao e event-sourced e imutavel por principio;
-- apagar um pagamento destruiria a contabilidade da casa. O que sai e o dado
-- PESSOAL, nao o fato de que houve um pagamento. `payer_label` vira null e o
-- valor continua la.
--
-- Os prazos e o porque de cada um estao em docs/compliance/retencao.md. Em
-- resumo: 90 dias depois de a conta FECHAR pro nome livre do pagador, 90 dias
-- depois de zerada e inativa pra carteira da casa, 90 dias pro contador de
-- aberturas (o portao de adocao olha 8 semanas).
--
-- Devolve a CONTAGEM por categoria porque zero por muitos dias seguidos e sinal
-- de que a funcao parou de rodar, nao de que nao havia o que apagar. Mesmo
-- raciocinio do canario vermelho que nunca dispara.

-- O telefone da carteira e `not null` desde a 0005, e anonimizar exige poder
-- esvazia-lo. O CHECK do formato continua valendo pra valor presente (`null ~
-- '...'` e NULL, entao o CHECK nao dispara), e o UNIQUE (venue_id, phone)
-- aceita varios nulos no Postgres — carteiras mortas nao colidem entre si.
alter table public.house_accounts alter column phone drop not null;

create or replace function public.purge_expired_personal_data(
  p_label_days integer default 90,
  p_wallet_days integer default 90,
  p_views_days integer default 90
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_labels integer := 0;
  v_hints integer := 0;
  v_extra integer := 0;
  v_wallets integer := 0;
  v_views integer := 0;
begin
  -- Guarda de sanidade: um prazo pequeno demais apagaria dado vivo. A funcao
  -- roda por cron e um parametro errado nao pode ser silencioso.
  -- `is null` PRIMEIRO: com NULL a comparacao e NULL (nao TRUE), o `raise` nao
  -- dispara, e `make_interval(days => null)` deixa todo predicado NULL — a
  -- funcao devolveria zeros reportando sucesso. Um job que "roda" e nao faz
  -- nada e pior que um job que falha.
  if p_label_days is null or p_wallet_days is null or p_views_days is null
     or p_label_days < 30 or p_wallet_days < 30 or p_views_days < 7 then
    raise exception 'purge_expired_personal_data: prazo curto demais (% % %)',
      p_label_days, p_wallet_days, p_views_days
      using errcode = '22023';
  end if;

  -- 1. O nome livre do pagador, em conta JA FECHADA ha mais de N dias.
  --    Conta aberta nunca entra: o painel ainda mostra quem pagou o que.
  update public.payments p
     set payer_label = null,
         updated_at = now()
    from public.checks c
   where p.check_id = c.id
     and p.payer_label is not null
     and c.status = 'fechada'
     and c.closed_at is not null
     and c.closed_at < now() - make_interval(days => p_label_days);
  get diagnostics v_labels = row_count;

  -- 1a. O TETO ABSOLUTO. O predicado de cima depende de a conta ter sido
  -- FECHADA, e fechar e acao humana: uma casa que abandona o piloto na semana 8
  -- deixa as ultimas contas abertas e todo nome nelas ficaria pra sempre. Aqui
  -- o prazo corre do pagamento, independente do estado da conta.
  update public.payments p
     set payer_label = null,
         updated_at = now()
   where p.payer_label is not null
     and p.created_at < now() - make_interval(days => p_label_days * 2);
  get diagnostics v_extra = row_count;
  v_labels := v_labels + v_extra;

  -- 1b. Os RASTROS DO PAGADOR que a versao antiga do `maskPixPayload` gravou.
  --
  -- O ramo que descia em `raw.pagador` foi apagado do codigo em 2026-09-10 —
  -- mas apagar quem ESCREVE nao apaga o que ja foi ESCRITO. As linhas
  -- anteriores ainda tem `payer_hint` (primeiro nome inteiro + inicial do
  -- sobrenome) e `payer_doc_hint` (dois ultimos digitos do CPF), e herdavam a
  -- vida de 5 anos da linha de pagamento. Achado pela revisao de compliance.
  --
  -- Sem prazo: isto nao devia estar ali em nenhum momento, entao sai de toda
  -- linha, nao das antigas. Depois do primeiro expurgo a contagem fica zero
  -- pra sempre, que e o estado certo.
  update public.payments
     set psp_payload_masked = psp_payload_masked - 'payer_hint' - 'payer_doc_hint',
         updated_at = now()
   where psp_payload_masked ?| array['payer_hint', 'payer_doc_hint'];
  get diagnostics v_hints = row_count;

  -- 2. Carteira da casa morta.
  --
  -- A PRIMEIRA VERSAO DESTE PREDICADO NUNCA PODIA RODAR. Ela exigia
  -- `active = false`, e `setHouseAccountActive` existe nos dois stores com
  -- exatamente um chamador no repositorio inteiro: um teste. Nenhuma rota,
  -- nenhuma tela. A coluna nasce `true` e nada a vira. Entao o telefone — a
  -- coisa mais identificavel que um cliente entrega a este produto — ficava
  -- pra sempre, que e exatamente a falha do art. 6 I/III que esta migracao diz
  -- fechar. Os dois portoes acharam isso separadamente.
  --
  -- A licao ja esta escrita no `docs/decisions/2026-09-10-frase-escrita-do-guarda-que-eu-olhava.md`:
  -- "eles talvez voltem" nao e prazo, e um predicado cuja satisfatibilidade
  -- depende de feature nao implementada e uma frase, nao um guarda.
  --
  -- Agora a chave e INATIVIDADE OBSERVAVEL: sem saldo, sem bonus vivo, e sem
  -- evento nenhum na carteira ha N dias. `active = false` continua valendo como
  -- gatilho ADICIONAL pro dia em que alguem construir o desligamento.
  update public.house_accounts a
     set phone = null, name = '—', updated_at = now()
   where a.phone is not null
     and a.principal_cents = 0
     -- Bonus vivo e dinheiro que a pessoa ainda pode gastar.
     and not exists (
       select 1 from public.house_bonus_lots l
        where l.account_id = a.id
          and l.remaining_cents > 0
          and l.expires_at > now()
     )
     and not exists (
       select 1 from public.house_account_events e
        where e.account_id = a.id
          and e.created_at >= now() - make_interval(days => p_wallet_days)
     )
     and a.updated_at < now() - make_interval(days => p_wallet_days);
  get diagnostics v_wallets = row_count;

  -- 3. O contador de aberturas. Sem dado pessoal, mas guardar linha crua alem
  --    da janela que o portao de adocao olha e guardar por guardar.
  delete from public.check_views
   where at < now() - make_interval(days => p_views_days);
  get diagnostics v_views = row_count;

  return jsonb_build_object(
    'payer_labels', v_labels,
    'payer_hints', v_hints,
    'house_accounts', v_wallets,
    'check_views', v_views
  );
end;
$$;

-- ── O PEDIDO DO TITULAR (art. 18 IV) ──────────────────────────────────────
--
-- O prazo de 90 dias e o PADRAO, nao a resposta a um titular: quem pede
-- exclusao tem direito a ela AGORA, nao no dia 90. Ate aqui o caminho manual
-- era SQL ad-hoc contra producao com a service role — sem log, sem revisao, a
-- uma clausula WHERE de distancia de zerar `payer_label` da tabela inteira.
--
-- Isto e o instrumento limitado: apaga o nome de UM pagamento, pelo txid, e
-- devolve quantas linhas tocou (0 ou 1) pra quem executou poder registrar a
-- resposta que o art. 18 §4 exige. Nao apaga a linha — ver o cabecalho.
create or replace function public.erase_payment_label(p_txid text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer := 0;
begin
  if p_txid is null or length(p_txid) < 4 then
    raise exception 'erase_payment_label: txid obrigatorio' using errcode = '22023';
  end if;
  update public.payments
     set payer_label = null, updated_at = now()
   where txid = p_txid;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.erase_payment_label(text) from public, anon, authenticated;

comment on function public.erase_payment_label(text) is
  'Pedido do titular (LGPD art. 18 IV): apaga o nome livre de UM pagamento, agora. Ver docs/compliance/retencao.md.';

revoke all on function public.purge_expired_personal_data(integer, integer, integer)
  from public, anon, authenticated;

comment on function public.purge_expired_personal_data(integer, integer, integer) is
  'Retencao (LGPD art. 6 I/III). Anonimiza em vez de apagar: o razao e imutavel. Ver docs/compliance/retencao.md.';
