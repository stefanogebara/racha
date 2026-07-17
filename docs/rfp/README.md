# PSP RFP — Racha (pay-at-table, Pix-first split)

Drafts para o founder enviar. **Não enviados** — revise, preencha os
`[placeholders]` e mande pelo canal comercial/parcerias de cada PSP.

## Antes de enviar (só você decide)
- [ ] Entidade legal + CNPJ que assinará o contrato (holding/Seatable ou nova PJ)
- [ ] Trimestre real de início do piloto
- [ ] TPV projetado — os números abaixo são estimativa de planejamento da pesquisa, confira antes de citar
- [ ] Telefone de contato
- [ ] Opcional: assinar NDA antes de receberem tabela de preços fechada

## Onde enviar
- **Pagar.me (Stone):** pagar.me → "Falar com especialista" / parcerias; ou seu contato Stone se já houver relação.
- **Iugu:** iugu.com → comercial / "Fale com um especialista".
- **Zoop:** zoop.com.br → comercial / parcerias (BaaS).

---

## Bloco comum (idêntico nos três — para respostas comparáveis)

**O que precisamos (requisitos técnicos):**
1. **Pix cobrança dinâmica** — QR por transação, `txid` único, confirmação por webhook, liquidação D+0.
2. **Split de liquidação** — subconta por restaurante como recebedor liquidante; a taxa da Racha como recebedor de tarifa; **a Racha nunca custodia recursos** em nenhum momento do fluxo.
3. **Cartão (crédito/débito)** como alternativa, via campos hospedados pelo PSP (escopo PCI mínimo do nosso lado).
4. **Webhooks assinados** — confirmação, devolução e expiração, com idempotência.
5. **Devolução Pix** (parcial e total) via API + tratamento de MED.
6. **Onboarding de subcontas por API** (KYC dos restaurantes).

**Perguntas comerciais (por favor respondam numeradas):**
1. MDR no nosso volume projetado: **Pix (%), débito (%), crédito à vista (%), crédito parcelado (%)**.
2. **Tarifa fixa por transação** (ex.: R$0,99): existe? Num split, quem a suporta — plataforma, recebedor, ou é configurável?
3. **Split:** conseguimos definir recipients por transação, com o restaurante como recebedor liquidante e a Racha como recebedor de tarifa? O split em **Pix liquida D+0**?
4. **Prazos de liquidação** por meio (Pix, débito, crédito) e **custo de antecipação** (% a.m.).
5. **Gorjeta:** conseguimos destinar uma parcela como gorjeta liquidada na conta do **próprio restaurante (CNPJ)**, separada do consumo, para processamento em folha (Lei 13.419/2017)? Sem recebedor de terceiro (nunca no Pix pessoal do garçom).
6. **Devolução e risco:** API de devolução Pix (parcial/total) + webhook; tratamento de MED; **alocação de responsabilidade por fraude/chargeback** no split (quem arca).
7. **Custódia (crítico):** confirmam que, no modelo de split de vocês, a Racha atua como **camada tecnológica e nunca se torna titular/custodiante** dos recursos — de forma a permanecer **fora do perímetro de autorização de IP (Res. BCB 494/2025)**?
8. **Subadquirência:** a partir de qual volume passamos a ter obrigações de **registro de recebíveis (CERC/TAG)** e liquidação em grade (CIP)? Vocês assumem isso ou passa a ser nosso?
9. **Onboarding:** documentação exigida e **prazo médio para ativar a subconta** de um restaurante; é 100% via API?
10. **Webhooks:** esquema de assinatura, eventos disponíveis, política de retentativa/idempotência.
11. **Vale-refeição (VR/VA):** suportam aceitação hoje ou no roadmap?
12. **Integração e contrato:** sandbox disponível? Prazo típico de homologação? **Tarifas de setup, mensalidade e mínimos contratuais?**

**Volume e prazo (planejamento):** piloto de **~20 restaurantes em São Paulo** (ticket médio de mesa R$300–600), migrando ~20–30% das contas para o fluxo QR — na ordem de **R$400–700 mil de TPV/mês no piloto**, com meta de **100–500 casas em 12 meses**. Ticket médio por transação R$40–120, majoritariamente Pix.

---

## Email 1 — Pagar.me (Stone)

**Assunto:** Parceria de split (Pix-first) para pay-at-table — Racha

Olá, time Pagar.me,

Somos a **Racha**, um novo produto de **pagamento na mesa** para restaurantes: o cliente escaneia um QR na mesa, vê a conta, **divide como quiser e paga por Pix** (cartão como alternativa), sem app e sem cadastro. Construímos sobre um **PSP licenciado com split de liquidação** — a Racha **nunca custodia recursos**: o dinheiro liquida direto na subconta de cada restaurante e a nossa taxa é apenas um recebedor do split. Iniciamos um piloto com ~20 restaurantes em São Paulo em **[Qx/2026]**, escalando para 100–500 casas.

O **Split de Pagamentos da Pagar.me** está na nossa shortlist pela maturidade do split em Pix e cartão e pela cobertura de adquirência da Stone. Para conseguirmos comparar propostas de forma objetiva, seguem nossos requisitos e perguntas:

_[colar o Bloco comum acima]_

Conseguimos 30 min esta ou próxima semana? Assino NDA se preferirem compartilhar a tabela fechada. Obrigado!

[Stefano Gebara]
[cargo] · Racha (grupo [holding])
[telefone] · stefanogebara@gmail.com · seatable.one

---

## Email 2 — Iugu

**Assunto:** Split multi-recipient (Pix-first) para pay-at-table — Racha

Olá, time Iugu,

Somos a **Racha**, um novo produto de **pagamento na mesa** para restaurantes: o cliente escaneia um QR, vê a conta, **divide e paga por Pix** (cartão como alternativa), sem app e sem cadastro. Rodamos sobre um **PSP licenciado com split** — a Racha **nunca custodia recursos**: liquidação direta na subconta de cada restaurante, com a nossa taxa como um recebedor do split. Piloto com ~20 restaurantes em São Paulo em **[Qx/2026]**, escalando para 100–500 casas.

A **Iugu** está na nossa shortlist pelo **split de pagamentos multi-recebedor** e pela gestão de subcontas/onboarding para marketplaces. Para compararmos propostas objetivamente, seguem requisitos e perguntas:

_[colar o Bloco comum acima]_

Conseguimos 30 min esta ou próxima semana? Assino NDA se necessário. Obrigado!

[Stefano Gebara]
[cargo] · Racha (grupo [holding])
[telefone] · stefanogebara@gmail.com · seatable.one

---

## Email 3 — Zoop

**Assunto:** Subadquirência white-label + split (Pix-first) — Racha

Olá, time Zoop,

Somos a **Racha**, um novo produto de **pagamento na mesa** para restaurantes: QR na mesa → ver a conta → **dividir e pagar por Pix** (cartão como alternativa), sem app e sem cadastro. Operamos sobre um **PSP licenciado com split de liquidação** — a Racha **nunca custodia recursos**: liquidação direta na subconta de cada casa, nossa taxa como recebedor do split. Piloto com ~20 restaurantes em São Paulo em **[Qx/2026]**, escalando para 100–500.

A **Zoop** está na nossa shortlist pela stack **white-label/BaaS de subadquirência** e pela experiência com split em operações de food de alto volume. Para comparação objetiva de propostas, seguem requisitos e perguntas — e, no caso de vocês, uma pergunta extra sobre modelo:

_[colar o Bloco comum acima]_

> **Extra (Zoop):** no modelo white-label, quem é o **titular regulatório** da operação de pagamento — a Zoop, ou passaríamos a atuar como subadquirente/IP com obrigações próprias de autorização junto ao BACEN? Buscamos deliberadamente permanecer como **camada tecnológica sem custódia**.

Conseguimos 30 min esta ou próxima semana? Obrigado!

[Stefano Gebara]
[cargo] · Racha (grupo [holding])
[telefone] · stefanogebara@gmail.com · seatable.one

---

## Scorecard — preencher quando as respostas chegarem

| Critério | Peso | Pagar.me | Iugu | Zoop |
|---|---|---|---|---|
| MDR Pix (%) | alto | | | |
| MDR crédito à vista (%) | médio | | | |
| Tarifa fixa/transação + quem arca | alto | | | |
| Split Pix liquida D+0? | alto | | | |
| Gorjeta separada p/ CNPJ do restaurante | **crítico** | | | |
| Racha sem custódia (fora do perímetro Res. 494) | **crítico** | | | |
| Devolução Pix + MED + alocação de risco | alto | | | |
| Onboarding subconta 100% via API + prazo | alto | | | |
| Webhooks assinados + idempotência | médio | | | |
| Sandbox + prazo de homologação | médio | | | |
| VR/VA hoje ou roadmap | baixo | | | |
| Setup / mensalidade / mínimo | médio | | | |

**Decisão gate:** os dois critérios *críticos* (gorjeta ao CNPJ do restaurante e Racha-sem-custódia) são eliminatórios — um PSP que não os atende sai, independente de preço.
