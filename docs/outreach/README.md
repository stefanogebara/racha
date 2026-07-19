# Piloto Racha — roteiro de abordagem da Olímpia

Copy pronta pra Olímpia (agente de prospecção do Seatable) oferecer o piloto do
Racha. **Rascunho — não disparado.** Revise, ajuste o tom e o founder decide o
que vai pro registro de templates / style pack.

## Antes de usar (decisões e dependências)
- [ ] **Oferta do piloto:** o plano previa **2 meses grátis, sem risco**. Confirme antes de a Olímpia prometer.
- [ ] **Link da prévia:** hoje o demo é localhost — **precisa do deploy (Vercel)** pra virar link compartilhável. Até lá, a Olímpia descreve, não manda link.
- [ ] **Compliance WhatsApp:** lead DENTRO da janela de 24h (já conversou) → texto livre (abaixo). Lead FORA da janela / número novo → **template aprovado pela Meta** (seção no fim). Nunca dispare texto livre fora da janela.
- [ ] **ICP do piloto:** priorize quem já falou com a Olímpia e **disse não pro CRM/reservas** do Seatable — bar/casual vira ICP do Racha. Densidade > alcance: 2-3 bairros de SP.
- [ ] **Escalar preço pós-piloto → humano.** A Olímpia nunca inventa preço (regra da persona).

---

## 1. Abertura (texto livre, lead já conhece a Olímpia)

Escolha UMA. Curtas, um assunto, uma pergunta só (regras da persona).

**A — puxando pela dor (rush + gorjeta):**
> Oi [nome]! É a Olímpia 🙂 a gente tá testando com alguns restaurantes de SP uma
> forma do cliente fechar a conta sozinho — escaneia o QR da mesa, divide e paga
> no Pix em segundos, sem esperar a maquininha. A mesa vira mais rápido no rush e
> o garçom ainda recebe mais gorjeta. Posso te mostrar como fica?

**B — mais leve, pra quem já tinha dito não pro sistema de reservas:**
> Oi [nome]! Aqui é a Olímpia de novo. Isso aqui é uma coisa diferente do sistema
> de reservas — é só pra conta na mesa: o cliente paga no Pix escaneando um QR, na
> hora. Tá começando como piloto grátis. Faz sentido eu te explicar rapidinho?

---

## 2. Ramificações (conforme a resposta)

**"Como funciona?" / "Me explica":**
> Cada mesa ganha um QR. Quando o cliente quer pagar, ele aponta a câmera, aparece
> a conta, escolhe se paga tudo ou só a parte dele, e manda no Pix — cai direto na
> conta do restaurante. Sem app, sem cadastro, sem maquininha passando de mão em mão.

_(se o deploy já estiver no ar, emenda a prévia — o movimento que converte:)_
> Quer que eu monte uma prévia com a cara do [restaurante] pra você ver no celular?

**"Quanto custa?":**
> No piloto é de graça — a ideia é você testar sem risco por uns dois meses e ver
> se a galera adota. Preço a gente conversa depois, e só se fizer sentido pra você.
> _(Se insistir em número fechado → `escalar_humano`. Nunca invente valor.)_

**"Meus clientes não vão usar" / ceticismo (a objeção nº1, e é honesta):**
> Justo — é o que mais me perguntam. Por isso o piloto é grátis: você testa numa
> mesa ou duas, vê quantos clientes topam, e se não rolar não perdeu nada. Quem
> testou gostou de não ter que esperar a maquininha. Quer começar por uma mesa só?

**"Já uso [maquininha/sistema]":**
> Ele não substitui sua maquininha — roda junto, só pra quem prefere pagar no Pix
> pelo QR. Costuma ser mais barato que a taxa do cartão quando o cliente vai de Pix.
> Topa testar numa mesa e comparar?

**"É robô?" (responder na hora, sem mentir — regra da persona):**
> Sou a Olímpia, assistente virtual da Seatable 🙂 cuido do primeiro contato. Quem
> te acompanha no piloto é gente de verdade. Bora?

**Topou:**
> Show! Vou te passar pro pessoal que cuida dos primeiros restaurantes do piloto.
> Qual o melhor dia/horário pra uma conversa rápida (15 min)?
> _(→ `agendar_demo` com o que a pessoa disser sobre quando pode.)_

---

## 3. Template Meta (fora da janela de 24h / número novo)

Precisa de **aprovação da Meta** antes de usar (categoria Marketing, pt_BR,
`{{1}}` = nome do restaurante). Registrar em Abordagens depois de aprovado.

> Oi! Aqui é a Olímpia, da Seatable. Estamos abrindo um piloto **gratuito** em SP
> pra restaurantes testarem pagamento de conta na mesa por Pix — o cliente escaneia,
> divide e paga em segundos. Posso te contar como o **{{1}}** pode participar?

Botão sugerido: `Quero saber mais`.

---

## Notas de integração (build, não copy)
- A abertura pode virar um **style pack** novo da Olímpia (foco: Racha) ou um modo
  dedicado — hoje o prompt dela vende Seatable. Decidir se é a mesma agente com dois
  produtos ou uma persona separada.
- O template acima entra no **registro de Abordagens** (prospect_templates) só
  depois de aprovado pela Meta.
- A prévia do Racha (mock da conta da casa) é o análogo do `criar_demo` do Seatable —
  vale portar quando o deploy estiver no ar.
