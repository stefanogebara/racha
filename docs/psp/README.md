# PSP — decisão e ativação (2026-07-19)

## Decisão: Pagar.me (Stone)

Critérios do RFP (plano §7) aplicados aos finalistas:

| Critério | Pagar.me | Stripe BR | Zoop/Iugu |
|---|---|---|---|
| Pix cobrança dinâmica, barato, disponível JÁ | ✅ nativo | ⚠️ **invite-only p/ empresa BR** + ~1,19% | ✅ |
| Split direto pro restaurante (sem custódia) | ✅ recebedores (`rp_`), liable no recebedor | ✅ Connect (Pix×Connect não confirmado) | ✅ |
| Cartão + carteiras na web | ✅ cartão + **Google Pay documentado** (gateway tokenization, `gatewayMerchantId acc_`) | ✅✅ Apple+Google turnkey | ⚠️ fraco |
| Apple Pay web | ❌ hoje (Google Pay + Visa Click to Pay) | ✅ | ❌ |
| KYC/CNPJ brasileiro por venue | ✅ fluxo local | Connect Express | ✅ |

**Por quê Pagar.me ganha:** o wedge do Racha É o Pix — precisa ser barato e
existir hoje, e no Stripe o Pix para empresa brasileira está atrás de convite.
Split de recebedores resolve a regra de nunca-custodiar. Google Pay tem guia
oficial. Cartão nativo cobre o resto.

**O trade que estamos aceitando:** Apple Pay web não existe no Pagar.me hoje.
Plano: (a) diner de iPhone no Brasil usa Pix (todo mundo tem) ou o botão some
no modo real; (b) **fase 2**: pedir o invite de Pix do Stripe em paralelo —
se sair, Stripe vira adapter secundário SÓ para Apple Pay/cartão (a camada de
adapter já roteia por método; foi desenhada pra isso). Critério de saída do
Pagar.me: MDR não-negociável acima do mercado quando houver volume.

## O que já está pronto no código

- [`api/_lib/pay/pagarme-psp.js`](../../api/_lib/pay/pagarme-psp.js) — adapter
  real (orders v5): Pix com BR Code, cartão/Google Pay via `card_token`,
  split integral pro `rp_` do venue, gorjeta em `metadata.tip_cents`,
  **webhook verify-by-refetch** (o corpo do POST nunca é a verdade — a
  cobrança é re-buscada na API) + Basic Auth opcional do endpoint.
- Seleção por env no router: `RACHA_PSP=pagarme` liga o adapter;
  qualquer outro valor (ou ausência) mantém o mock — demo e testes intactos.
- Bateria de testes do adapter em `api/__tests__/pagarme-psp.test.js`.

## Ativação — passos do FUNDADOR (contas e chaves não são automatizáveis)

1. **Criar a conta**: <https://pagar.me> → cadastro com o CNPJ da holding.
   Peça acesso de **test mode** primeiro.
2. **Chaves**: Dashboard → Configurações → Chaves. Copie a `sk_test_...`.
3. **Vercel env** (projeto `racha`, Production + Preview):
   - `RACHA_PSP=pagarme`
   - `PAGARME_SECRET_KEY=sk_test_...` (depois `sk_live_...`)
   - `PAGARME_WEBHOOK_AUTH=racha:<senha-forte>` (a mesma que configurar no passo 4)
   - manter `RACHA_DEMO_MODE` **false/ausente** quando for live de verdade.
4. **Webhook**: Dashboard → Webhooks → novo endpoint
   `https://racha-gray.vercel.app/api/webhooks/psp`, eventos `charge.paid` e
   `charge.refunded`, Basic Auth = o mesmo `user:senha` do passo 3.
5. **Recebedor por restaurante**: Dashboard (ou API `POST /recipients`) →
   criar recebedor com CNPJ/banco do restaurante → copiar o `rp_...` →
   gravar em `venues.psp_recipient_id` (Admin do Racha ou Supabase Studio).
6. **Google Pay real**: no [guia Google Pay do Pagar.me]
   (https://docs.pagar.me/docs/google-pay-tm-guide): tokenization
   `PAYMENT_GATEWAY`, `gateway: "pagarme"`, `gatewayMerchantId: "acc_..."`
   (o account id do dashboard). Com isso a sheet de demo do front troca pelo
   botão real (Google Pay JS) — mudança pontual em `WalletPay.tsx
   authorize()`; me chama que eu faço quando as chaves existirem.
7. **Validar em test mode** (checklist de aceite):
   - [ ] Pix: cobrança criada → QR pago no simulador → webhook →
         `payments.status='confirmado'`, `method='pix'`, split aparece no
         extrato do recebedor de teste.
   - [ ] Gorjeta: pagar com serviço → `tip_cents` certo no ledger.
   - [ ] Cartão de teste aprovado e recusado (402 pro diner).
   - [ ] Reembolso TOTAL via dashboard → ledger registra `PAYMENT_REFUNDED`.
   - [ ] Reembolso PARCIAL: **validar mapeamento** (v1 assume total; se o
         parcial vier diferente do esperado, ajustar o adapter — item aberto).
   - [ ] Campos da resposta batem com o adapter (qr_code, expires_at,
         charges[0].id) — qualquer divergência de nome de campo é ajuste de
         5 min no adapter.
8. **Ir a live**: trocar `sk_test_` → `sk_live_`, repetir o passo 7 com uma
   cobrança de R$ 1,00 real, ligar os recebedores reais.

## Segurança

- A `sk_` NUNCA entra no repo nem no chat — só Vercel env / `.env` local.
- O endpoint de webhook não confia no corpo: re-busca por id. **O webhook do
  Pagar.me chega SEM Authorization** (verificado nos logs, 2026-07-20) —
  `PAGARME_WEBHOOK_AUTH` foi removido; a defesa é o verify-by-refetch.
- Loads do saldo da casa continuam **só Pix** mesmo com cartão ligado
  (fraude de chargeback em crédito pré-pago).

## Estado do aceite em test mode (2026-07-20)

| Perna | Status |
|---|---|
| Cartão aprovado → webhook → ledger (+gorjeta separada) | ✅ `ch_nP9yAPKpF2FKEJM1`: pago 6000→6500, tip 100 |
| Cartão recusado (CVV 6xx) → 402, ledger intacto | ✅ |
| Estorno via dashboard → `charge.refunded` → ledger | ✅ `ch_nP9y…`: 500+100 de gorjeta devolvidos, pago 6500→6000, 0 anomalias |
| Pix → auto-pago (simulador) → webhook → ledger | ✅ `ch_O4W0…`: pago 6000→6700 (+700, gorjeta 70 separada) |
| Split / recebedor | ✅ **VERIFICADO 21/07** — suporte liberou o sandbox; `split-acceptance.mjs` verde ponta a ponta: recebedor `re_cmrv0ll6r…` criado `active`, cobrança dividida `ch_xeEOGg…` aceita, Pix pago (R$200 + gorjeta R$20 separada) confirmado no ledger. **Dois aprendizados de campo**: (1) recebedor exige `email`; (2) **o id do recebedor vem com prefixo `re_`, não `rp_`** — o adapter assumia `rp_` e rejeitava a resposta VÁLIDA (fix: aceita `/^r[ep]_/`). Saldo do recebedor ficou R$0 logo após (simulador não credita balance na hora — em live o `split-smoke-live.mjs` confirma o repasse real). |

Notas do ambiente de teste (suporte, 20/07):
- Pix em test mode: Configurações → Meios de pagamento → Pix → **provedor
  Simulador**. Regra do simulador: **< R$ 500 auto-paga, ≥ R$ 500 falha**
  (produção não tem essa regra — não é bug em teste com valor alto).
- Com provedor Simulador o `qr_code` vem como URL de página de pagamento;
  com provedor homolog/produção vem o **copia-e-cola EMV real** (`000201…
  br.gov.bcb.pix…`) — confirmado nos dois modos; o adapter serve o que o
  provedor der.
- Split: o toggle em Configurações → Funcionalidades só funciona depois que
  o comercial marcar o cadastro como marketplace internamente.

Aprendizados de campo já codificados no adapter: gateway exige CPF **nos dois
trilhos** — a doc do Pix lista `name`/`email`/`document`/`phones` como
obrigatórios (`docs.pagar.me/reference/pix-2`, conferido 2026-09-07), então o
checkout pede CPF pra Pix também e isso NÃO é coleta excessiva; era o que a
frase antiga ("checkout de cartão pede CPF") dava a entender —, telefone e
billing_address do customer; dedup de customer por e-mail (e-mail único por
cobrança); simulador decide recusa pelo **CVV 6xx**, não pelo número.
Pedido de suporte único: *"habilitar Pix e Split de pagamentos na conta
acc_d4zGpnxtxyFp2DyV (test mode; marketplace de pagamento na mesa com
repasse a restaurantes)"*. Cobranças de teste órfãs (retries de webhook dos
primeiros aceites) podem retro-confirmar no ledger da mesa demo — esperado
e inofensivo.

## Bateria de split + smoke de produção (D0)

Dois harnesses, um pra cada ambiente. Ambos criam dono efêmero/sessão via
service-role (sem senha) e provam a MESMA cadeia: recebedor → cobrança
dividida aceita → pagamento confirmado → **repasse no saldo do recebedor**
(endpoint novo `GET /api/psp/recipient/balance`, owner-gated, read-only).

**Test mode — [`scripts/split-acceptance.mjs`](../../scripts/split-acceptance.mjs)** (autônomo, dados sintéticos, auto-limpa):
```
node scripts/split-acceptance.mjs           # base default: racha-gray.vercel.app
```
Cria venue+recebedor de TESTE+mesa+conta, paga Pix <R$500 (Simulador
auto-paga), confere ledger e saldo, apaga tudo. **Hoje trava na prova nº1**
(criar recebedor) enquanto o sandbox não liberar — ver tabela acima.

**Live / D0 — [`scripts/split-smoke-live.mjs`](../../scripts/split-smoke-live.mjs)** (dinheiro REAL, casa REAL, nada é apagado):
```
node scripts/split-smoke-live.mjs --venue <venueId> --cpf <cpf-do-pagador> [--amount 100]
```
Pré-requisitos (go-live):
- Vercel: `PAGARME_SECRET_KEY=sk_live_…`, webhook **live** → `/api/webhooks/psp`,
  `VITE_PAGARME_PUBLIC_KEY`/Google Pay com a `pk_live_`.
- O **dono já criou o recebedor real** no admin (seção Recebimento) e o KYC
  está `active` — o smoke NÃO cria recebedor (dados bancários reais são do dono).

O smoke: autentica o dono (mint via service-role), exige recebedor `active`,
abre uma conta minúscula numa **mesa de treino** (fica fora dos números da
casa), cria a cobrança dividida real e **imprime o BR Code pra um humano pagar**
(não há Simulador em live), aguarda o webhook confirmar, e lê o saldo do
recebedor pra provar o repasse. Fecha só a conta de treino; venue e recebedor
permanecem. Plumbing validado 21/07 (auth + gate de recebedor); as demais
chamadas são as mesmas já verdes no test mode.
