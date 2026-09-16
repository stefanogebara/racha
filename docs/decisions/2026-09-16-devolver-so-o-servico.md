# Devolver SÓ o serviço, sem tirar do consumo junto

**Decisão:** o caminho não existe hoje, está nomeado, e o conserto não é um
remendo no rateio — é dar ao estorno uma composição, ou abrir a rota de registro
para o caso "serviço devolvido". Fica com gatilho.

## O que acontece

A mesa pede a remoção dos 10% **depois** de pagar. É pedido legítimo e frequente
(o inegociável #3 garante a remoção ANTES; depois é CDC comum). A casa emite o
estorno no painel do adquirente pelo valor do serviço — R$ 10,00.

O evento chega como um total cru: nenhum adaptador daqui cria estorno
(`refunds.create` não existe em `api/_lib/pay/`), então tudo nasce no painel do
adquirente e volta como número. Sem excedente, sem serviço devido e sem
atrasado, o rateio cai no proporcional:

```
allocateRefund(10000, 1000, 1000) -> { amountCents: 909, tipCents: 91 }
```

O cliente recebe os R$ 10,00 de serviço de volta e **R$ 9,09 continuam na base da
folha** — serviço que não foi prestado, contado como remuneração (Lei
13.419/2017 + STJ Tema 1102). E não há saída pela rota manual: sem excedente,
sem marca e sem testemunha, `tetoDaRestituicao` devolve zero e a rota responde
`use_acquirer_refund` — o trilho que acabou de errar o balde.

Achado pela revisão de compliance de 11a0904 (MEDIUM-2).

## Por que não dá pra deduzir do valor

"Estorno igual ao serviço líquido ⇒ é o serviço" é adivinhação com dinheiro de
terceiro: uma conta de R$ 100,00 + R$ 10,00 em que a casa devolve R$ 10,00 de
CONSUMO (um item errado) produz exatamente o mesmo número, e a regra tiraria da
folha um serviço que foi prestado — o erro que a CLT art. 462 não deixa desfazer.
A diferença entre os dois casos não está no razão nem no evento: está na intenção
de quem emitiu o estorno, e essa informação existe só no painel do adquirente.

## O gatilho

**O dia em que a casa emitir o estorno por aqui** — a primeira rota que criar
estorno no PSP (`refunds.create`) nasce com a composição explícita
(`amountCents`/`tipCents`), e aí o webhook casa por `re_` e o rateio segue o que
foi pedido, como já faz com a testemunha. Se isso demorar, a alternativa barata é
abrir `record-restitution` para o caso "serviço devolvido", com a referência do
adquirente como prova — a mesma forma que já existe para a devolução fora do
trilho.

## A metade que esta decisão não tinha contado

A frase anterior desta seção dizia que, enquanto nenhum dos dois existir, "o erro
é contra a casa: sobra na base da folha, não falta — é o lado certo para errar".
**Isso era falso, e a revisão de compliance da rodada dez mediu por quê.**

O rateio proporcional não mexe só na gorjeta. Ele abate também o **consumo**, e
`totalCents` não se mexe. Medido, com os números deste documento:

```
pago em cheio  : status= paga    paid= 10000  total= 10000  tip= 1000
apos devolver  : status= parcial paid=  9091  total= 10000  tip=  909
o telefone diz : faltam 909 centavos
```

Ou seja: a mesa que pagou tudo volta a ver **R$ 9,09 "faltando" e o botão de
pagar**, num QR que qualquer um daquela mesa recarrega. Isso é cobrança de dívida
já quitada — **CDC art. 42**, com a repetição em dobro do parágrafo único se
alguém pagar —, e informação errada sobre o que se deve (**CDC art. 6º III**). Se
alguém pagar, a casa recebe R$ 9,09 que não lhe são devidos, mais 10% de serviço
sobre isso, e nasce um `overpaid_pending_restitution` que o runbook manda
devolver: um laço.

O lado da folha erra contra a casa. O lado do consumo erra **contra o cliente**,
que é o lado errado para errar. A conclusão anterior olhava um eixo só.

Três consequências, e nenhuma delas é "adiar sem dizer":

1. **O gatilho acima fecha os dois de uma vez.** Um estorno com composição
   explícita não tira nada do consumo, então não reabre a conta. Isto reforça o
   gatilho em vez de enfraquecê-lo.
2. **Passou a existir detector.** `reopened_by_refund`, na conciliação: conta
   que esteve quitada e tem devolução vira achado **`high`**, com o número que a
   mesa está vendo. Com chargeback na mesma conta o código é
   **`reopened_by_refund_mixed`**, que traz também a parte devolvível — só ela
   pode ser ajustada para baixo. Era a diferença entre descobrir isto num documento e
   descobrir num cliente.

   `high` e não `critical` porque nada se perdeu — perdeu-se a verdade da tela —
   e porque a devolução em si é correta: o achado some no instante em que alguém
   fecha ou ajusta. Não há predicado "e não tem ajuste": um ajuste que fecha a
   diferença devolve a conta pra `paga` e o achado não nasce; um que fecha só
   parte dela deixa saldo na tela, e aí tem que sair mesmo. (A primeira versão
   tinha o predicado, e ele era inalcançável — medido.)
3. **O runbook passou a dizer o que fazer.** Ver
   `docs/runbooks/devolver-dinheiro-a-mais.md` — fechar a conta, ou lançar um
   ajuste para baixo no valor devolvido do consumo, e **nunca** pedir o resto à
   mesa.

## Isto não é do serviço: é de QUALQUER devolução pelo painel

A mesma mecânica vale para uma devolução de **consumo** (item errado, cortesia):
`paidCents` cai, `totalCents` fica, e a conta reabre. O único caso seguro é a
devolução de EXCEDENTE, porque ali `paidCents > totalCents` desde o começo e o
abate só consome a sobra.

Enquanto o gatilho não chega, o erro é **repartido**: sobra na base da folha
(contra a casa) e falta na conta do cliente (contra ele). O detector é o que
impede o segundo de virar dinheiro; é por isso que esta decisão continua sendo
uma decisão registrada, e não um conserto apressado.
