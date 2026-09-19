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

## O que foi feito (9389695, depois 85f8414, 8f6b48c e 16043b2)

1. A escrita tenta **duas vezes** quando a segunda ida tem chance — o que
   inclui tanto o transitório (`57014` prazo, `40P01` deadlock, `53300` pooler
   cheio) quanto o desfecho desconhecido (`08*`, `40003`) — e **uma vez só**
   na recusa determinística (CHECK, grant, coluna). Quem decide é `valeRepetir`,
   no classificador.

   Esse predicado nasceu de um erro meu: eu reusei `recusaProvada`, que responde
   *outra* pergunta ("está provado que nada foi gravado?") e por isso inclui o
   prazo e o deadlock. O efeito era desligar a segunda tentativa justamente nos
   erros que ela conserta — pooler saturado numa noite cheia, com o cartão já
   capturado — deixando MAIS comum o `charge_maybe_captured` que este conserto
   existe pra tornar raro. Uma regra, duas perguntas, um predicado só.

   A unicidade do `txid` conta como **sucesso** na SEGUNDA ida: ali a primeira
   tentativa foi nossa, então a linha que está lá só pode ser a que se queria
   escrever. Na PRIMEIRA, não — não houve tentativa anterior nossa, logo a linha
   é de OUTRA cobrança, e devolver sucesso entregaria à segunda pessoa da mesa a
   cobrança da primeira. Ali o `gravarAposCobrar` só segue depois de confirmar o
   dono pelo rótulo do pagador. (Esta frase dizia "em qualquer das duas idas" e
   afirmava exatamente a premissa que o `nossa` existe pra refutar.)
2. Esgotadas as tentativas, o erro sai com código próprio, e **os dois códigos
   pedem coisas opostas da tela** — que é o motivo de serem dois:
   - `charge_maybe_captured` (o trilho que CAPTUROU) **desarma o botão** e diz
     pra não pagar de novo. Antes era 500 `internal` → "algo deu errado, tente
     de novo" com o botão armado, que é convite à segunda cobrança (CDC art. 42).
   - `charge_not_started` (Pix, Bizum, Stripe — onde a cobrança existe mas
     ninguém foi debitado) **mantém o botão armado** e diz "nada foi cobrado,
     tente de novo", porque ali tentar de novo é a resposta certa.

   (A frase anterior aqui dizia que a tela desarma o botão nos dois casos. Era
   um branch mais larga que o código, e a terceira vez nesta série que uma
   sentença de documento afirma comportamento que só metade do código tem —
   sexta revisão de compliance, 2026-09-19.)

   Toda essa decisão mora em `api/_lib/pay/gravar-apos-cobrar.js`, num lugar só.
   Ela já esteve escrita dentro de um caminho, e aí os caminhos irmãos não a
   conheciam: o atalho da recusa provada lançava o erro cru (500 `internal`, o
   dano de volta pela linha ao lado), o trilho da Stripe chamava `registerCharge`
   pelado, e o `23505` da PRIMEIRA ida — que quer dizer sucesso — virava 500
   permanente. Três achados da quinta revisão, 2026-09-19, com uma raiz só.
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

A lista do que precisa estar fechado ANTES de `RACHA_WALLET_VENUES` nomear uma
casa de verdade — nenhum deles bloqueia o merge, todos bloqueiam o primeiro id:

1. O balcão ter onde olhar (abaixo, em "o que ficou ABERTO").
2. A ponte de avisos aceitar `money_without_check` (idem).
3. O `psp-acceptance` rodar verde de ponta a ponta contra a casa-piloto — o que
   exige o id dela na env e um redeploy.

A primeira versão desta página dizia que isso era "um evento de produto, e quem
o aciona sabe que o aciona". Era falso, e uma revisão mediu: o `acceptsWallet`
era verdadeiro para QUALQUER casa com recebedor de verdade, então a primeira
casa-piloto cadastrada num build com as chaves ganhava Google Pay como efeito
colateral do cadastro. **O gatilho que devia forçar a inversão se satisfazia
sozinho** — a forma de "guarda que depende de alguém lembrar" que este
repositório já pagou pra aprender duas vezes.

Agora existe interruptor: `RACHA_WALLET_VENUES`, lista de ids separados por
vírgula, **ausente quer dizer nenhuma**. Ligar a carteira numa casa passou a ser
um ato — e é esse ato que dispara esta decisão.

A primeira versão DESTE interruptor também não interruptava: ele era consultado
só para montar o `acceptsWallet` da resposta do `/api/check`, e o caminho do
dinheiro não o consultava. Um `POST /api/pay` com `wallet` + `paymentToken`
capturava cartão em qualquer casa com recebedor real, com a lista vazia — e
"desligar" só mudava as respostas novas, enquanto todo PWA já aberto na mesa
seguia com o botão por mais 30-90 min. Hoje o `POST /api/pay` recusa com
`rail_unsupported` (a mesa de DEMONSTRAÇÃO é isenta — ela cobra pelo MockPsp
próprio e não toca dinheiro de verdade), e o curinga `*` (que é de staging) não vale quando o PSP é a
Pagar.me de verdade. Achado pela quinta revisão, 2026-09-19.

Vale registrar o limite honesto do mecanismo: na Vercel a env é ligada ao
DEPLOY. Mexer em `RACHA_WALLET_VENUES` no painel não alcança o que está no ar
até um redeploy. Desligar a carteira é um redeploy, não um botão. Quando a carteira for de
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
- **O balcão não tem onde olhar.** A tela diz a quem está na mesa "fale com o
  balcão se a conta não atualizar" — e não existe superfície nenhuma no painel
  que mostre um órfão. Procure por `orphan` em `apps/web/src` e não há nada. O
  órfão sai só no aviso diário do fundador, de madrugada. Ou seja: a nossa
  mensagem, que está certa, termina num beco no balcão. Isto vive em thread de
  revisão desde a quinta rodada e não estava escrito em lugar nenhum — que é a
  "guarda que depende de alguém lembrar" nomeada três vezes nestes arquivos.
  **É precondição pra ligar a primeira casa**, não pro merge: uma linha na
  lista de contas dizendo "pagamento recebido sem registro, R$ X, fale com a
  Racha", movida pelo `checkId` que o `orderCode` já carrega.
- **A ponte de avisos ainda não aceita `money_without_check`** — ela deploya de
  outro repositório. Até lá o alerta do mesmo dia é recusado e o fundador só
  sabe pela conciliação da madrugada. O evento fica durável aqui de qualquer
  jeito, porque o reenvio depende do registro e não do aviso.

## O que eu mediria antes de projetar a inversão

Quantas vezes o `charge_maybe_captured` de fato dispara — hoje, zero, porque o
trilho não está no ar. Se ele disparar mais de uma vez em produção antes da
inversão, a inversão vira urgente e não planejada.
