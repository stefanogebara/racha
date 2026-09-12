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
  v_wallets integer := 0;
  v_views integer := 0;
begin
  -- Guarda de sanidade: um prazo pequeno demais apagaria dado vivo. A funcao
  -- roda por cron e um parametro errado nao pode ser silencioso.
  if p_label_days < 30 or p_wallet_days < 30 or p_views_days < 7 then
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

  -- 2. Carteira da casa morta: sem saldo, inativa, e parada ha mais de N dias.
  --    `active = false` e explicito — carteira com saldo zero mas ativa e de
  --    alguem que so nao voltou ainda.
  update public.house_accounts
     set phone = null, name = '—', updated_at = now()
   where phone is not null
     and active = false
     and principal_cents = 0
     and updated_at < now() - make_interval(days => p_wallet_days);
  get diagnostics v_wallets = row_count;

  -- 3. O contador de aberturas. Sem dado pessoal, mas guardar linha crua alem
  --    da janela que o portao de adocao olha e guardar por guardar.
  delete from public.check_views
   where at < now() - make_interval(days => p_views_days);
  get diagnostics v_views = row_count;

  return jsonb_build_object(
    'payer_labels', v_labels,
    'house_accounts', v_wallets,
    'check_views', v_views
  );
end;
$$;

revoke all on function public.purge_expired_personal_data(integer, integer, integer)
  from public, anon, authenticated;

comment on function public.purge_expired_personal_data(integer, integer, integer) is
  'Retencao (LGPD art. 6 I/III). Anonimiza em vez de apagar: o razao e imutavel. Ver docs/compliance/retencao.md.';
