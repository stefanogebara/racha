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

## 0023, 0024, 0025 — aplicadas em 2026-09-08, e o que foi medido de fato

| migração | o que é | medição |
|---|---|---|
| **0023** `repair_payment_row` | claim condicional: reprojeta a linha de `payments` do razão **só se ela ainda estiver no estado lido** (versão otimista sobre `status` + os dois acumulados estornados) | assinatura conferida no `pg_proc`; chamada com um `p_expected_status` que não existe devolveu `false` sobre uma linha real. **Só o RPC foi exercitado, não o chamador** — e era no chamador que estava o defeito: `getPayment` não trazia as colunas estornadas, então a guarda recebia `0` sempre e passava apenas na linha virgem. Corrigido, com censo de SELECT (`sql-contract.test.js`) |
| **0024** `orphan_money_events` | casa durável pro evento de dinheiro que não acha conta; idempotente por `psp_event_id`; lida pela conciliação diária, que fica `high` com fila aberta | tabela e índice conferidos; o caminho é exercitado em teste (memória) |
| **0025** revokes | `revoke all … from anon, authenticated` nas duas tabelas novas — todas as anteriores fazem isso junto com o RLS | `information_schema.role_table_grants` devolve **vazio** pra `anon` e `authenticated` nas duas |

### A distinção que custou um achado

Medir o **RPC** não é medir o **caminho**. A 0023 respondia certo a toda
pergunta que eu fiz no banco, e estava inerte na produção porque quem a chamava
mandava zeros. A lição repete a da 0018: o defeito vive na fronteira entre JS e
SQL, e só um teste que atravessa a fronteira o vê.

## RESPONDIDA: onde fica o excedente de um Pix pago a mais (inegociável #4)

> Ver `custodia-do-excedente.md`. Em resumo: a conferência entrou no produto
> como TERCEIRA PERNA da conciliação — os recebíveis do adquirente, que dizem
> pra quem o dinheiro de cada cobrança foi. Um recebível de crédito fora da
> subconta da casa é `custody_leak`, crítico, todas as noites. E o pagador de um
> Pix dinâmico não escolhe o valor, o que estreita a exposição pro trilho de
> boleto, que não usamos. O texto abaixo é o registro de como a pergunta estava
> antes disso.

## (histórico) A pergunta, como estava em aberto

**Não medido, e é a única coisa neste lote que toca a regra de custódia.**

A `order` do Pagar.me leva `split: [{ recipient_id, amount: total, type: 'flat' }]`,
onde `total` é o valor **pedido**. Desde que `overpaid` passou a ser dinheiro
recebido, o valor capturado pode ser **maior** que a soma das regras de split —
e quem decide onde ficam esses centavos é a Pagar.me, não nós.

Se ficarem no saldo da Racha, é conta-bolsão: exatamente o que o inegociável #4
proíbe, e a tela do cliente estaria dizendo que **o restaurante** deve o valor
que na verdade está com a plataforma.

**A prova a fazer, antes de qualquer venue real ver isto:** em sandbox, criar
uma cobrança com split flat, pagá-la a mais, e ler `GET /charges/{id}` e o saldo
do recebedor — registrando aqui de quem é o saldo que ficou com a diferença. Se
for nosso, a regra de split precisa virar percentual (ou ganhar transferência
posterior), e pelo inegociável #4 **isso é pergunta pra assessoria de pagamentos
antes de ser mudança de código**.
