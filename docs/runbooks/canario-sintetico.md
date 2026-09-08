# O canário sintético

**O que é:** um script que dirige uma instância de verdade por HTTP, do jeito
que um telefone numa mesa dirige, e afirma o que tem que ser verdade no fim.
A linha da barra de verificação do `CLAUDE.md` que nunca tinha sido escrita.

```bash
RACHA_CANARY_TOKEN=demoracha npm run canary                       # local
RACHA_CANARY_TOKEN=demoracha npm run canary -- https://<host>     # um deploy
```

Sai `0` quando tudo fecha, `1` no primeiro fato que não fecha — e diz qual.

## O que ele afirma (26)

A mesa zera, a conta abre pelo QR, tem valor, e começa sem pagamento. O estado
público é **projetado**: sem campos internos do redutor, anomalias como
contagem, nada de `disputeStatus`/`disputeDueBy`/`reason`, pagamentos por
ordinal em vez do id do adquirente. A conta racha em três e as partes somam o
total **ao centavo**. Cada parte vira cobrança, entra no razão, e **reentregue
não move o saldo**. No fim: o pago bate com a conta, a mesa fecha, não sobrou
dinheiro a devolver, o razão fecha sem anomalia, e a casa declara a moeda.

## O que ele NÃO cobre, dito na cara

O pagamento é confirmado pela rota de demo (PSP mock): não há como forçar um
Pix de verdade num teste. Então ele prova o caminho inteiro **menos o
adquirente**. Quem cobre o adquirente é a terceira perna da conciliação
(`reconcile-payables`), que lê os recebíveis dele e afirma que todo centavo foi
pra subconta da casa.

## Duas coisas que ele já encontrou em si mesmo

**Rodava uma vez.** Sem zerar a mesa, a segunda passada encontrava a conta
quitada, `/api/pay` recusava com "valor acima do que falta", e o canário
reportava vermelho por ter funcionado antes. Um teste que só passa na primeira
execução treina quem lê a ignorar o vermelho.

**Afirmava a palavra, não o efeito.** Exigia `appended` da rota de confirmação —
e na mesa de demo a cobrança se confirma na criação (não há banco numa
demonstração de landing), então a resposta é `duplicate` e ele acusava três
vezes sobre dinheiro que entrou certinho. Agora afirma o razão: quanto o saldo
andou. Asserção sobre resposta descreve a implementação; sobre o razão,
descreve o que tem que ser verdade.

## Rodado contra a produção de hoje (2026-09-09)

14 de 24 na versão anterior do script — e as dez divergências eram **as
mudanças desta série que ainda não foram publicadas**: o estado público ainda
sai inteiro (com `closed` e o texto das anomalias), o payload da casa ainda não
traz `market`/`currency`/`rails`, e as anomalias vêm como lista em vez de
contagem. Ou seja: o canário mede exatamente o vão que um deploy fecharia.

As três cobranças que ele criou lá são `mock…` na casa de demonstração — PSP
falso, dinheiro nenhum. A mesa de demo se auto-cura.
