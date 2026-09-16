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

**Antes de a carteira (Google Pay) servir uma casa que cobra de verdade.**

A primeira versão desta página dizia que isso era "um evento de produto, e quem
o aciona sabe que o aciona". Era falso, e uma revisão mediu: o `acceptsWallet`
era verdadeiro para QUALQUER casa com recebedor de verdade, então a primeira
casa-piloto cadastrada num build com as chaves ganhava Google Pay como efeito
colateral do cadastro. **O gatilho que devia forçar a inversão se satisfazia
sozinho** — a forma de "guarda que depende de alguém lembrar" que este
repositório já pagou pra aprender duas vezes.

Agora existe interruptor: `RACHA_WALLET_VENUES`, lista de ids separados por
vírgula, **ausente quer dizer nenhuma**. Ligar a carteira numa casa passou a ser
um ato — e é esse ato que dispara esta decisão. Quando a carteira for de
verdade, isto vira `venues.wallet_enabled` (coluna, não env).

Enquanto não estiver, o que segura é o de cima: o cliente não é convidado a
pagar duas vezes, e o órfão vai pro aviso diário do fundador com o VALOR e o
endereço da conta na mesma linha.

(Isto também já foi promessa vazia: o `orderCode` não era gravado, e o aviso
dizia só o tipo e o txid. As duas coisas foram consertadas depois de uma revisão
medir; ver o runbook.)

## O que ficou ABERTO, e não foi consertado aqui

- **Dinheiro que SAI pra um txid desconhecido continua 409.** O argumento "um
  409 não guarda nada" vale igual pro estorno e pra disputa perdida, e hoje só o
  que ENTRA vira órfão registrável. A assimetria foi herdada, não decidida.
- **Não há caminho automático de volta**: recriar a linha a partir do órfão é
  trabalho manual de banco (o runbook diz isso em voz alta).
- **A ponte de avisos ainda não aceita `money_without_check`** — ela deploya de
  outro repositório. Até lá o alerta do mesmo dia é recusado e o fundador só
  sabe pela conciliação da madrugada. O evento fica durável aqui de qualquer
  jeito, porque o reenvio depende do registro e não do aviso.

## O que eu mediria antes de projetar a inversão

Quantas vezes o `charge_maybe_captured` de fato dispara — hoje, zero, porque o
trilho não está no ar. Se ele disparar mais de uma vez em produção antes da
inversão, a inversão vira urgente e não planejada.
