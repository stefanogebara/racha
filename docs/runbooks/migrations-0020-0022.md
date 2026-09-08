# Migrações 0020, 0021 e 0022 — aplicadas em produção antes do deploy do código

**Data:** 2026-09-08 · **Projeto Supabase:** `worttfotxasxqjaqwpjf` (racha, sa-east-1)

As duas foram aplicadas com o banco em produção e o código ainda **não**
publicado. Esta é a ordem segura — esquema primeiro, código depois — e é o
inverso do que quebrou a `append_check_event` na 0018: lá a mudança de
assinatura criou uma sobrecarga e o código velho, que chamava com três
argumentos, passou a receber `42725: function is not unique`. Por isso as duas
migrações abaixo foram medidas **chamando** o que criaram, não lendo o arquivo.

## 0020 — `expire_payment_if_pending(text)`

Claim condicional (inegociável #7): `expirado` só sobrescreve `pendente`, e o
caminho nunca apaga `confirmed_at` nem `psp_payload_masked`.

Fecha o caso em que o `payment_intent.payment_failed` de uma recusa chega
**depois** do `succeeded` da segunda tentativa no mesmo intent — a Stripe não
garante ordem e reenvia o que levou 5xx. O UPDATE cego anterior apagava o
pagamento do faturamento, da gorjeta (base da folha, Lei 13.419) e da série
semanal, e deixava `ledger_drift` crítico permanente.

Verificação medida contra os dados reais, não deduzida:

| o que | resultado |
|---|---|
| assinatura instalada | uma só: `p_txid text`, `security definer` |
| chamada sobre uma linha `confirmado` | `false`, linha intacta, `confirmed_at` preservado |
| chamada sobre txid inexistente | `false` (não estoura) |
| chamada sobre uma linha `pendente`, dentro de `begin … rollback` | `true`, e as contagens voltaram iguais |

Código velho não a chama: ela é nova, e nada mais no esquema depende dela.

## 0021 — reprojeção das linhas de `payments` a partir do razão

**Correção de dados, uma vez.** As colunas `confirmed_*_cents` (0015) e
`refunded_*_cents` (0016) entraram no esquema antes de o código que as escreve
chegar a produção; toda linha gravada nessa janela ficou com o default.

Encontrado e corrigido:

- **1 linha** `devolvido` (`ch_nP9yAPKpF2FKEJM1`) com `refunded_* = 0` enquanto
  o razão registrava um estorno de 500 + 100. Depois: `refunded 500/100`,
  `confirmed 500/100`, status `devolvido` mantido — o estorno é total.
- **18 linhas** `confirmado` sem `confirmed_amount_cents`. Não estavam erradas
  (o `confirmedMoney` cai no registrado quando o confirmado é nulo), mas a
  linha deixou de depender do fallback.

A correção não escolhe número nenhum: recalcula da soma dos eventos, com
`PAYMENT_REFUND_REVERSED` abatendo o estorno. É **idempotente por construção** —
rodar de novo escreve os mesmos valores — e as três instruções são
`update … where` sobre condições que deixam de valer depois da primeira
passada.

Totais antes e depois: 30 pagamentos, `sum(amount_cents) = 95960`. Nenhuma
linha criada ou removida.

## Como repetir a medição

```bash
curl -s -X POST "https://api.supabase.com/v1/projects/worttfotxasxqjaqwpjf/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select count(*) filter (where status='"'"'confirmado'"'"' and confirmed_amount_cents is null) as sem_confirmado, count(*) as total from payments;"}'
```

Esperado hoje: `sem_confirmado = 0`, `total = 30`.

## 0022 — `payment_repair_log`: quem mexeu, no quê, e como era antes

Este arquivo é **mutável**. Nele dá pra *afirmar* o que as linhas eram, não pra
*provar* — e numa discussão trabalhista ou fiscal sobre a base da gorjeta
(Lei 13.419) a diferença entre afirmar e provar é a discussão inteira. LGPD
art. 6º X e art. 37 pedem o registro da operação: quem operou, quando, sobre o
quê.

A tabela guarda uma linha por documento tocado, com `before_row`, `after_row`,
`operator` e `reason`. **Daqui pra frente todo reparo de dados grava a imagem
anterior na MESMA transação da correção.**

O registro da 0021 entrou retroativamente e diz isso na cara: os valores
anteriores são declaração copiada da medição da sessão, não captura automática
— porque a tabela ainda não existia quando ela rodou. Essa lacuna é exatamente
o que a tabela fecha.

| id | migração | txid | antes | depois |
|---|---|---|---|---|
| 1 | 0021 | `ch_nP9yAPKpF2FKEJM1` | `devolvido`, estornado 0/0, confirmado nulo | `devolvido`, estornado 500/100, confirmado 500/100 |
| 2 | 0021 | (agregado: 18 linhas) | `confirmed_*` nulo | preenchido do razão, nada sobrescrito |

### Reaplicação da 0021 (reprojeção completa)

A primeira versão preenchia `confirmed_*` só onde estava **nulo** — e a linha
com valor confirmado **errado** era justamente o caso que importava. Corrigida
pra reprojeção completa (`is distinct from`) e reaplicada: `divergentes = 0`,
30 pagamentos, `sum(amount_cents) = 95960`, um `devolvido`. Rodar de novo não
muda nada, que é o que idempotente quer dizer.

### Aviso que a terceira instrução carrega

O passo 3 da 0021 tira uma linha de `devolvido`, e isso **recoloca a gorjeta
dela em `tipsCents`** de um período possivelmente já fechado — a distribuição
daquele mês foi calculada sobre o número antigo, e os empregados receberam a
menos. Se ele alterar alguma linha, o restaurante precisa ser **avisado**; a
instrução agora tem `returning` pra que o operador veja. Nesta execução não
alterou nada.
