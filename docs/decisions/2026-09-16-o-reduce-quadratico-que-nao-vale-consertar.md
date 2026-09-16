# O `reduce` é quadrático, e mexer nele seria pior que o problema

**Decisão:** o achado é real e fica **aberto sem conserto**, com o número medido
ao lado. O `check-state.js` não é tocado por isto.

## O achado

A auditoria de backend apontou que `reduce()` é quadrático no número de
pagamentos de uma conta: ele clona o estado inteiro a cada evento
(`cloneState`), e o estado carrega todos os pagamentos já vistos. Estimou ~1 s
para 4.000 pagamentos.

## O que eu medi

Medido em 2026-09-16, `node`, uma conta só, dois eventos por pagamento:

| pagamentos | eventos | tempo | por evento |
|-----------:|--------:|------:|-----------:|
|         50 |     101 |   4,5 ms |  45 µs |
|        200 |     401 |  14,4 ms |  36 µs |
|        500 |   1.001 |  59,5 ms |  59 µs |
|      1.000 |   2.001 | 199,7 ms | 100 µs |
|      2.000 |   4.001 | 609,6 ms | 152 µs |
|      4.000 |   8.001 | **2.603 ms** | 325 µs |

O custo POR EVENTO cresce com o tamanho da conta — é a assinatura do quadrático,
e a estimativa da auditoria era conservadora por 2,6×.

## Por que ele não vale conserto

A curva é quadrática **dentro de uma conta**, e uma conta com quatro mil
pagamentos não é uma mesa: é uma mesa dividida quatro mil vezes. O que existe de
verdade é o contrário — muitas contas pequenas —, e aí a conta é linear:

| forma | tempo |
|---|---:|
| 1.000 contas × 4 pagamentos | 24 ms |
| 5.000 contas × 4 pagamentos | 139 ms |
| 5.000 contas × 12 pagamentos | 537 ms |

Cinco mil contas com doze pagamentos cada — uma casa grande, um ano de história,
a conciliação diária inteira — custam meio segundo. O `maxDuration` é 120 s.

### O orçamento certo não é o da conciliação (correção)

A primeira versão desta página comparava os 537 ms com os 120 s da conciliação
diária, e a revisão de compliance apontou que esse é o orçamento errado: o mesmo
`reduce` roda no `getPanelView`, que o `/api/panel` chama **a cada volta do laço
do painel**, sem cache. Era esse o número que decidia, e ele não estava aqui.

O que mudou desde então, e por que a decisão se sustenta melhor agora do que
com o argumento errado:

- O laço deixou de ser fixo em quatro segundos. Ele **para** na aba escondida e
  **recua até um minuto** depois de uma falha (`Panel.tsx`), então o pior caso
  deixou de ser "quinze vezes por minuto, para sempre, por aba aberta".
- A lista de contas do painel deixou de ser "toda conta que a casa já teve" e
  passou a ser três conjuntos pequenos: as ABERTAS (no máximo uma por mesa, pelo
  índice único da 0004), as da janela de oito dias, e as que receberam dinheiro
  na janela. O `reduce` do painel roda sobre isso — dezenas de contas numa casa
  movimentada, não milhares.

Ou seja: o número que a revisão pediu é o do painel, e o conserto do recorte
tirou o painel da conta. A conciliação diária continua lendo a casa inteira, e é
lá que os 537 ms valem — uma vez por dia.

Do outro lado da balança: `check-state.js` é o redutor do dinheiro. É o módulo
com testes de propriedade, provas de mutação e três rodadas de revisão em cima,
e a mudança que tiraria o quadrático (parar de clonar por evento, mutar uma
cópia de trabalho) muda exatamente a propriedade — nenhum evento enxerga o
estado que outro escreveu — que os testes mais difíceis deste repositório
existem pra garantir. Trocar meio segundo que ninguém sente por esse risco é um
mau negócio.

## O que faria isto voltar à mesa

Uma conta real passar de algumas centenas de pagamentos.

**E o gatilho tem que disparar sozinho.** A primeira versão desta página dizia
"é este mesmo script rodando contra a distribuição de produção" — o que, como a
revisão de compliance observou, é um desejo e não um gatilho: não há métrica,
achado nem alerta que emita pagamentos-por-conta, e depender de alguém lembrar,
numa cadência que ninguém escreveu, é a mesma coisa que esta casa chama de
"guarda que é caracterizada em produção, por um cliente em pé na mesa".

A conciliação diária já carrega o razão completo de toda conta da casa. Fazer
ela levar junto o `max(pagamentos por conta)` e emitir um achado `info` acima de
uns 300 custa pouco e faz a decisão se reabrir sozinha. **Fica na fila com esta
página como justificativa** — e é a única parte desta decisão que continua em
aberto.

Se aparecer, o conserto certo é **estrutural** (o redutor guardando os
pagamentos num mapa persistente, ou o estado sendo congelado uma vez no fim),
não um `cloneState` mais esperto — e passa pelos dois revisores como qualquer
outra mudança no caminho do dinheiro.
