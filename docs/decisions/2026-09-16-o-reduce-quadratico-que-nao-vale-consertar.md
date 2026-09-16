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

Do outro lado da balança: `check-state.js` é o redutor do dinheiro. É o módulo
com testes de propriedade, provas de mutação e três rodadas de revisão em cima,
e a mudança que tiraria o quadrático (parar de clonar por evento, mutar uma
cópia de trabalho) muda exatamente a propriedade — nenhum evento enxerga o
estado que outro escreveu — que os testes mais difíceis deste repositório
existem pra garantir. Trocar meio segundo que ninguém sente por esse risco é um
mau negócio.

## O que faria isto voltar à mesa

Uma conta real passar de algumas centenas de pagamentos. O sinal não é uma
suspeita: é este mesmo script rodando contra a distribuição de produção. Se
aparecer, o conserto certo é **estrutural** (o redutor guardando os pagamentos
num mapa persistente, ou o estado sendo congelado uma vez no fim), não um
`cloneState` mais esperto — e passa pelos dois revisores como qualquer outra
mudança no caminho do dinheiro.
