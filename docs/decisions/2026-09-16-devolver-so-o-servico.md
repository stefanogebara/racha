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

Enquanto nenhum dos dois existir, o erro é **contra a casa**: o serviço fica na
base de cálculo da folha, que o restaurante distribui à equipe por meio da folha
de pagamento (Lei 13.419/2017). É o lado certo para errar — sobra na base, não
falta —, e é por isso que isto é uma decisão registrada e não um conserto
apressado.
