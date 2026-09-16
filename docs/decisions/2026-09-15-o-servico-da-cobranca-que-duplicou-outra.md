# O serviço de uma cobrança que duplicou outra, antes de a conta fechar

**Decisão:** o caminho existe, está nomeado, e NÃO vai ser consertado por
dedução a partir do excedente. O conserto depende de um dado que o razão ainda
não guarda, e escrever a regra sem ele criaria um falso positivo em cima do caso
mais comum da rota de devolução.

## O que acontece

Conta de R$ 100,00, serviço 10%. Ana e Bruno tocam "pagar a conta toda" com
segundos de diferença. As duas cobranças passam pela conferência de `remaining`
antes de qualquer uma confirmar, e as duas confirmam: `paidCents` 20000,
`overpaidCents` 10000, `tipCents` 2000 — sobre um atendimento que gerou R$ 10,00
de serviço.

A conciliação levanta `overpaid_pending_restitution` de 10000, o painel diz "a
devolver R$ 100,00", e o teto da rota de devolução é o `excesso`, que é só
consumo. **Os R$ 10,00 de serviço cobrados na cobrança duplicada ficam na base da
folha**, e a casa nunca é avisada de que deve R$ 110,00.

É a mesma doutrina que o runbook já escreve pra duplicidade TARDIA — 10% sobre
uma cobrança que não correspondeu a atendimento nenhum nunca foi serviço
prestado (Lei 13.419/2017 + STJ Tema 1102) — aplicada a um caminho que o código
não cobre. Achado pela revisão de compliance de 41b188a (HIGH-3).

## Por que o `sempreDevido` não alcança

Ele está inteiro atrás de `p.late`, e `late` só é verdade se a conta já estava
FECHADA quando o pagamento confirmou. Aqui as duas cobranças chegam ANTES do
fecho. Não há auto-fecho ao atingir o total, e o teto de cobranças da 0033 é de
QUANTIDADE, com janela deslizante — não reserva valor.

## Por que não dá pra deduzir do excedente

A regra óbvia — "serviço devido = serviço × excedente / valor" pra todo
pagamento — quebra o caso mais comum da rota:

- **Cobrança que duplicou outra** (Ana e Bruno): a cobrança inteira era
  desnecessária, e o serviço dela também. Devido.
- **Cliente que digitou um número maior no app do banco** (o caso que abre o
  runbook): a cobrança era legítima, o serviço que ele escolheu era sobre o
  consumo dele, e o excedente é consumo puro. **Não devido** — e a regra óbvia
  reivindicaria uma fatia dele de volta, tirando da folha um serviço que foi
  prestado.

O que separa os dois não está no excedente: está em o quanto a cobrança PEDIU
contra o que já estava coberto. A linha de `payments` guarda os dois pares
(`amount_cents`/`tip_cents` pedidos e `confirmed_*` recebidos) — o razão, não. E
o razão é a fonte (inegociável #6): derivar autorização de uma projeção é
exatamente o que a revisão de d7f2683 mandou desfazer na data do trilho.

## O gatilho, com prazo

**O dia em que o `PAYMENT_CONFIRMED` carregar o valor PEDIDO da cobrança**, e no
mais tardar **a próxima migração que toque o payload de evento** — o que vier
primeiro. Com `requestedAmountCents` no payload, o redutor distingue as duas
situações sem adivinhar: excedente sobre a PRÓPRIA cobrança (o cliente digitou
mais) é consumo puro; cobrança cujo pedido já estava coberto por outra é
duplicidade, e o serviço dela é devido de qualquer jeito, como no `sempreDevido`
do atrasado.

Um gatilho sem data é como adiamento vira permanente, e a revisão de compliance
de 089e8a2 cobrou isso: fica amarrado a um marco que já está no caminho, não a
uma condição que ninguém está obrigado a produzir.

## O que existe ENQUANTO ISSO

A conciliação levanta um achado **`info`** quando a conta tem sobra e mais de um
pagamento trouxe serviço: *"confira se há serviço cobrado sobre a parte
duplicada"*. Não é autorização derivada de projeção — não move dinheiro, não
mexe em teto, não pode produzir o falso positivo que este documento teme. É só o
aviso que faltava: sem ele o operador segue o runbook, devolve o consumo, fecha o
achado, e os 10% ficam na folha sem ninguém saber (compliance MEDIUM-1 de
089e8a2).

Fica registrado em vez de virar regra agora porque a regra errada custa mais que
a ausência dela: ela tiraria da folha dinheiro de garçom sobre atendimento
prestado, e o CLT art. 462 não deixa descontar isso depois.
