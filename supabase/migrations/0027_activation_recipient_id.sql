-- 0027 — o RECEBEDOR entra no funil, porque a perna de custódia depende dele.
--
-- `venue_activation_stats` devolvia `recebedor_ok` (booleano) e nao o
-- `psp_recipient_id`. A terceira perna da conciliacao (`reconcilePayablesLeg`)
-- le `venue.pspRecipientId` pra saber CONTRA QUEM comparar os recebiveis do
-- adquirente — e recebia `undefined`.
--
-- O efeito em producao: a varredura noturna pagava uma chamada de API por
-- cobranca, comparava todo recebivel contra `null`, devolvia
-- `payables_no_recipient` ALTO, e `custody_leak` — o achado que responde a
-- pergunta de custodia do inegociavel #4 — era inalcancavel. Toda casa com
-- cobranca confirmada nas ultimas 24h ficava vermelha, toda noite, pra sempre:
-- um alerta que dispara em comportamento correto morre em duas semanas, e a
-- guarda que importa nunca dispara.
--
-- Meu teste inventava o campo (`pspRecipientId` num store escrito a mao) e o
-- teste de encanamento conferia os TRES parametros de que eu tinha lembrado.
-- Achado pela revisao de compliance de 2026-09-08.
--
-- `create or replace` NAO troca o tipo de retorno de uma funcao `returns
-- table`, entao o drop e obrigatorio — e o censo da 0018 exige que ele case a
-- assinatura antiga e venha ANTES do create, que e o que esta feito aqui.

drop function if exists public.venue_activation_stats();

create or replace function public.venue_activation_stats()
returns table (
  id uuid,
  name text,
  created_at timestamptz,
  /**
   * `is_test` — E A LIÇÃO DE COMO ELE QUASE MORREU AQUI.
   *
   * A producao TINHA esta coluna; o arquivo da 0011 nao. O arquivo havia
   * derivado da producao em algum momento, e eu reescrevi a funcao a partir do
   * ARQUIVO — apagando a coluna. Efeito: `isTest` viraria sempre false e as
   * casas de TESTE entrariam no relatorio noturno, que e exatamente o que o
   * codigo diz que evita ("um alerta que dispara toda noite por causa de dado
   * de teste e um alerta que ninguem le no terceiro dia").
   *
   * E a mesma forma do incidente da 0018: `create or replace` a partir de uma
   * versao antiga apaga em silencio o que veio depois. La foi um bloco de
   * corpo; aqui, uma coluna do tipo de retorno. Pego pelo censo que eu estava
   * escrevendo pra outro defeito, no mesmo minuto.
   */
  is_test boolean,
  recebedor_ok boolean,
  -- O ID do recebedor, nao so o booleano: a perna de custodia compara os
  -- recebiveis do adquirente contra ELE. `recebedor_ok` continua porque o
  -- radar de ativacao usa (e um booleano nao serve pra comparar).
  psp_recipient_id text,
  psp_recipient_status text,
  mesas_reais bigint,
  mesas_total bigint,
  contas bigint,
  pagos_confirmados bigint,
  valor_cents bigint,
  ultimo_pagamento timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.name,
    v.created_at,
    coalesce(v.is_test, false) as is_test,
    coalesce(
      v.psp_recipient_id ~ '^r[ep]_'
        and coalesce(v.psp_recipient_status, '') not in ('refused', 'suspended', 'blocked'),
      false) as recebedor_ok,
    v.psp_recipient_id,
    v.psp_recipient_status,
    count(distinct t.id) filter (where t.active and not coalesce(t.training, false)) as mesas_reais,
    count(distinct t.id) as mesas_total,
    count(distinct c.id) as contas,
    count(distinct p.id) filter (where p.status = 'confirmado') as pagos_confirmados,
    coalesce(sum(p.amount_cents) filter (where p.status = 'confirmado'), 0)::bigint as valor_cents,
    max(p.created_at) filter (where p.status = 'confirmado') as ultimo_pagamento
  from public.venues v
  left join public.venue_tables t on t.venue_id = v.id
  left join public.checks c on c.table_id = t.id
  left join public.payments p on p.check_id = c.id
  group by v.id, v.name, v.created_at, v.is_test, v.psp_recipient_id, v.psp_recipient_status;
$$;

revoke all on function public.venue_activation_stats() from public, anon, authenticated;
