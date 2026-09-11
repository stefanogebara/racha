# Onde fica o dinheiro pago a mais — a pergunta de custódia (inegociável #4)

**Levantada por:** revisão de compliance, 2026-09-08 · **Estado:** respondida por
verificação contínua; a medição em sandbox segue disponível e opcional.

## A pergunta

A `order` que a gente cria manda uma regra de split `flat` pelo valor **pedido**:

```js
split: [{ recipient_id, amount: total, type: 'flat',
          options: { charge_processing_fee: true, charge_remainder_fee: true, liable: true } }]
```

Desde que `overpaid` passou a contar como dinheiro recebido, o **capturado pode
passar da soma das regras**. Quem fica com a diferença é decisão da Pagar.me. Se
ficar com a Racha, é conta-bolsão: o inegociável #4 proibindo, e licenciamento
BACEN (Res. 494/2025) entrando em cena. E a tela do cliente estaria dizendo que
**o restaurante** deve um valor que está com a plataforma.

## O que foi apurado (2026-09-08)

**1. A configuração já direciona o restante pro restaurante.** O schema v5
descreve `options.charge_remainder_fee` como *"Indica se o recebedor vinculado à
regra irá receber o restante dos recebíveis após uma divisão"*, e a gente manda
`true` na regra da casa. O nome do campo fala de taxa, a descrição fala de
recebíveis — a ambiguidade é da documentação, não da nossa configuração.

**2. Num Pix dinâmico o pagador NÃO ESCOLHE o valor.** A cobrança Pix da
Pagar.me gera um QR dinâmico por cobrança, e QR dinâmico leva o valor embutido:
o pagador confirma ou não paga. Ou seja, `overpaid`/`underpaid` são status de
**boleto** (onde se digita o valor no banco) e de QR estático — não do trilho
que a Racha usa hoje.

Isso **estreita** a exposição; não a elimina, e não é prova. Não confirmei que a
Pagar.me emite com `modalidadeAlteracao = 0`, e um boleto ou um QR estático
mudariam o quadro.

**3. `canceled_amount` existe, na COBRANÇA.** O `DELETE /charges/{id}` aceita um
`amount` parcial e a cobrança reporta `canceled_amount` — conferido na
documentação do cancelamento. (O resumo do schema do `GET` não lista o campo, e
foi o que me fez desconfiar de uma afirmação que eu havia escrito sem fonte.)

## O que fecha a pergunta: a TERCEIRA PERNA

Ler documentação não é medir. Então a conferência entrou no produto, e roda
sozinha: `GET /payables?charge_id=…` devolve uma linha por recebedor com
`recipient_id`, `amount`, `fee` e `type`. É o razão do **próprio adquirente** —
e é a única das três pernas que não é nossa.

O invariante é o inegociável #4 escrito como código:

> **Todo recebível de crédito de uma cobrança pertence ao recebedor da casa.**
> Um recebível de crédito em nome de qualquer outro — inclusive o nosso — é
> `custody_leak`, **crítico**, e pinta a casa de vermelho no relatório diário.

Mais o invariante de valor: o que a casa recebeu, **bruto de taxa** (`amount +
fee`, porque a casa banca a taxa), tem que dar o capturado. Um centavo de
diferença é arredondamento; uma sobra inteira é crítica.

Módulo: `api/_lib/checks/reconcile-payables.js` (puro e total). Perna:
`reconcilePayablesLeg` no `reconcile-daily`, ligada pela rota do cron diário com
teto de 25 cobranças por casa — cada uma é uma chamada de API, e a varredura roda
no escuro.

A janela é de 24h por padrão e dá pra apontar pra trás: `?since=AAAA-MM-DD`, com
teto de 90 dias, na mesma rota (fechada por `CRON_SECRET`). Existe porque sem
isso a perna de custódia nunca teria sido medida contra dado real — as cobranças
reais são de julho e a janela padrão não as alcança, então ela rodaria contra
NADA e reportaria ok até a primeira mesa de verdade.

**Sempre com `?dry=1` numa inspeção.** Seco quer dizer seco: `dry=1` desliga a
escrita do reparo de linha e o envio do alerta. Sem ele a "olhada" roda a
varredura de reparo inteira.

Por que isso é melhor que a medição em sandbox: uma medição responde uma vez,
para as condições daquele dia. Esta responde **toda noite, em produção, para
cada cobrança de verdade** — e o dia em que a Pagar.me mudar o comportamento, ou
alguém habilitar boleto, ela avisa sem ninguém precisar lembrar da pergunta.

## O que continua em aberto (e não é código)

Enquanto nenhuma cobrança real cair em `overpaid`, a perna não tem o que
provar — ela confirma o caso normal (que é o que já roda). Duas coisas fechariam
a última dúvida, e as duas dependem de acesso que eu não tenho aqui:

1. **Chave de teste** (`sk_test_…`) do painel da Pagar.me. Com ela: criar uma
   cobrança com split flat, pagar a mais pelo simulador, e ler os recebíveis.
   **Limitação conhecida:** a documentação do simulador Pix diz que ele *"não
   pode ser usado junto com o produto Split"* — então talvez o próprio simulador
   não sirva pra esta pergunta, e a resposta venha só de boleto em sandbox.
2. **Painel da Pagar.me** (a sessão expirou e o login pede reCAPTCHA): a tela de
   uma cobrança mostra os recebíveis por recebedor, o que responde direto pra
   `ch_jg47Wgu5PTKK76LZ` (Beira Mar, R$ 0,65, `paid`).

Nenhuma das duas é pré-requisito pra rodar: a perna está no ar e é ela que
sustenta a afirmação. Isto aqui é o que faltaria pra transformar "verificado
continuamente" em "medido uma vez também".

## Se `custody_leak` aparecer

1. **Pare de aceitar `overpaid`** como dinheiro liquidado: `PAID_STATUSES` em
   `api/_lib/pay/pagarme-psp.js`. O status volta a ser evento não lançável —
   anomalia durável e alerta, sem a tela do cliente nomeando devedor.
2. Troque a regra de split por percentual (`type: 'percentage', amount: 100`),
   que não deixa resto por construção — **e isso é mudança de fluxo de dinheiro:
   pelo inegociável #4, opinião de assessoria de pagamentos ANTES.**
3. Some quanto já passou pela nossa conta: `GET /payables?recipient_id=<nosso>`.
