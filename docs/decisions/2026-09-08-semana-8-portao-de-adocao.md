# Semana 8: o portão de adoção não pode ser avaliado

**Data:** 2026-09-08 · **Semana 7,6** (primeira casa: 2026-07-17)
**Critério (estratégia, linha 144):** casas-piloto com **≥25% das contas
migrando na semana 8** e retenção depois do teste. Abaixo disso, **parar o
produto** — "a categoria morre na adoção, não na tecnologia".

## O número

| O que o portão pede | O que existe |
|---|---|
| 10–20 casas-piloto | **2** com recebedor real (`re_…`) |
| ≥25% das contas migrando | **não calculável** — ver abaixo |
| Retenção pós-teste | sem teste, sem retenção |

Movimento real de dinheiro pelo adquirente, desde 2026-07-17:

```
7 cobranças criadas · 1 confirmada · R$ 0,65
```

E os rótulos de quem pagou dizem o resto: `Stefano` (×2), `Bernard Braun`
(×2), `diag` (×2), `Ensaio Claude`. Todas de R$ 0,40 a R$ 1,00, todas na Mesa
13 e na Mesa 12, entre 23 e 25 de julho.

**Nunca houve um cliente de verdade.** Nem um. O que o banco tem é a equipe
testando o próprio produto em três dias de julho.

## Por que "≥25%" não dá pra calcular

O denominador nunca foi coletado. Até hoje o sistema registrava:

- **contas criadas** — o restaurante digita o total no painel (as 24 contas da
  Beira Mar são todas uma linha só, `"Total da conta"`: o adaptador manual, não
  integração de POS);
- **contas pagas** — 1.

Faltava o degrau do meio: **quantas pessoas abriram a conta no telefone**. Sem
ele, "40 escanearam e 1 pagou" e "ninguém escaneou" dão o mesmo relatório — e
pedem correções opostas.

Havia telemetria e ela media vendas, não produto: o beacon do cliente só
dispara com `?pl=` na URL, o token de prospecção da Olímpia. Cliente na mesa
real nunca gerou evento.

**Corrigido hoje** (migração 0028 + `/api/check/opened` + `getAdoptionFunnel`):
o funil agora é criadas → abertas na mesa → pagas, e a conversão é **nula**, não
zero, quando ninguém abriu.

## A leitura honesta

O portão não falhou. **O experimento não foi executado.** Parar o produto agora
seria decidir com base num teste que ninguém rodou — e manter o produto sem
mudar nada seria fingir que sete semanas de silêncio são um sinal ambíguo.

Também vale registrar o que NÃO é o problema: o produto funciona. A conta abre,
divide, cobra por Pix, confirma pelo webhook e fecha a mesa; o caminho foi
exercitado ponta a ponta hoje, e a série de correções desta semana fechou
defeitos reais de dinheiro (gorjeta raspada num estorno parcial, webhook do Pix
sem autenticação em produção, base da folha lendo o valor pedido em vez do
confirmado). Nada disso move o portão.

## Segunda casa: não é adoção, é onboarding

**Kitos Food** tem recebedor `re_…` em estado **`affiliation`** — cadastro
iniciado e não concluído — 1 mesa e **0 contas**. Ela não pode transacionar. De
duas casas "onboardadas", uma está a meio caminho **há 47 dias**, e ninguém
percebeu, porque nada vigia recebedor parado. (A Beira Mar tem 49 dias e está
`active`: as duas entraram na mesma semana e uma travou.)

## O que decide a semana 8

Uma pergunta, e ela não é de engenharia: **um QR chegou à mesa de um cliente?**

- Se não: o portão mede distribuição, e o piloto começa quando começar. A data
  da semana 8 é de 17 de julho, não de quando o produto ficou pronto.
- Se sim, e ninguém pagou: aí o funil de hoje passa a produzir o número, e em
  duas semanas de serviço real ele responde o portão de verdade.

## Recomendação

1. **Não parar por este número** — ele não é sobre adoção.
2. **Reiniciar a contagem do portão** na data em que a primeira mesa real
   receber um QR, e dizer isso na estratégia (o critério está certo; a âncora
   temporal está solta).
3. **Uma casa, duas semanas, QR na mesa.** Beira Mar já tem 24 mesas e
   recebedor ativo — falta o adesivo na mesa e o garçom mencionando.
4. **Fechar o onboarding da Kitos Food**, ou tirá-la da contagem de piloto.
5. **Vigiar recebedor parado**: `affiliation` por mais de N dias é um achado,
   não um estado.

## Fontes

Tudo aqui é consulta ao banco de produção (`worttfotxasxqjaqwpjf`) em
2026-09-08, e ao critério em
`restaurant-ai-mcp/.claude/plans/2026-07-17-racha-pay-at-table-brazil/README.md`
linhas 144–146.
