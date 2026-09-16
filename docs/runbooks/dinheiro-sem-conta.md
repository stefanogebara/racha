# Dinheiro que entrou e não achou conta (`money_without_check`)

**Quem lê isto:** quem recebe o aviso diário do fundador e vê a linha
`N evento(s) de dinheiro SEM conta correspondente`, ou quem abre
`orphan_money_events` e encontra uma linha com `kind = 'money_without_check'`.

## O que aconteceu

O adquirente confirmou um pagamento para um `txid` que **não tem linha em
`payments`**. O caso que produz isso quase sempre é o cartão:

`createWalletCharge` (Google Pay, Pagar.me) **captura o cartão dentro da
chamada** — o dinheiro sai ali. A linha de `payments` é escrita logo depois. Se
essa escrita falha (o banco tem prazo de 10 s), o dinheiro saiu e o nosso lado
ficou sem onde pendurá-lo. A cobrança serviço tenta escrever duas vezes antes de
desistir, então uma linha aqui quer dizer que as duas falharam.

**O dinheiro não está perdido, e não está com a gente.** Ele foi para a
subconta do restaurante pelas regras de split, como qualquer outra cobrança
(inegociável #4 — a Racha não retém). O que falta é o registro.

O cliente, nesse momento, viu uma tela dizendo que o cartão **pode** ter sido
cobrado e que não pague de novo — e o botão dele ficou desarmado.

## Como achar a conta

A linha do órfão carrega `payload.orderCode`. Ele é o `code` do pedido que a
Racha mandou pro adquirente, e tem esta forma:

```
<checkId>:<paidCents no momento>:<amountCents>:<tipCents>
```

O primeiro campo é o **id da conta**. Ou seja: o órfão sabe de que mesa veio,
mesmo quando a linha de pagamento não existe.

```sql
select id, at, txid, amount_cents, payload->>'orderCode' as order_code
from public.orphan_money_events
where kind = 'money_without_check' and resolved_at is null
order by at desc;
```

Se `orderCode` estiver nulo (adquirente que não devolve o pedido, ou evento
antigo), o caminho é o painel do adquirente: procure o `txid` e leia o `code` do
pedido lá.

## O que fazer

1. **Confira no adquirente que o dinheiro entrou mesmo.** `txid` é o id da
   cobrança (`ch_…` na Pagar.me). Confirme valor e status.
2. **Abra a conta** (`checkId` do `orderCode`) e veja o estado dela. Duas
   situações:
   - **A conta já foi paga por outro caminho** (a pessoa pagou por Pix depois,
     ou no caixa). Então há dinheiro a mais: siga
     [`devolver-dinheiro-a-mais.md`](devolver-dinheiro-a-mais.md) — a obrigação
     é do Código Civil art. 876 e não espera o cliente pedir.
   - **A conta continua devendo** o valor que esse cartão cobriu. O dinheiro é
     legítimo e só falta o registro.
3. **Registre.** Hoje isso é manual e é o buraco conhecido deste procedimento
   (ver abaixo): não existe rota que ressuscite a linha a partir do órfão. O que
   existe é o razão — o evento de pagamento pode ser lançado pela conciliação
   quando a linha for recriada, e recriar a linha é operação de banco.
4. **Feche o órfão** com quem resolveu e o que foi feito:

   ```sql
   update public.orphan_money_events
      set resolved_at = now(), resolved_by = '<voce>', note = '<o que foi feito>'
    where id = <id>;
   ```

## O que este procedimento ainda NÃO tem

**Um caminho automático de volta.** O órfão é registrado, contado e relatado,
e carrega o endereço da conta — mas reconstruir a linha de `payments` a partir
dele é trabalho manual de banco. Enquanto a carteira não estiver no ar numa casa
de verdade, isso é aceitável; no dia em que estiver, a fila é:

1. **Autorizar e capturar em dois tempos** (`capture: false` → escreve a linha →
   captura). Inverte a janela: o pior caso passa a ser uma autorização não
   capturada, que expira sozinha e não tira dinheiro de ninguém. É o conserto
   estrutural, e está descrito em
   [`docs/decisions/2026-09-16-capturar-antes-de-gravar.md`](../decisions/2026-09-16-capturar-antes-de-gravar.md).
2. Uma rota de reparo que recrie a linha a partir do órfão, com as duas
   assinaturas de revisão que qualquer código de dinheiro precisa.

## Por que não é um 409

Antes, um webhook para um `txid` desconhecido era recusado com 409. O comentário
que defendia isso dizia "never 200 an unknown money event — that is how funds
disappear from ledgers", e a frase está certa: a conclusão é que estava errada.
Um 409 **não guarda nada** — o adquirente reenvia algumas vezes, desiste, e a
única notícia que o mundo nos dava do dinheiro capturado sumia. Registrar e
então responder 200 é o que faz a frase valer.
