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

- **Do cliente na mesa, pra FECHAR A CONTA**, a Racha é **operadora**; a
  controladora é a casa. O que a gente faz com esse dado é o que a casa
  contratou.
- **Do dono e da casa**, a Racha é **controladora** — cadastro, dados
  bancários, avisos. Base: execução de contrato (art. 7º V).
- **Do cliente, pros FINS DA PRÓPRIA RACHA**, a Racha é **controladora**
  também — e a primeira versão desta seção errava isso. Medir adoção
  (`check_views`, que serve ao portão do `CLAUDE.md`, não ao interesse da casa
  em fechar a conta), o radar de ativação e o farol de prospecção são
  finalidades NOSSAS. Interesse legítimo é base de controlador; operador não
  tem base própria, age por instrução. Quem determina a finalidade de uma
  operação é controlador dela (LGPD art. 5º VI/VII; GDPR art. 28(10), explícito).

Essa distinção muda o tamanho do conserto, e é por isso que ela está aqui e não
numa nota: um DPA com a casa **não cobre** tratamento que a Racha faz pra si.
Isso pede aviso do art. 9º da Racha e avaliação de legítimo interesse
documentada, em nome próprio. Ver lacuna 4.

---

## 1. O que a gente guarda

| Dado | De quem | Pra quê | Base legal | Onde mora | Prazo |
|---|---|---|---|---|---|
| `payments.payer_label` — nome livre que a pessoa digita ("Ste", "mesa toda") | cliente | dizer no painel e no comprovante quem pagou qual parte | operadora, por conta da casa (art. 7º V da casa) | Supabase `payments` | **90 dias depois de a conta fechar** — anonimizado pela 0031 |
| `payments.psp_payload_masked` — subconjunto ESCALAR do webhook (14 campos: txid, valores, status, horários) | cliente | reconciliar e reproduzir o histórico | operadora | Supabase `payments` | segue a conta |
| `house_accounts.phone` + `.name` | cliente que abre carteira pré-paga | achar a carteira dele na casa e saber de quem é o saldo | operadora | Supabase `house_accounts` | enquanto a carteira viver, **+ 90 dias** depois de zerada e inativa |
| `check_views.session_hash` | ninguém — aleatório do navegador | contar quantas pessoas ABREM a conta (portão de adoção) | interesse legítimo (art. 7º IX) — **e a lacuna 2 é PRÉ-CONDIÇÃO dela**, não item vizinho: o art. 7º IX é a única base que chega com dever de transparência (art. 10 §2) e direito de oposição (art. 18 §2). Sem o aviso, a base é alegada, não constituída | Supabase `check_views` | **90 dias** (migração 0031) — o portão de adoção olha 8 semanas, então guardar linha crua além disso era guardar por guardar. Agregar por casa/semana e apagar até a linha tiraria o `check_views` do perímetro quase inteiro, o que continua sendo melhor do que ganhar o teste de balanceamento |
| `retention_runs.txid` + as contagens | cliente cujo pedido de exclusão foi atendido | comprovar a execução da retenção e a resposta do art. 18 §4 | **controladora, em nome próprio** — art. 7º II c/c art. 16 I (obrigação legal) e art. 6º X (responsabilização). É o segundo fluxo em que a Racha trata pra si, junto com o `check_views`, e um DPA com a casa não cobre nenhum dos dois | Supabase `retention_runs` | 5 anos, executados pela própria purga |
| `venues.cnpj`, `venues.notify_email`, `venues.notify_whatsapp` | dono | cadastro, KYC do recebedor, aviso de status | controladora, contrato (art. 7º V) | Supabase `venues` | vida do contrato |
| e-mail e senha do dono | dono | login do painel | controladora, contrato | Supabase Auth (GoTrue), `auth.users` | vida do contrato |
| dados bancários da casa (banco, agência, conta, titular) | casa | criar o recebedor no PSP | controladora, contrato | **não persistidos aqui** — vão do formulário direto pro PSP | n/a |

## 2. O que sai, pra quem

| Destinatário | O que sai | Por quê | Onde processa |
|---|---|---|---|
| **Supabase — projeto de dados da Racha** (`SUPABASE_URL`, sem literal no código) | tudo da tabela acima, menos o login | é o banco | AWS, região do projeto (**hoje fora da UE — ver lacuna 3**) |
| **Supabase — projeto de auth do SEATABLE** (`ckforlwdhewexyqljsaf.supabase.co`) | e-mail do dono, hash de senha, identidade OAuth, sessão | login compartilhado entre os dois produtos (`apps/web/src/auth.ts`, `AUTH_SUPABASE_URL`) | AWS |
| **Vercel** | requisições, logs de função — **incluindo o `t` da mesa, que viaja na query string do `/api/check` e é consultado a cada 4s** | hospedagem | EUA/edge |
| **Pagar.me** (`api.pagar.me`) | CPF do pagador quando informado, `payerLabel` dentro da descrição da cobrança (`Racha <label>`), valor, split | criar a cobrança Pix/cartão e liquidar direto pra casa | Brasil |
| **Stripe** (`connect.stripe.com`, `js.stripe.com`, `m.stripe.com`) | dados do cartão/carteira **direto do navegador do cliente pra eles** (nunca pelos nossos servidores), valor, moeda, id da conta conectada | trilho de cartão/Apple/Google Pay e o mercado espanhol | EUA + UE |
| **Google Pay** (`pay.google.com`) | o que a folha da carteira do sistema operacional troca com o Google | botão de carteira — **só em casa que o servidor declarou `acceptsWallet`** | Google |
| **Saipos** (`order-api.saipos.com`) | id da loja, id da conta, valores | ler a conta do PDV e escrever a baixa | Brasil |
| **Olímpia / Seatable** (`seatable.one`, `RACHA_NOTIFY_URL`) | **cinco caminhos**, ver abaixo | avisos de operação e radar de vendas | Brasil — **e daí pra fora, ver as duas linhas seguintes** |
| **Resend** (suboperador da Olímpia) | o TEXTO do alerta de fundador: `txid`, `checkId`, valor, e nomes de casa em achado de conciliação | entregar o alerta por e-mail | EUA |
| **Meta — WhatsApp Cloud API** (suboperador da Olímpia) | o mesmo texto, exceto rotina (batida e `retention_ok`, que vão só por e-mail) | entregar o alerta por WhatsApp | EUA |

**Sobre a última linha, com precisão.** A primeira versão desta seção listava
dois caminhos e afirmava que "nenhum dado de cliente atravessa". São **cinco**
(`api/_lib/notify.js`), e a afirmação era falsa:

| função | o que sai |
|---|---|
| `notifyOwnerRecipientStatus` | `venueName`, `ownerEmail`, `ownerPhone`, `status`, `previousStatus`, `reason`, `pspRecipientId` |
| `notifyFounderMoneyEvent` | `event`, **`txid`**, **`checkId`**, **`amountCents`**, `detail`. Os `kind` são disputa e estorno (`dispute_opened`, `dispute_updated`, `dispute_funds`, `dispute_lost`, `account_alert`, `unusable_money_event`, `refund_failed`) mais os três da retenção (`retention_ok`, `retention_blocked`, `retention_late`), que levam só CONTAGENS — sem txid, sem casa |
| `notifyFounderReconcile` | o texto do alerta: nomes de casa e desvio por casa |
| `notifyFounderActivationRadar` | o resumo do radar de ativação |
| `notifyPreviaBeacon` | `{token, event}` do lead da Olímpia |

**Até 2026-09-12 esta transferência era TEÓRICA.** A ponte recusava todo evento
de fundador com 400, então nada era entregue — o mapa descrevia um canal que na
prática não transmitia nada. Consertar a ponte tornou a transferência real, e a
cadeia de suboperadores ficou duas pontas mais longa do que este mapa dizia:
identificador de pagamento pseudonimizado e detalhe financeiro por casa passaram
a sair pra dois processadores nos EUA, sob contrato da OUTRA empresa. É item do
art. 39 (a casa-controladora tem que poder conhecer a cadeia) e do art. 33
(transferência internacional), e reforça a lacuna 4.

Se a preferência for encolher o perímetro em vez de documentá-lo, a alavanca é
barata: nada num alerta de WhatsApp exige o `txid`. `kind` + "abra o painel" é
acionável, e o identificador fica só no e-mail.

`notifyFounderMoneyEvent` sai de `router.js` em SEIS pontos e leva o
identificador de pagamento de UM cliente específico, o identificador da conta
dele e o valor. `txid` resolve pro CPF do pagador no painel da adquirente, então
é identificável por meios razoáveis — não é dado anônimo por não trazer nome.

A posição defensável é que o Seatable é **suboperador de alertas**, e ela
provavelmente está certa. Mas posição defensável precisa estar escrita e no
contrato: o não-negociável 10 do `CLAUDE.md` proíbe compartilhamento entre os
produtos sem consentimento, e o mesmo vale pro login compartilhado da linha de
cima. Enquanto não estiver no DPA (lacuna 4), o que existe é uma prática sem
instrumento. A alternativa técnica é mandar alerta de fundador por um canal que
não seja o outro produto.

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
  objeto aninhado morre no filtro de TIPO, então `billing_details.phone` e nome
  completo não têm como chegar. É por isso que o telefone do pagador do Bizum
  não é armazenado.
  **Isto passou a ser verdade em 2026-09-10.** Até então havia um ramo que
  descia em `raw.pagador`/`raw.payer` e guardava `payer_hint` (primeiro nome
  inteiro + inicial do sobrenome) e `payer_doc_hint` (dois últimos dígitos do
  CPF) — e ele rodava em produção, porque o `mock-psp` emite `pagador` e a mesa
  da demo roda em produção. A primeira versão desta seção descrevia a defesa
  mais forte do que o arquivo. Os dois campos foram **apagados**, não
  documentados: ninguém os lia, e mascarado continua sendo dado pessoal (art.
  12). A resposta certa pra "o mapa não lista este campo" é quase sempre parar
  de guardá-lo.
- **Cliente nunca autentica PRA PAGAR.** Sem login, sem app, sem cadastro. A
  carteira da casa é a exceção e está na tabela do §1: quem abre carteira dá
  nome e telefone e passa a ter um token ao portador como credencial.
- **`check_views` não tem dado pessoal.** `session_hash` é aleatório do
  próprio navegador — não é IP, não é impressão digital.
- **A Stripe não é carregada em conta que não usa cartão**, e **o Google Pay
  não é carregado em casa sem recebedor.** `/pure` + `lazy` no primeiro,
  `venue.acceptsWallet` no segundo — os dois com bandeira POR CASA vinda do
  servidor, não com chave de build. Censo em `apps/web/test/bundle.test.ts`,
  que não pula mais quando falta build (pulava, e o mapa citava o pulo como
  garantia).
- **O token da mesa não vai pra Stripe.** `confirmParams.return_url` era
  `window.location.href`, que é `/?t=<qrToken>` — capacidade ao portador que lê
  a conta e cria cobrança, guardada pela Stripe no PaymentIntent. A volta agora
  é `/?r=1` e o token vem do `sessionStorage` da aba (`payReturn.ts`). O censo
  proíbe entregar `location.href` a qualquer SDK que persista a string.
- **O `/ios` não fala com o Google.** O protótipo publicado no domínio de
  produção linkava Google Fonts, mandando IP e User-Agent de cada visitante pra
  os EUA. A Archivo é servida daqui.

## 4. Lacunas — o que falta, nomeado

1. ~~**Sem prazo de retenção e sem caminho de exclusão.**~~ **Prazo, job e
   registro fechados em 2026-09-12**; a rota de autoatendimento continua aberta.
   `docs/compliance/retencao.md` tem a tabela por fluxo; a migração 0031 tem a
   função `purge_expired_personal_data()` — que ANONIMIZA em vez de apagar,
   porque o razão é event-sourced e destruir um pagamento destruiria a
   contabilidade da casa — e `/api/cron/retention` a chama uma vez por dia. O
   prazo que a função cumpre e o prazo que o aviso ao cliente promete estão
   amarrados por teste (`api/__tests__/retention.test.js`).
   E a migração 0032 fecha a metade que DETECTA: `retention_runs` grava uma
   linha por execução, **dentro da mesma transação do expurgo**, e o cron da
   conciliação — que já roda todo dia e já pagina — alerta se o último expurgo
   passar de 48h ou se nunca tiver havido nenhum. Sem isso, cron parado e cron
   sem nada pra apagar reportavam a mesma coisa (zero), e a diferença só existia
   na cabeça de quem lembrasse de conferir. É também o registro das operações de
   tratamento do art. 37, e o lugar durável pro comprovante de uma resposta do
   art. 18 §4 — que até aqui era uma linha no terminal de quem executou.
   **O que falta:** rota de autoatendimento do art. 18. Hoje o pedido passa pelo
   restaurante e a execução é manual com o `erase-payment-label.js` — aceitável
   num piloto assistido com poucas casas, inaceitável quando o produto for
   self-serve.
2. **Aviso de privacidade: o texto existe, o CANAL PRÓPRIO não.** Parcialmente
   fechada em 2026-09-12, e é importante não marcar como fechada. `PrivacyNotice.tsx`, no rodapé da tela da conta, nos três
   idiomas: quem é controlador (a casa, com a Racha como operadora), o que fica
   guardado e por quanto tempo, o que NUNCA chega aqui (cartão, CPF, cadastro),
   quem mais vê, e os direitos do art. 18. Fica na própria tela e não numa
   página à parte — o art. 9º pede informação acessível ANTES da decisão, e um
   link que tira a pessoa da tela de pagar é um link que ninguém toca no meio de
   um jantar. Cada frase aponta pra uma defesa que existe no código.
   **O que falta:** um endereço que receba mensagem. A primeira versão publicou
   `privacidade@racha.com.br`, que eu inventei — o `dig` devolve `MX 0 .`, o MX
   nulo da RFC 7505, quer dizer que o domínio declara que NÃO recebe e-mail.
   Cliente que escrevesse levava bounce, e é o mesmo erro do `racha.app` uma
   camada pior: lá a frase falsa concedia confiança, aqui prometia um direito a
   um consumidor na hora de pagar. Agora o endereço vem de
   `VITE_PRIVACY_CONTACT` e, sem ele, a frase do canal direto não é renderizada —
   o restaurante, que é o controlador do dado do pagamento, continua sendo rota
   de verdade. Mas pro que a Racha trata EM NOME PRÓPRIO (a contagem de
   aberturas) o contato tem que ser nosso, e isso exige uma caixa que exista.
   **Antes do primeiro QR numa mesa de cliente de verdade.**
3. **Transferência internacional sem papelada.** Dado de titular europeu no
   Supabase fora da UE e acessível do Brasil (LGPD art. 33; GDPR cap. V).
   Fecha com: projeto Supabase em região da UE (correção técnica que dispensa
   a maior parte) ou cláusulas-padrão + avaliação. Ver `docs/markets/README.md`.
4. **Sem DPA com as casas — e o DPA não é o conserto inteiro.** A Racha é
   operadora do dado do cliente da casa e não há contrato de tratamento (art. 39
   LGPD / art. 28 GDPR), nem menção ao login compartilhado com o Seatable nem
   aos cinco caminhos de alerta do §2. Fecha com **duas** coisas, não uma:
   anexo de tratamento no contrato da casa, **e** — pro que a Racha trata em
   nome próprio (adoção, radar, prospecção) — aviso do art. 9º e avaliação de
   legítimo interesse dela mesma.
5. **Sem encarregado (DPO) publicado** (art. 41), e sem representante na UE
   (art. 27 GDPR) enquanto a Espanha estiver ligada.
6. **Armazenamento no dispositivo sem consentimento, pra Espanha.** O
   `session_hash` do `check_views` é limpo como DADO (aleatório do navegador), e
   o art. 7º IX cobre o TRATAMENTO. O que ele não cobre é gravar no aparelho de
   quem visita: LSSI art. 22.2 / ePrivacy art. 5(3) exigem consentimento pro que
   não é estritamente necessário, e analítica de produto não é. Legítimo
   interesse não cura isso. Bloqueia a Espanha junto com as lacunas 3 e 5.
7. ~~**Google Pay carrega em toda conta brasileira.**~~ **Fechada em
   2026-09-10**, no mesmo dia em que foi aberta. `WalletPay.tsx` injetava
   `pay.google.com/gp/p/js/pay.js` e chamava `isReadyToPay` — sondagem de
   aparelho e carteira — antes de a pessoa escolher qualquer coisa, com portão
   só na chave de BUILD. Agora exige `venue.acceptsWallet`, que o `/api/check`
   emite apenas pra casa com recebedor `re_` de verdade e nunca pra mesa de
   demo — o mesmo contrato do `acceptsCard`. Censo em
   `apps/web/test/bundle.test.ts`, atravessando cliente e servidor.

8. **Sem Content-Security-Policy.** É o único controle que teria tornado o
   incidente do `js.stripe.com` IMPOSSÍVEL em vez de visível em retrospecto, e
   pegaria a Google Fonts do `/ios` e o `pay.js` junto. Não foi escrita ainda de
   propósito: adivinhar `connect-src` numa superfície de pagamento viva quebra
   PAGAR, não estilo. O método é o mesmo que este repositório usa pro resto —
   MEDIR primeiro: subir `Content-Security-Policy-Report-Only`, que por
   construção não quebra nada, colher uma semana da superfície real e só então
   impor a partir do que foi medido.
9. **O `t` da mesa vive nos logs da Vercel.** Ele viaja na query string do
   `/api/check`, consultado a cada 4 segundos por telefone. As duas pernas em
   que ele saía pra TERCEIRO foram fechadas (`Referrer-Policy` e o
   `return_url`); esta é interna, e a Vercel já é operadora nomeada com
   hospedagem como base. O que falta é prazo: log é mais um lugar onde uma
   capacidade ao portador mora sem expirar. Anda junto com a lacuna 1.

Nenhuma dessas bloqueia o piloto brasileiro assistido. Antes do primeiro QR numa
mesa de cliente de verdade ficam a **4** (DPA) e a metade que sobra da **2** (uma
caixa de correio que exista); as 3, 5 e 6 bloqueiam ligar a Espanha
(`RACHA_ES_ENABLED`).

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

Ferramentas de build e teste, que o censo também exige porque um import de
`devDependency` chega ao cliente igualzinho: `vite`, `@vitejs/plugin-react`,
`typescript`, `jest`, `@types/react`, `@types/react-dom`, `@types/node`,
`eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `typescript-eslint` —
**nenhuma fala com fora em runtime**; os tipos somem na compilação e o lint nem
chega a ser empacotado.

## 6. O app iOS

Escopo próprio porque os destinatários são outros. O app nativo
(`ios/Racha`) fala com `racha-gray.vercel.app` — a nossa própria API, mesmos
fluxos do §1 (e **não** com `racha.app`, que é de terceiro: ver `docs/domains.md`) —
e com três fornecedores de modelo:

| Destinatário | O que sai | Quando |
|---|---|---|
| `api.anthropic.com` | a conversa do assistente da mesa — itens da conta e os nomes que as pessoas digitaram — **e a FOTOGRAFIA DA CONTA**, em base64 (`AgentSession.swift:81`, `.image(mediaType: "image/jpeg")`, dirigida por `AgentTools.parseReceipt`) | só se a pessoa colar a PRÓPRIA chave em Ajustes (`settings.anthropicKey`); sem chave, roda o `MockTransport`, sem rede |
| `api.openai.com` | o NOME do prato, pra gerar a imagem | idem, `settings.openAIKey` |
| `generativelanguage.googleapis.com` | idem | idem, `settings.googleKey` |

**A fotografia é uma classe de divulgação diferente do transcrito**, e a
primeira versão desta seção descrevia só a parte arrumada — o mesmo erro do
`psp_payload_masked`. Uma nota brasileira carrega CNPJ, endereço, data e hora,
a mesa, às vezes um identificador do garçom, às vezes CPF na nota, e o que mais
estiver no enquadramento.

E **o consentimento vem da pessoa errada.** Quem cola a chave consente por si;
os titulares são as OUTRAS pessoas da mesa, cujos nomes foram digitados e cujos
pedidos estão na foto. Consentimento do art. 8º é pessoal e específico, e o dono
do aparelho não o fornece por elas. A tela de Ajustes informa modo e custo, e
nada sobre quem recebe o quê.

Então o que torna isto aceitável HOJE não é ser opt-in: é que ninguém fora do
fundador roda o app com chave. O gatilho pra rever não é "o dia em que a chave
for nossa" — é **o dia em que o app chegar na mão de terceiro com qualquer
chave**.

**A linha de cima só passou a ser verdade em 2026-09-10, e só ficou correta em
2026-09-11.** `TableQR.swift` aceitava QUALQUER origem `https` — e `http` —
impressa no QR, e o `BackendTableSource` buscava `{origemEscaneada}/api/check?t=…`
e desenhava a resposta como conta do Racha. Um adesivo colado sobre o QR de uma
mesa apontava o app pro servidor de outra pessoa com a credibilidade do app em
volta: a fraude de adesivo de QR brasileira de sempre, com o cliente nativo
retirando a única defesa que o navegador dava (a barra de endereço visível).
Enquanto isso valeu, esta seção **não conseguia enumerar os destinatários do
app** — ele falava com quem o adesivo mandasse. Agora há lista de permissão de
origem e `https` obrigatório em TODOS os caminhos: no QR escaneado, no código
digitado à mão (`defaultOrigin`), no `RachaEnvironment.origin` — cujo override
de QA passou a ser `#if DEBUG`, porque ele aceitava qualquer host e `http` junto
num build de release — e outra vez no `BackendTableSource`, imediatamente antes
de o pacote sair do aparelho.

A primeira versão desta correção guardava **um dos dois ramos** da mesma função,
e esta frase, escrita a partir do ramo que eu estava olhando, ficou mais estreita
que o código. As duas revisões acharam isso separadamente, e por isso a garantia
agora tem teste próprio (`RachaTests/TableQRTests`, incluindo `defaultOrigin`
hostil): frase e código falham juntos, ou a frase não vale. O padrão que produziu
isso está registrado em `docs/decisions/2026-09-10-frase-escrita-do-guarda-que-eu-olhava.md`
— aqui fica o que é verdade sobre ESTE controle.

**Alcance retroativo: zero, e não é de memória.** O caminho vulnerável só existia
no `BackendTableSource`, e `RachaEnvironment.isDemo` devolve `true` no simulador
e em qualquer build DEBUG — então `tableSource` entrega o `DemoTableSource`, que
não toca a rede. O comportamento antigo era **inalcançável em qualquer build que
não fosse Release**, e não apenas não-alcançado; isso se confere no
`RachaEnvironment.swift` para sempre, por quem não estava aqui. Somando: nenhum
build público existiu (sem fastlane, sem `ExportOptions.plist`, sem configuração
de App Store Connect no repositório — só a `ArchiveAction` padrão do Xcode), logo
nenhum titular exposto. Um registro do art. 37 tem que distinguir "alcance zero"
de "alcance desconhecido", e esta frase só se escreve quando é zero.

A conveniência que se perdeu era real: uma casa white-label imprimia o domínio
dela sem release do app. Ela volta quando a lista vier da NOSSA API com os
domínios efetivamente integrados — até lá, white-label passa por release.
Achado da revisão de segurança de 2026-09-10.

`ios/lab` e `docs/outreach` estão fora do censo de propósito — rascunho de
design e material de venda, que não sobem no domínio do produto. O
`docs/outreach/racha-apresentacao-dinhos.html` ainda linka Google Fonts; é um
arquivo aberto à mão, não uma página servida por nós.
