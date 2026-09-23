# Onboarding de restaurante — playbook (2026-07-20)

Como cada restaurante entra na plataforma: o que perguntar, em que ordem,
quem faz o quê, e o que o produto precisa ganhar. Baseado em pesquisa de
mercado (BR: qlub, Zig, Meep, Goomer, iFood/iFood Pago, TagMe/Get In;
global: sunday, me&u, Toast, Qerko, Up 'n go, SumUp, inKind) + o que o
próprio build ensinou (aceite do Pagar.me, 2026-07-20).

## Princípios (síntese das duas pesquisas)

1. **"Assinou → operando" é A métrica, com dono.** sunday mede "lead time
   from signed to active" por praça; qlub prometeu 24h no lançamento BR.
   Meta Racha: **48h**, com UMA pessoa dona do go-live de cada casa.
2. **O restaurante fornece quase nada.** sunday pede literalmente cadastro +
   mapa de mesas; todo o resto (QR, KYC, config, treino) é white-glove.
   Cada artefato a mais pedido = dias a mais.
3. **Qualificação ANTES de KYC — sempre 2 estágios.** Todo o mercado BR
   pergunta o operacional primeiro (PDV? maquininha? faturamento? mesa ou
   comanda?) e só pede CNPJ/banco/sócio na ativação. Formulário com
   documento upfront = conversão morta.
4. **Sem PDV integrado não se promete conta espelhada.** O gargalo nº 1 do
   pay-at-table é o PDV (a qlub não opera sem integração; o escape dela é
   pré-pago). O modo manual + saldo da casa do Racha É o nosso escape —
   go-live padrão em 48h SEM PDV; integração é upgrade, não pré-requisito.
5. **Repasse claro e pontual é feature de venda.** O elogio nº 1 à Meep:
   "nunca atrasaram o repasse". A Get In retém 10% por até 30 dias e
   coleciona reclamação. Racha: split direto no recebedor do restaurante,
   D+1, extrato — falar isso EXPLICITAMENTE na venda.

## 1 · Descoberta comercial — o que perguntar (Olímpia ou visita)

Só operacional, zero documento (padrão qlub/Zig). Uma pergunta por mensagem
no WhatsApp:

1. Nome da casa + bairro/cidade
2. Quantas mesas? Movimento por dia (almoço/jantar)?
3. **Mesa ou comanda individual?** (define o fluxo de conta)
4. **Qual sistema/PDV usa?** (Colibri, Consumer, Saipos, nenhum…) — define
   manual vs integração futura
5. Qual maquininha/adquirente? Quanto paga de taxa? (dor + benchmark Pix)
6. Serviço/gorjeta: quantos %? Como distribui pra equipe?
7. Quem fecha a conta hoje — garçom na mesa ou caixa?
8. Faturamento mensal aproximado (faixa)
9. Já teve/quer programa de fidelidade ou pré-pago? (gancho saldo da casa)
10. Melhor dia/horário pra implantar sem atrapalhar o serviço

## 2 · Fluxo do piloto — D0 a D2, sales-assisted (checklist)

**D0 — o "sim" (30 min, no WhatsApp/visita)**
- [ ] (nós) Criar venue no admin: nome, cidade, serviço % — já existe
- [ ] (nós) Cadastrar mesas com os rótulos reais — já existe
- [ ] (dono) Enviar: CNPJ, razão social (Cartão CNPJ), **conta bancária PJ
      do CNPJ**, doc+selfie do sócio majoritário (padrão iFood Pago)
- [ ] (nós) **Disparar criação do recebedor Pagar.me JÁ** — é o único passo
      com latência (~3 dias úteis de análise); tudo corre em paralelo a ele
- [ ] (nós) Combinar data/hora do treino (pré-turno, 15 min)

**D1 — materiais + config**
- [ ] (nós) Gerar e imprimir displays de QR por mesa **com a marca da casa**
      (nunca deixar o dono imprimir A4 — mata a percepção; padrão qlub/sunday)
- [ ] (nós) Configurar saldo da casa se aderiu (bônus %, validade ≥30d)
- [ ] (nós) Teste ponta-a-ponta na conta demo da casa (Pix real em test/valor
      simbólico em live) — "o primeiro cliente real nunca é o primeiro teste"

**D2 — treino + go-live**
- [ ] (nós) **Workshop experiencial de 15 min pré-turno**: CADA garçom
      escaneia a **mesa de treino** no celular dele e percorre a conta até a
      hora de pagar — ela avisa que é treino e **não cobra** (ver
      `api/_lib/checks/mesa-de-treino.js`: antes cobrava Pix de verdade). O
      pagamento completo, até o ✓, se mostra na **demo** do site (método
      sunday — "a experiência dissolve o medo")
- [ ] (nós) Entregar o roteiro de 1 frase: *"Pode escanear o QR da mesa pra
      ver a conta e pagar quando quiser — o serviço vem junto e é opcional."*
      (é o mesmo texto do assistente de implantação, `wiz.staffLine` — um
      roteiro falado não tem versão, não tem idioma, não tem registro e não
      tem como ser retratado depois)
- [ ] (nós) **E a resposta pra quando o cliente perguntar pra onde vai o
      serviço:** *"o restaurante distribui à equipe, como manda a lei."* Essa
      frase, não uma variação. O garçom VAI ser perguntado, e sem resposta
      pronta ele usa a que tiver na cabeça.

      > A versão anterior deste item mandava o garçom dizer *"a gorjeta vai
      > direto pra gente"*. Isso afirma acerto direto com a equipe, que é o
      > arranjo que a Lei 13.419/2017 e o STJ Tema 1102 põem fora da lei — o
      > serviço é remuneração e passa pela folha, e a CLT art. 457 §6º ainda
      > permite à casa reter parte pros encargos. Dito por um funcionário na
      > mesa é também oferta vinculante (CDC art. 30) que a casa não tem como
      > honrar, e a exposição cai no CLIENTE, não em nós. A frase foi
      > corrigida no produto em 2026-09-13 e sobreviveu AQUI mais um dia,
      > porque este arquivo era a fonte de onde ela tinha sido copiada pro
      > dicionário e o censo não andava em `docs/`. Terceira vez na mesma
      > semana que um conserto pega o artefato e deixa a fonte.
- [ ] (dono/nós) Colocar displays nas mesas; primeira mesa real paga COM a
      gente presente; só declaramos "ativo" depois disso
- [ ] (nós) Grupo de WhatsApp da casa (dono + gerente + nós) = suporte

**Semana 1 — ativação**
- [ ] D+3 e D+7: mandar pro dono % de contas pagas via Racha + gorjetas por
      garçom (stats viram argumento pros garçons apresentarem o QR)
- [ ] **Gate do piloto: ≥25% das contas via QR na semana 1** (kill/park do
      plano) — medir por casa, agir na que ficar abaixo (re-treino, posição
      do display, incentivo)

## 3 · Setup wizard v1 (produto) — delta a construir

O admin já faz: venue, mesas+QR (com rotação), serviço %, saldo da casa,
conta manual (abrir/ajustar/fechar), passivo. Falta para o wizard:

| # | Feature | Por quê | Esforço |
|---|---|---|---|
| 1 | **PDF de QRs por mesa** (marca da casa, A6/display) no admin | materiais sem designer; padrão Toast (print partner OU download) | S |
| 2 | **Recebedor Pagar.me in-app** (form → POST /recipients com sk do servidor; status de análise visível) | hoje é manual no dashboard; é O passo com latência | M |
| 3 | Wizard 4 passos: casa → mesas → recebimento (recebedor) → equipe (roteiro+vídeo) | guia o assistido hoje, vira self-serve depois | M |
| 4 | **Métricas de ativação no painel**: % contas via Racha, gorjeta por garçom, série semanal | é o que mantém o garçom apresentando o QR (sunday: 83% de quem escaneia paga) | M |
| 5 | Modo treino por casa (conta fake que não suja o ledger) | workshop sem poluir números | S |
| 6 | Reset da conta demo (cron ou botão) | fixture demoracha esgota | S |
| 7 | QR no RECIBO via PDV (fase Colibri): QR dinâmico impresso na continha | padrão zero-logística (Qerko/Up 'n go/Toast Pay) — ativação same-day | L (junto c/ integração POS) |

Decisão de motion: **piloto 100% assistido** (mercado BR não tem self-serve
de pay-at-table; a Olímpia qualifica, humano fecha e implanta). Self-serve
só depois de 10+ casas ensinarem onde o wizard trava.

## 4 · Mercado — síntese dos concorrentes

| Player | Motion | Time-to-live | Materiais | O que copiar / evitar |
|---|---|---|---|---|
| **qlub BR** | sales-led, demo-first, WhatsApp; parceria Ticket como funil | prometeu 24h; hoje "poucos dias" c/ treino | QR por mesa fornecido, com marca da casa | copiar: qualificação operacional, QR entregue, treino incluso. Evitar: dependência de PDV (só opera integrada ou pré-pago) |
| **sunday** | sales-led; Onboarding Specialist dono do go-live | **7 dias**; KPI "signed→active" | QR personalizado produzido e ENVIADO | copiar: white-glove total, workshop mock-payment, stats de adoção (83%/70%) |
| **Toast Pay / Up 'n go / Qerko** | toggle/app-store | **mesmo dia** | QR no recibo (zero logística) | é o alvo da fase POS (item 7 acima) |
| **me&u** | sales-led | até 4 SEMANAS (cardápio = imposto) | pucks NFC brandados | pay-only não tem cardápio — nossa vantagem estrutural; proteger |
| **Zig / Meep** | proposta/consultivo; Meep tem SaaS self-serve R$58-317/mês | "poucos dias" | hardware próprio | Meep: reputação de repasse pontual = argumento que vamos igualar com split D+1 |
| **iFood Pago** | self-serve industrializado | análise ~3 dias úteis | — | é o TEMPLATE de KYC BR (selfie+doc sócio, CNPJ CNAE, conta PJ) — espelhar na coleta do recebedor |
| **Get In (→iFood)** | SaaS pré-pago | mesmo dia | zero (cliente compra tablet) | evitar: reter 10%/30 dias (Reclame Aqui); zero material físico |

**Movimentos estratégicos a monitorar:** (1) **iFood comprou a Get In
(mai/2026)** — entrando no salão com a maior base de restaurantes do país;
(2) **TagMe absorveu a Ditti** (pedido+pagamento na mesa) — o modelo Racha
já está sendo consolidado por players de reserva. Janela existe, mas não é
infinita — reforça piloto rápido com densidade de bairro.

## 5 · Perguntas em aberto

- Preço: setup fee é aceito no mercado (qlub cobra; Ticket dá 50% off como
  isca) — piloto grátis, mas a tabela pós-piloto precisa decidir
  setup + mensalidade + take rate (proposta no plano §3, validar nas casas).
- Recebedor live: fluxo real depende do comercial Pagar.me liberar
  marketplace (task #25) — o playbook D0 assume esse desbloqueio.
- VR/VA na mesa (qlub aceita Ticket/Alelo/etc.): demanda real? Perguntar
  nas 10 primeiras casas antes de qualquer build.
