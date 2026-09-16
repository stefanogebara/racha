# Capturar o cartão antes de gravar a linha — o que ficou e o que não ficou

**Decisão:** o dano ao cliente foi fechado e o dinheiro ficou rastreável, **sem**
mudar a semântica de captura. Inverter para autorizar-e-depois-capturar é o
conserto estrutural, está descrito aqui, e **fica com gatilho**: antes de a
carteira servir uma casa que cobra de verdade.

## A ordem de hoje

```
assertChargeSlot  →  psp.createWalletCharge  →  store.registerCharge
                     ↑ CAPTURA aqui            ↑ a linha nasce aqui
```

`createWalletCharge` monta um pedido `credit_card` sem `capture: false`, e a
Pagar.me v5 captura por padrão. O dinheiro sai dentro daquela chamada. A janela
entre a captura e a linha é pequena e era invisível — até o banco ganhar prazo
de 10 s, que transformou "isso nunca acontece" em "isso acontece quando o banco
está lento".

## O que foi feito (9389695)

1. A escrita **tenta duas vezes**, e a unicidade do `txid` na segunda conta como
   sucesso (a primeira escreveu, só a resposta se perdeu).
2. Falhando as duas, o erro sai com código próprio (`charge_maybe_captured`,
   502) e a tela **desarma o botão**, dizendo que o cartão pode já ter sido
   cobrado e que não pague de novo. Antes era 500 `internal` → "algo deu errado,
   tente de novo" com o botão armado, que é convite à segunda cobrança
   (CDC art. 42).
3. O `charge.paid` que chega depois deixou de ser um 409 que some: vira
   `money_without_check`, gravado em `orphan_money_events` com o `orderCode`
   — que carrega o `checkId`. Procedimento em
   [`docs/runbooks/dinheiro-sem-conta.md`](../runbooks/dinheiro-sem-conta.md).

Ou seja: ninguém é convidado a pagar duas vezes, e o dinheiro é **visível e
endereçável** em vez de invisível.

## O que NÃO foi feito, e por quê

Inverter para `capture: false` + captura depois da linha:

```
autoriza  →  grava a linha  →  captura
```

O pior caso passa a ser uma **autorização não capturada**, que expira sozinha
sem tirar dinheiro de ninguém — estritamente melhor para quem está na mesa.

Não foi feito agora porque não é uma linha: é um segundo passo de PSP
(`POST /charges/:id/capture`), um estado novo no razão (autorizado-não-capturado)
que o redutor e a conciliação precisam entender, regras de expiração da
autorização, e um caminho de falha novo — a captura falhar **depois** de a linha
existir, que é uma linha prometendo dinheiro que nunca entrou. Cada uma dessas
peças passa pelos dois revisores, como qualquer código de dinheiro.

Fazer meia inversão seria pior que nenhuma: uma autorização que ninguém captura
é dinheiro preso no limite do cartão do cliente por dias.

## O gatilho

**Antes de a carteira (Google Pay) servir uma casa que cobra de verdade.** Não é
uma data nem uma métrica: é um evento de produto, e quem o aciona sabe que o
aciona — hoje o trilho de carteira não está no ar em casa nenhuma.

Enquanto não estiver, o que segura é o de cima: o cliente não é convidado a
pagar duas vezes, e o órfão é contado no aviso diário do fundador com o endereço
da conta junto.

## O que eu mediria antes de projetar a inversão

Quantas vezes o `charge_maybe_captured` de fato dispara — hoje, zero, porque o
trilho não está no ar. Se ele disparar mais de uma vez em produção antes da
inversão, a inversão vira urgente e não planejada.
