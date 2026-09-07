# Mercados: Brasil e Espanha

Decisão de 2026-09-07, quando o produto abriu a Espanha.

## O que é um mercado

Não é um idioma. Não é uma moeda. É um **pacote de regras que mudam juntas**:

| | Brasil (`br`) | Espanha (`es`) |
|---|---|---|
| Moeda | BRL | EUR |
| Trilho principal | Pix | Bizum |
| Segundo trilho | cartão / Google Pay (Pagar.me) | cartão / Apple·Google Pay (Stripe) |
| Linha de serviço na conta | 10% **pré-marcada e removível** | **nenhuma** |
| Documento do pagador | CPF, obrigatório | nenhum |
| Limites por cobrança | sem teto de esquema | 0,50 € a 5.000 € |
| Idioma sugerido | pt | es |

Mexer numa dessas linhas sem as outras produz coisa errada em silêncio: um Pix
cobrado em euro, um CPF pedido a um espanhol, 10% pré-marcados numa conta em
Madrid. Por isso elas moram juntas, num só lugar: `api/_lib/markets.js`.

## Quem decide é o servidor

`/api/check` manda o pacote **pronto** dentro de `venue`: moeda, trilhos, se há
linha de serviço, se o pagador precisa dar documento, e os limites do esquema.
O cliente desenha; não decide.

Isso é a correção da revisão #37 aplicada de novo — a UI inferindo uma regra de
dinheiro foi o que abriu a folha de cartão REAL numa mesa de demonstração — e é
a lição da #32: uma segunda implementação das regras no cliente é uma
divergência com um comentário em cima.

Mercado desconhecido é **erro na escrita** e **Brasil na leitura**. Toda venue
que existia antes da coluna é brasileira, mas gravar `'fr'` como Brasil seria
uma casa cobrando na moeda errada, calada.

## Espanha: por que não tem linha de serviço

Em Espanha o preço já inclui o serviço e a gorjeta é discricionária — quase
nunca lançada na conta, exceto em casa de nota alta ou grupo grande.
Acrescentar uma linha que o cliente não pediu, num mercado onde ela não é
costume, é o padrão errado na UE.

O mercado zera o serviço **mesmo quando a venue foi cadastrada com 10%** — e
isso acontece, porque o formulário de cadastro é brasileiro.

Se algum dia a Espanha ganhar propina voluntária, o modo `optIn` já existe e a
regra é: **desmarcada por padrão**, nunca pré-selecionada. E o inegociável do
Brasil vale igual — o dinheiro entra na conta da empresa e sai por folha, nunca
no bolso direto de um garçom. Em Espanha a gorjeta também é renda tributável do
empregado.

## Espanha: por que não pede documento

No Bizum quem autentica é o banco do pagador, no app dele. O telefone é digitado
**dentro do elemento da Stripe**, não no nosso formulário, e nunca chega aos
nossos servidores. Pedir NIF/DNI aqui seria coletar dado sem necessidade —
GDPR art. 5(1)(c), minimização, que é a mesma regra do art. 6º III da LGPD.

O documento do **restaurante** continua exigido: é requisito de onboarding do
Bizum na conta conectada. Mas isso é cadastro, não checkout.

No Brasil o CPF do pagador **é** necessário: a doc do Pagar.me lista
`name`/`email`/`document`/`phones` como obrigatórios pra criar a cobrança Pix
(`docs.pagar.me/reference/pix-2`, conferido 2026-09-07). É essa necessidade que
sustenta o campo, e é isso que a linha de transparência na tela diz.

## Bizum, tecnicamente

Roda pelo adaptador Stripe que já existe (`stripe-psp.js`), com Connect — então
o fluxo de fundos é o mesmo do Pix: **destination charge** direto pra conta
conectada do restaurante, sem custódia nossa (inegociável #4). Não há PSP novo
pra onboardar.

- `payment_method_types: ['bizum']`, explícito. O `automatic_payment_methods`
  ofereceria tudo que a conta tem habilitado, e o **Express Checkout Element não
  suporta Bizum** — o front precisa do Payment Element.
- `on_behalf_of` junto do `transfer_data`. Sem isso, o comerciante que aparece
  no app do banco do cliente é a plataforma; com isso, é o restaurante.
- Confirmação é **assíncrona**: o cliente autoriza no banco e a confirmação
  chega por webhook. Mesma forma do Pix, então o ledger event-sourced não muda.
- Limites do esquema conferidos no adaptador **e** na tela: 0,50 € a 5.000 €.
  O teto é real e a conta de uma mesa grande pode encostar nele.
- Reembolso total e parcial, assíncrono, até 395 dias. Disputa em até 120 dias.
- `method: 'bizum'` no ledger, **não** `'card'`: é pagamento em tempo real entre
  contas, a mesma família do Pix. Rotular como cartão contaminaria o painel, a
  ativação por método e a conciliação.

## Espanha está construída e NÃO está ligada

`RACHA_ES_ENABLED` não setado = **nenhuma cobrança espanhola sai**
(`chargingAllowed` em `markets.js`). A apresentação funciona, então as telas são
revisáveis; o dinheiro não se move. É o mesmo desenho do `CRON_SECRET` na
revisão #37: "não configurado" é recusa, não permissão.

Dois motivos, os dois da revisão de compliance de 2026-09-07, e **nenhum é
código**:

### 1. Disputa: quem fica sem o dinheiro muda

O Bizum tem **120 dias corridos** de reclamação (fraude, pagamento duplicado,
divergência de valor), 40 dias pra apresentar prova e 90 pra decisão. A Stripe
retém o valor disputado do saldo — e numa **destination charge**, é o saldo da
PLATAFORMA. Recuperar exige reversão de transferência mais cláusula de regresso
no contrato do restaurante.

Isso **não** é conta-bolsão: o pagamento continua liquidando na conta conectada,
com `on_behalf_of`, e a plataforma nunca é a comerciante de liquidação. Mas
*muda quem fica sem o dinheiro* quando dá errado, e o inegociável #4 diz que
mudança de fluxo de fundos passa por **parecer de advogado de pagamentos
ANTES**. A janela do Pix (MED) é muito mais curta, então isto é novo.

Pendências: o parecer, a cláusula de regresso no contrato, e tratar
`charge.dispute.created` no webhook (hoje não é tratado).

### 2. GDPR capítulo V: o banco está em São Paulo

Dado pessoal de titular europeu indo pro Brasil precisa de cláusulas-padrão
(art. 46) e avaliação de impacto da transferência, ou de um projeto Supabase em
região da UE — que é a correção técnica que dispensa a maior parte da papelada.

O que atravessa hoje: `payerLabel` (nome livre, persistido), e nome + telefone
da carteira da casa (`/api/house/open`, que **não** é gated por mercado). Além
disso faltam: registro do art. 30 pros fluxos espanhóis, aviso do art. 13 em
espanhol, DPA do art. 28 com cada casa espanhola (a Racha é operadora do dado
do cliente da casa), e representante do art. 27 sem estabelecimento na UE.

E o `payerLabel` não tem prazo de retenção nem caminho de exclusão em lugar
nenhum — um nome preso a um pagamento guardado pra sempre falha o art. 5(1)(e).

## O que ainda falta pra Espanha ir ao ar

Anotado aqui pra não parecer pronto:

1. **O elemento de pagamento do Bizum no front.** O `StripeWalletPay` usa o
   Express Checkout Element, que não serve. Precisa do Payment Element com
   `bizum`, o campo de telefone dele e o estado de espera ("confirma no app do
   teu banco") — as chaves de tradução já existem (`bizum.*`).
2. **Onboarding espanhol de recebimento.** O formulário de recebedor é
   Pagar.me/Brasil: agência, conta, dígito, código de compensação. Em Espanha é
   IBAN e a conta conectada é da Stripe. A tela precisa ser por mercado.
3. **Capacidade `bizum_payments`** ativa na conta da plataforma **e** em cada
   conta conectada. Fica `pending` até a Stripe verificar o onboarding do Bizum.
4. **IVA e fatura.** Uma conta paga por várias pessoas continua sendo uma
   operação do restaurante; confirmar com contabilidade espanhola como a fatura
   simplificada trata pagamento fracionado.
5. **A landing.** A cópia espanhola fala de Bizum onde a portuguesa fala de Pix,
   o que amarra a mensagem ao IDIOMA e não ao mercado. Aceitável numa página de
   marketing, errado em qualquer outro lugar — é decisão de cópia.
6. **O app iOS é só Brasil.** Português, Pix, `Cents` em BRL. Nada aqui mexeu
   nele.
7. **A tela de "pago" não identifica comerciante.** Uma conta paga por várias
   pessoas não divide o IVA: a casa emite **uma** fatura simplificada da mesa, e
   o cliente mantém o direito à fatura completa com o NIF dele (RD 1619/2012).
   Nossa tela precisa ler como **justificante de pago**, nomeando a casa e o
   NIF dela — e **não** parecer uma fatura, o que também mantém a Racha fora do
   escopo do Verifactu / SIF (RD 1007/2023), uma obrigação bem maior pra entrar
   por acidente.
8. **`/api/house/open` não é gated por mercado** — a carteira da casa coleta
   nome e telefone, e em Espanha isso entra no problema de residência de dado
   acima antes de qualquer outra coisa.
