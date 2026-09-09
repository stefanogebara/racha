# A linha de pagamento ficou atrás do razão

Quem chega aqui: o alerta noturno trouxe um destes códigos.

| código | o que quer dizer | escreveu? |
|---|---|---|
| `payment_row_repaired` | a varredura reprojetou a linha | **sim** |
| `payment_tip_base_repaired` | idem, e mexeu na **base da folha** | **sim** |
| `payment_repair_ack_lost` | o banco não respondeu | **não se sabe** — resolva abaixo |
| `payment_row_repair_rejected` | o banco recusou (SQLSTATE) | **não** |
| `payment_row_repair_raced` | outro caminho projetou antes | **não** (e nem precisava) |
| `payment_rows_unrepaired` | prazo ou teto da varredura | **não olhou** |
| `status_lag`, `ledger_drift` em linha `devolvido` | fora do escopo do reparo | **não**, e não vai |
| `confirmed_at_missing` | linha confirmada sem data | **não**, e não vai |

## 1. "Não se sabe" tem resposta exata

`payment_repair_ack_lost` diz que a chamada não voltou. Não quer dizer que não
escreveu — pode ter dado commit e a resposta ter se perdido.

**A dúvida é resolvível, e o oráculo é perfeito.** O `insert` no
`payment_repair_log` está DENTRO da `repair_payment_row`, condicionado a
`v_id is not null`, na mesma transação do `update`. Logo: **existe linha no log
se e somente se a escrita foi commitada.**

```sql
select txid, at, migration, reason, before_row, after_row
  from payment_repair_log
 where txid in ('ch_...', 'ch_...')     -- os txids do achado
   and at > now() - interval '2 days'
 order by at desc;
```

- **Voltou linha** → escreveu. `before_row` diz como estava, `after_row` como
  ficou, `migration` diz qual caminho pediu (`reconciler_sweep`,
  `webhook_redelivery`, `owner_offrail_refund`).
- **Não voltou nada** → não escreveu. A projeção segue atrás; a varredura da
  noite seguinte tenta de novo.

**Vale pro `payment_row_repair_rejected` também.** Ele afirma que nada foi
escrito, e a afirmação é sólida: o código só vira recusa quando está numa LISTA
DE PERMISSÃO de classes cujo significado é rollback determinístico — `22`, `23`,
`25`, `42`, `53`, `55`, `P0`, mais `40001` e `40P01` e `57014`.

Todo o resto cai em `payment_repair_ack_lost` de propósito, e "todo o resto" é
maior do que parece: inclui `08*` e `57P0*` e `XX*` (o servidor respondeu PORQUE
morreu), mas também `40003 statement_completion_unknown` — o código que
literalmente quer dizer "não sei se completou" —, `58030 io_error`, e qualquer
coisa que um pooler futuro invente. Um código legítimo caindo aí custa uma
consulta; o contrário custa distribuição a mais.

Em qualquer dúvida, a consulta acima é o árbitro, e ela custa nada.

> Se esta consulta parar de responder a pergunta — porque alguém mexeu na
> `repair_payment_row` — o censo `INVARIANTES` em `sql-contract.test.js` quebra
> antes de a migração entrar. Ele existe por causa deste parágrafo.

## 2. Se mexeu na gorjeta, antes de fechar a folha

`payment_tip_base_repaired`, `payment_repair_ack_lost` **e
`payment_row_repair_rejected`** carregam `tipDeltaCents` e `periods`.

O `rejected` é o mais forte dos três: ali a linha está **provadamente** atrás do
razão, ou seja, a base da folha exibida está **acima** da verdadeira. É a direção
que o CLT art. 462 não deixa desfazer, e por isso ele estava na seção errada — a
mais certa das três era a única que não vinha pra cá.

**A dúvida é de um lado só.** O reparo só entra numa linha **atrás** do razão nas
pernas de estorno, então ele só pode **aumentar** `refunded_tip_cents` — ou seja,
só pode **diminuir** a base da folha. Nunca é "subiu ou desceu": é "o número
exibido já alcançou ou não".

**Distribua pelo valor do RAZÃO, que é o menor.** Os dois erros não são
simétricos:

- distribuir pelo número antigo (maior) e estar errado = distribuição a mais, e
  a **CLT art. 462** proíbe descontar do salário depois. O dinheiro foi.
- distribuir pelo do razão (menor) e estar errado = conserta com um complemento
  no período seguinte.

Não adie a folha por causa disto: a **CLT art. 459 § 1º** fixa o pagamento até o
5º dia útil do mês seguinte, e a gorjeta vai junto. O achado é `high` pra acordar
alguém, não pra travar o fechamento.

## 3. Os dois casos que o reparo NÃO conserta — de propósito

O reparo escreve **só** as duas colunas de estorno, e só quando `status` e os
dois `confirmed_*` já batem com o razão. Fora disso ele não toca, e o achado
fica. São dois:

### `devolvido` com `refunded_*` atrasado

O razão diz que devolveu e a linha ainda marca zero. Virar `status` aqui é
**rebaixamento** — devolveria a gorjeta estornada pra base da folha.

### Linha nunca projetada (`confirmed_*` nulo)

É a população que a **migração 0021 exclui à mão** (`and
p.confirmed_amount_cents is not null`). Copie dela a conduta, porque ela já
resolveu esta pergunta uma vez:

> `status devolvido -> confirmado ... REVER A FOLHA do periodo`
> `o restaurante PRECISA ser avisado; nao basta a linha mudar`

Ou seja: **não é só rodar um `update`.** Avisar a casa faz parte do conserto,
porque o número que ela levou pra folha pode mudar. Lei 13.419/2017
(CLT art. 457 §§) põe o dever de escrituração por período nela, não em nós.

Conserto, quando for o caso: `repair_payment_row` com `p_source =
'owner_offrail_refund'` e `racha.operator` setado, pra que o log diga quem foi.
Nunca um `update` cru — ele não grava imagem anterior (migração 0022/0026/0030).

## 4. O que NÃO fazer

- **Não** rodar `/api/cron/reconcile` sem `?dry=1` pra "só dar uma olhada". Com
  `dry=1` ele não escreve; sem, escreve.
- **Não** reprojetar linha à FRENTE do razão. Linha adiante quer dizer que o
  razão perdeu um evento, e reprojetar apaga a evidência de que houve dinheiro.
- **Não** tratar `payment_row_repair_raced` como problema. Quem venceu a corrida
  sabia mais.
