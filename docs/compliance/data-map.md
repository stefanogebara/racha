# Mapa de dados — quem toca dado pessoal, e por quê

> **Por que este arquivo existe.** Em 2026-09-07 uma conta de Pix brasileira
> estava carregando `js.stripe.com` — o `@stripe/stripe-js` injeta o script no
> IMPORT, então bastava o componente existir na árvore, mesmo devolvendo
> `null`. O conserto técnico foi de uma linha (`/pure`). O achado atrás do
> achado foi outro: **ninguém sabia que a Stripe era destinatária porque nada
> no repositório listava destinatários.** Não havia onde olhar e descobrir que
> estava errado. Registro do art. 37 da LGPD — e, antes disso, a lista que a
> gente mesma precisa pra revisar.
>
> Mantido honesto por `api/__tests__/data-map.test.js`: toda dependência de
> runtime e todo host literal no código tem que aparecer aqui. Uma dependência
> nova que fale com fora quebra o teste até alguém decidir o que ela vê.

Papéis, porque mudam tudo o que vem depois:

- **Do cliente na mesa**, a Racha é **operadora**; a controladora é a casa. O
  que a gente faz com esse dado é o que a casa contratou (fechar a conta).
- **Do dono e da casa**, a Racha é **controladora** — cadastro, dados
  bancários, avisos. Base: execução de contrato (art. 7º V).

---

## 1. O que a gente guarda

| Dado | De quem | Pra quê | Base legal | Onde mora | Prazo |
|---|---|---|---|---|---|
| `payments.payer_label` — nome livre que a pessoa digita ("Ste", "mesa toda") | cliente | dizer no painel e no comprovante quem pagou qual parte | operadora, por conta da casa (art. 7º V da casa) | Supabase `payments` | **sem prazo definido — lacuna 1** |
| `payments.psp_payload_masked` — subconjunto ESCALAR do webhook | cliente | reconciliar e reproduzir o histórico | operadora | Supabase `payments` | segue a conta |
| `house_accounts.phone` + `.name` | cliente que abre carteira pré-paga | achar a carteira dele na casa e saber de quem é o saldo | operadora | Supabase `house_accounts` | **sem prazo — lacuna 1** |
| `check_views.session_hash` | ninguém — aleatório do navegador | contar quantas pessoas ABREM a conta (portão de adoção) | interesse legítimo (art. 7º IX), minimização por construção | Supabase `check_views` | segue a conta |
| `venues.cnpj`, `venues.notify_email`, `venues.notify_whatsapp` | dono | cadastro, KYC do recebedor, aviso de status | controladora, contrato (art. 7º V) | Supabase `venues` | vida do contrato |
| e-mail e senha do dono | dono | login do painel | controladora, contrato | Supabase Auth (GoTrue), `auth.users` | vida do contrato |
| dados bancários da casa (banco, agência, conta, titular) | casa | criar o recebedor no PSP | controladora, contrato | **não persistidos aqui** — vão do formulário direto pro PSP | n/a |

## 2. O que sai, pra quem

| Destinatário | O que sai | Por quê | Onde processa |
|---|---|---|---|
| **Supabase** (`ckforlwdhewexyqljsaf.supabase.co`) | tudo da tabela acima | é o banco | AWS, região do projeto (**hoje fora da UE — ver lacuna 3**) |
| **Vercel** | requisições, logs de função | hospedagem | EUA/edge |
| **Pagar.me** (`api.pagar.me`) | CPF do pagador quando informado, `payerLabel` dentro da descrição da cobrança (`Racha <label>`), valor, split | criar a cobrança Pix/cartão e liquidar direto pra casa | Brasil |
| **Stripe** (`connect.stripe.com`, `js.stripe.com`, `m.stripe.com`) | dados do cartão/carteira **direto do navegador do cliente pra eles** (nunca pelos nossos servidores), valor, moeda, id da conta conectada | trilho de cartão/Apple/Google Pay e o mercado espanhol | EUA + UE |
| **Google Pay** (`pay.google.com`) | o que a folha da carteira do sistema operacional troca com o Google | botão de carteira | Google |
| **Saipos** (`order-api.saipos.com`) | id da loja, id da conta, valores | ler a conta do PDV e escrever a baixa | Brasil |
| **Olímpia / Seatable** (`seatable.one`, `RACHA_NOTIFY_URL`) | `venueName`, `ownerEmail`, `ownerPhone` no aviso de status do recebedor; `{token, event}` no farol da prévia | avisar o dono por WhatsApp/e-mail quando o KYC anda; radar de vendas | Brasil |

**Sobre a última linha:** o não-negociável 10 do `CLAUDE.md` proíbe
compartilhar dado com o Seatable sem consentimento. O que sai hoje é **dado do
dono, não do cliente**, e sai pra operar o contrato dele (avisar que o
recebedor foi aprovado). Nenhum dado de cliente atravessa. Isso mantém a
separação das holdings, mas **precisa estar no contrato da casa** — hoje não
está escrito em lugar nenhum. Lacuna 4.

## 3. O que deliberadamente NÃO sai e NÃO fica

Cada linha aqui é uma defesa que existe no código, não uma intenção:

- **PAN nenhum passa pelos nossos servidores.** Os campos de cartão são da
  Stripe, no navegador do cliente. Escopo PCI mínimo (`CLAUDE.md` 9).
- **CPF do pagador não é persistido.** `create-charge.js` normaliza, valida 11
  dígitos e **repassa** pro Pagar.me; nenhuma coluna o recebe.
- **A Stripe não recebe o CPF.** `stripe-psp.js` aceita `payerDocument` e
  descarta de propósito (`void payerDocument`) — é dado do trilho brasileiro.
- **Payload cru de webhook não entra no banco.** `maskPixPayload`
  (`api/_lib/pay/mask.js`) é lista de permissão de campos **escalares**: todo
  objeto aninhado morre, então `billing_details.phone` e nome completo não têm
  como chegar. É por isso que o telefone do pagador do Bizum não é armazenado.
- **Cliente nunca autentica.** Sem login, sem app, sem cadastro pra pagar.
- **`check_views` não tem dado pessoal.** `session_hash` é aleatório do
  próprio navegador — não é IP, não é impressão digital.
- **A Stripe não é carregada em conta que não usa cartão.** `/pure` + `lazy`;
  garantido pelo censo em `apps/web/test/bundle.test.ts`.

## 4. Lacunas — o que falta, nomeado

1. **Sem prazo de retenção e sem caminho de exclusão.** `payer_label`,
   `house_accounts.phone`/`name`: nada expira, nada apaga. Um nome preso a um
   pagamento guardado pra sempre falha o art. 6º I/III e, na Espanha, o art.
   5(1)(e) do GDPR. Fecha com: prazo por fluxo + job de expurgo + rota de
   pedido do titular (art. 18).
2. **Sem aviso de privacidade voltado pro cliente.** A tela da conta não diz
   quem trata, pra quê, e pra quem vai (art. 9º). Fecha com: um link "seus
   dados" na tela da conta, no idioma do leitor.
3. **Transferência internacional sem papelada.** Dado de titular europeu no
   Supabase fora da UE e acessível do Brasil (LGPD art. 33; GDPR cap. V).
   Fecha com: projeto Supabase em região da UE (correção técnica que dispensa
   a maior parte) ou cláusulas-padrão + avaliação. Ver `docs/markets/README.md`.
4. **Sem DPA com as casas.** A Racha é operadora do dado do cliente da casa e
   não há contrato de tratamento (art. 39 LGPD / art. 28 GDPR), nem menção ao
   repasse pro Seatable. Fecha com: anexo de tratamento no contrato da casa.
5. **Sem encarregado (DPO) publicado** (art. 41), e sem representante na UE
   (art. 27 GDPR) enquanto a Espanha estiver ligada.

Nenhuma dessas bloqueia o piloto brasileiro assistido. As lacunas 2 e 4
bloqueiam o primeiro QR numa mesa de cliente de verdade; as 3 e 5 bloqueiam
ligar a Espanha (`RACHA_ES_ENABLED`).

## 5. Dependências de runtime, classificadas

O teste exige que toda dependência apareça aqui. "Fala com fora" é a pergunta
que ninguém tinha feito sobre o `@stripe/stripe-js`.

- `@supabase/supabase-js` — **fala com fora**: nosso banco e nosso auth.
- `stripe` (servidor) — **fala com fora**: cria PaymentIntent, lê a conta conectada.
- `@stripe/stripe-js` — **fala com fora, e no import**: por isso só entra por
  `/pure`, e só depois de `loadStripe(PK)`.
- `@stripe/react-stripe-js` — **não fala sozinho**: são componentes React em
  volta do objeto que o `stripe-js` carregou.
- `qrcode.react` — **local**: desenha o QR no canvas, offline.
- `react`, `react-dom` — **local**.
