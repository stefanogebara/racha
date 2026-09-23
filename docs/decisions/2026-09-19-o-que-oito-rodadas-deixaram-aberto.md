# O que onze rodadas de revisão deixaram aberto, e o que reabre cada coisa

**Decisão:** estes achados são reais, foram medidos, e nenhum deles bloqueia o
merge — mas **três bloqueiam o go-live**, e estão nomeados logo abaixo. Ficam aqui com o gatilho que os reabre, porque um achado que vive só em
thread de revisão é a "guarda que depende de alguém lembrar" que este
repositório já pagou pra aprender quatro vezes.

## Por que existe esta página

Entre 16 e 19 de setembro de 2026 o portão de revisão (fintech-compliance +
security-reviewer) rodou onze vezes sobre o mesmo branch. **Todas as dez
rodadas depois da primeira acharam defeito real no conserto da rodada
anterior** — três CRITICAL, e a maioria em código escrito durante a própria
sequência de consertos.

Vale registrar o padrão, porque ele é mais útil que qualquer um dos achados:

- **Duas vezes um guarda novo nasceu inerte.** Um censo casava a substring
  `gravar:` (então `xgravar:` o enganava); um teste conferia que uma lista
  EXISTIA sem conferir que ela era consultada. Os dois só apareceram quando o
  defeito foi plantado de volta.
- **Três vezes uma lista de EXCLUSÃO teve buraco.** A perna de recusa do aceite
  passou por duas versões erradas antes da prova positiva, e a segunda deixava
  passar justamente `charge_maybe_captured` — um 502 que quer dizer "o cartão
  FOI capturado" — imprimindo "✓ recusado como esperado".
- **Quatro vezes um documento afirmou comportamento que só metade do código
  tinha.** A semântica de retentativa foi reescrita três vezes até ficar certa.
- **Os achados caros vieram de quem MEDIU a rota, não de quem leu a linha.** O
  interruptor da carteira passou por dois censos de texto e por testes unitários
  sem nunca ter tido posição "ligado": o id vinha da projeção pública, que não
  tem `id`. Os censos provavam que a linha existia; nenhum via o que ela
  avaliava.

A conclusão prática: **censo de texto não substitui teste de comportamento em
código que move dinheiro.** Os três censos de texto do portão da carteira foram
apagados em `a3178da` depois que uma revisão plantou o mutante que mantinha o
literal intacto e reintroduzia o defeito com 2.498 testes verdes (a suíte daquele momento).

---

## Precondições pro primeiro `sk_live_` — NÃO só pra carteira

Esta lista existe porque a de baixo não cobria o caso. O `psp_rejected` é
emitido pelo `api()` COMPARTILHADO, por onde o `createPixCharge` passa: ele vale
pro trilho principal, no ar, sem passar por `RACHA_WALLET_VENUES`.

1. **Uma chave revogada não paga ninguém.** Todo 4xx do gateway vira 402 pro
   cliente. Com a `sk_live_` rotacionada, 100% das cobranças falham em TODAS as
   casas, cada pessoa na mesa lê que ELA foi recusada — e nada acorda ninguém: a
   rota só loga a partir de 500, o `service_never_collected` exige 8 pagamentos
   confirmados (uma queda total produz zero), e a conciliação compara dois
   registros que concordam que nada aconteceu. O aviso diário diz "restaurantes
   ok". É o inegociável #8 pelo caminho da cobrança em vez do da conciliação.
   **PARCIAL em 2026-09-21** (`saude-do-adquirente.js` + `observa-adquirente.js`).
   O `POST /api/pay` no trilho Pix/Pagar.me avisa — e SÓ ele. O que segue
   aberto está listado no fim deste item, e é por isso que a palavra não é
   "feito".
   401/403 é NOSSA credencial e atinge todas as casas: avisa na PRIMEIRA, porque
   esperar N é esperar enquanto 100% falha. 4xx de casa avisa em três seguidas,
   e um pagamento que passa ZERA a contagem. Rede, timeout, 429 e 5xx não
   acordam ninguém. O kind é `account_alert`, que a ponte já aceita — um kind
   novo voltaria 400 e seria o mesmo silêncio.

   **O que esta peça NÃO cobre — e cada um destes é o mesmo apagão noutra
   roupa, então a lista importa:**

   - **O trilho da Stripe é invisível.** A classificação lê `httpStatus`, e só
     o adaptador da Pagar.me o marca; a Stripe usa `statusCode`. Uma
     `STRIPE_SECRET_KEY` revogada não é sequer classificada como falha de
     adquirente, e o `POST /api/pay/stripe-intent` nunca chama o observador.
     Espanha está desligada, mas aquele adaptador cria conta `country: 'BR'` e
     serve cartão aqui.
   - **Não há orçamento de páginas.** O irmão (`avisarTetoDisparado`) tem teto
     diário — 12 por dia, 3 por casa — porque páginas sem limite JÁ treinaram
     alguém a ignorar o canal (160 por dia, incidente de `497bf87`). Este não
     tem nenhum, e um apagão de 8 horas em 8 instâncias quentes são centenas de
     mensagens no mesmo canal do canário. Duplicado ganha de mudo; duplicado e
     sem teto vira mudo no leitor, uma semana depois. O `claimSlots` (migração
     0033) é o primitivo durável que este repositório já tem pra isso.
   - **429 sustentado.** Tratado como transitório, e é: por um pico. Uma cota
     estourada derruba todas as casas e não conta nem uma falha.
   - **4xx de plataforma que não é 401/403.** Um 400 nosso ou um 422 de
     marketplace vai pro balde POR CASA e pode nunca chegar a três seguidas na
     mesma instância. Invisível com uma casa-piloto; morde quando o piloto der
     certo.
   - **O estado é por INSTÂNCIA QUENTE.** Instâncias diferentes podem avisar do
     mesmo apagão — repetido é melhor que mudo — e uma fria conta do zero. Na
     credencial revogada isso não atrasa nada, porque aquele escopo avisa na
     primeira.
   - **`/api/house/load` não é observado.** É um TERCEIRO caminho que chama
     `createPixCharge` na Pagar.me de verdade (`house-service.js`), e não tem
     observador nenhum: uma chave revogada derruba o carregamento de saldo em
     silêncio, e um 4xx de casa ali nunca conta pra contagem daquela casa. A
     frase "o trilho Pix/Pagar.me avisa" foi escrita antes de eu conferir este
     arquivo — é o mesmo "guarda que só lia o `router.js`" que o próprio
     `house-service.js` já documenta contra si.
   - **A CASA nunca é avisada.** Quando as cobranças de uma casa falham, quem
     recebe é só o fundador. O restaurante segue achando que a Racha funciona
     enquanto cada pessoa na mesa lê "pagamentos indisponíveis aqui". O
     `notifyOwnerRecipientStatus` já existe pra esse público. (Eu disse a um
     revisor que este item já estava escrito aqui. Não estava — esta linha é a
     correção.)
   - **O apagão que aparece na AUSÊNCIA de cobranças**: ninguém tocou em pagar.
     Detector durável, mora na conciliação (volume de hoje contra os dias
     anteriores, por casa). Enquanto os de cima não fecharem, ele é o ÚNICO
     fundo de rede pra todos eles — então ou eles fecham, ou ele entra antes do
     primeiro `sk_live_`. Não "nenhum dos dois".

   **E uma verificação de fora do código, antes do primeiro `sk_live_`:** o
   `account_alert` foi escolhido porque a ponte o aceita — provado contra a
   FIXTURE do `notify-bridge-contract.test.js`, que é mantida à mão e que hoje
   contém `money_without_check` com um comentário dizendo que a ponte NÃO o
   aceita. Ou seja, a fixture comprovadamente pode estar à frente da realidade.
   Confira em `restaurant-ai-mcp/api/racha-notify.js` e escreva a data ao lado
   da entrada — senão o pager inteiro pode ser um 400.
2. **`PAGARME_WEBHOOK_AUTH` não é conferida no boot.** O adaptador recusa cada
   webhook sem ela — certo — mas a consequência (a Pagar.me reentrega, desiste e
   DESABILITA o endpoint, e a confirmação de Pix morre) só existe em prosa. O
   `preflight-live.mjs` e o `config-producao.test.js` já falham fechado em
   `RACHA_STORE`/`RACHA_PSP` e não olham esta.
3. **Fixar as actions por SHA** antes de o workflow ganhar qualquer segredo.
   (As anotações do primeiro run também pedem: `actions/checkout@v4` e
   `setup-node@v4` ainda miram Node 20 e o GitHub os força pro 24, e o
   `ubuntu-latest` vira Ubuntu 26 em 19/10/2026.)
4. ~~Tornar `api` e `web` checks obrigatórios~~ — **FEITO em 2026-09-20.**
   Num plano Free a proteção de branch e os rulesets respondem 403 em
   repositório privado; os dois caminhos eram GitHub Pro ou abrir o
   repositório, e o dono escolheu **abrir**. O `racha` é público desde então, e
   `API (jest)` + `Web (lint, tsc, build, node:test)` são obrigatórios na `main`
   com `strict` ligado.

   **O que isso muda pra esta página, e é o motivo de estar escrito aqui:**
   ela é pública agora. Lida de fora, ela é um mapa de onde o caminho do
   dinheiro ainda está mole — com três bloqueadores de go-live abertos e os
   gatilhos de cada um. Isso não é motivo pra apagá-la (um achado que some da
   página volta a depender de alguém lembrar), é motivo pra **subir a
   prioridade dos três itens acima**: enquanto eles estiverem abertos, estão
   abertos em público.

   Duas consequências de virar público que não dá pra desfazer com um commit:
   o histórico inteiro (364 commits) foi junto, e a URL do projeto Supabase de
   produção aparece nos documentos e no histórico. Nenhum segredo jamais foi
   commitado — conferido nos 364 commits antes da mudança — e a URL não é
   credencial, com RLS só por service-role. Mas é um ponteiro, e apagá-la da
   árvore de hoje seria teatro enquanto o histórico existir.

## Precondições pra ligar a carteira na primeira casa

Nenhuma bloqueia o merge. Todas bloqueiam o primeiro id em
`RACHA_WALLET_VENUES` — e a lista completa vive em
[`2026-09-16-capturar-antes-de-gravar.md`](2026-09-16-capturar-antes-de-gravar.md).

1. **O balcão não tem onde olhar.** A tela manda quem está na mesa "falar com o
   balcão", e não existe superfície nenhuma que mostre um órfão: o evento sai só
   no aviso diário do fundador, de madrugada. A nossa mensagem está certa e
   termina num beco.
2. **A ponte de avisos ainda não aceita `money_without_check`.** Ela deploya de
   outro repositório. O evento fica durável aqui de qualquer jeito; o que se
   perde é o alerta do mesmo dia.
3. **O `psp-acceptance` rodar verde de ponta a ponta** contra a casa-piloto — o
   que exige o id dela na env e um redeploy (na Vercel a env é ligada ao deploy).

---

## Achados adiados, com gatilho

### Testes que medem menos do que o nome promete

- **O censo de `kind` de webhook não enxerga emissão não-literal.**
  `api/__tests__/webhook-kinds.test.js` ancora em `kind:\s*'…'`, então atalho de
  objeto, variável, template ou tabela de lookup escapam. Uma revisão provou com
  mutante: reescrever uma emissão como `const kind = '…'; return { kind, … }`
  deixa o censo verde. Se o `kind` chegar ao aplicador sem entrada em
  `EVENT_FOR_KIND`, é `throw` → 500 → o adquirente reentrega, desiste e
  **desabilita o endpoint**, e aí toda confirmação daquele trilho se perde.
  **Gatilho:** antes de ligar qualquer trilho novo, ou ao acrescentar um quarto
  adaptador. O conserto certo não é alargar o regex — é `require()` cada
  adaptador, alimentar `verifyAndParseWebhook` com eventos sintéticos e coletar
  o `kind` que ele de fato devolve.

- **O censo de escrita-pelada é uma lista de dois nomes.**
  `api/__tests__/cobrou-e-nao-gravou.test.js` varre `api/` inteiro procurando
  `store.registerCharge(` e `store.registerHouseLoad(`. Pega um quarto caminho
  escrito com esses nomes — foi medido — e é cego a um alias
  (`const escrever = store.registerCharge.bind(store)`) e a qualquer outro nome
  de escrita. **Gatilho:** ao acrescentar um método de escrita que grave depois
  de falar com o adquirente.

- **Os censos que contam por texto ainda medem comentário de fim de linha.**
  `sql-contract.test.js` e `apps/web/test/bundle.test.ts` tiram só comentário de
  linha inteira, então um `// …` no fim de uma linha de código mexe na contagem.
  Falha ALTO (o número não bate), então não é perigoso sozinho; o risco é a
  próxima pessoa subir a constante pra ficar verde e um sítio real entrar de
  carona. **Gatilho:** na próxima vez que alguém precisar mexer na constante.

### Dublês que não são o que dublam

- **O store de memória fixa o `pgConstraint` em vez de derivá-lo.**
  `api/_lib/store/memory.js` escreve o nome da restrição à mão, enquanto o
  sítio vizinho passa por `nomeDaRestricao(mensagemDeUnicidade(...))` — que
  existe exatamente pra que o ramo de FALHA da extração seja exercitado (uma
  mensagem do Postgres em outro idioma, ou um PostgREST que reescreva). **É o
  primeiro da fila**, segundo a própria revisão que o adiou: duas decisões de
  dinheiro vivas hoje dependem de um `23505` que só o dublê e o MockPsp
  produzem, o que faz do dublê o único executor delas.

- **`listOpenOrphanMoneyEvents` não tem paridade entre os stores.** O de memória
  devolve o registro inteiro (com `payload`) e sem `id`; o do Supabase devolve
  uma projeção de oito campos. O `reconcile-daily` põe `orphans.slice(0,10)`
  direto no corpo da resposta do cron. **Gatilho:** antes de qualquer coisa ler
  órfão fora do aviso — inclusive a tela do balcão da precondição 1.

### Decisões por SQLSTATE que o censo não alcança

- **Duas decisões em `error.code === '23505'`** em `api/_lib/store/supabase.js`
  (`recordOrphanMoneyEvent` e `recordCheckView`) são tomadas sobre o código cru
  do postgrest, ANTES do `throwOn` normalizar — e o censo do `sql-contract` só
  procura `pgCode`/`pgConstraint`. Uma delas está no caminho do dinheiro.
  **Gatilho:** acrescentar `\berror\.code\s*===` ao padrão do censo e deixar que
  ele acuse as duas.

- **`linhaJaGravada` aceita qualquer `23505`**, sem conferir o nome da
  restrição — ao contrário da irmã `desfechoDoLancamento`, que se recusa a fazer
  isso pelo motivo que vale aqui. Seguro **só porque `payments` tem exatamente
  uma unicidade além da PK** (`txid`, migração 0001; conferido até a 0036). Um
  segundo índice único em `payments` — um dedup por `(check_id, payer_label)` é
  inteiramente plausível — transformaria uma recusa real em tela de sucesso
  sobre um cartão capturado. **Gatilho:** qualquer migração que toque índice em
  `payments`. O guarda barato é um censo de esquema exigindo que `payments`
  tenha uma unicidade só.

- **`valeRepetir` retenta `/^53/` inteiro**, enquanto o comentário ao lado
  justifica só o `53300 too_many_connections`. Entram junto `53100 disk_full` e
  `53200 out_of_memory`, que são exaustão sustentada e não "tenta 30 ms depois".
  Limitado a uma ida extra, então não é alavanca de amplificação. **Gatilho:**
  se o aviso de prazo do banco ficar frequente, estreitar pra `/^53300$/`.

### O que a nona rodada acrescentou ao padrão

Dois achados novos que valem ficar escritos, porque nenhum deles é sobre o
defeito e sim sobre a forma de errar:

- **Um teste meu IMPEDIA o próprio conserto.** A rota da Stripe tinha
  `capturou: false` cravado, e o censo exigia esse literal — trocar pelo
  contrato correto (`stripePsp.walletCaptures`) deixava o teste vermelho. Um
  guarda que rejeita a correção é pior que nenhum, porque custa uma discussão
  antes de cada conserto.
- **Dois pontos cegos do censo de código de erro eram formas que o commit
  anterior tinha acabado de introduzir.** Quebrar a chamada de `badRequest(` em
  várias linhas — que é o que qualquer prettier faz numa linha longa, e o que o
  `create-charge.js` passou a ter — saía do censo por um `continue` comentado
  como "não julga". "Não sei julgar" tinha sido escrito como se fosse "está
  tudo bem".

### O censo cujo nome promete mais do que ele anda

- **`erro-com-codigo.test.js` varre só `_lib/pay`.** Há contraexemplos vivos
  fora: `_lib/store/supabase.js` tem quatro sítios no GASTO de saldo
  (`saldo insuficiente` 409, `invalid amount` 400, `Conta não encontrada` 404)
  que chegam ao cliente como texto cru em pt-BR pelo catch geral do
  `POST /api/house/redeem`. Nada interno vaza — é quebra do contrato de i18n,
  não divulgação. **Gatilho:** alargar a varredura pra `_lib/store`,
  `_lib/house` e `_app/router.js`. O risco de deixar como está não é o texto:
  é o nome do censo fazer o próximo leitor acreditar que a classe está fechada.

### O dublê ainda não erra como a produção erra

- **O `pgConstraint` do store de memória passa pelo extrator, mas nunca falha
  nele.** `nomeDaRestricao(mensagemDeUnicidade(x))` é a identidade nesse input:
  o dublê sempre devolve o nome, nunca `null`. O que o conserto de `23f2d70`
  comprou foi o censo que impede um sítio novo de escrever o nome à mão — não a
  cobertura do ramo de falha, que `pg-erro.test.js` já tinha (o caso em
  espanhol). A minha mensagem de commit afirmou o contrário.
  **Gatilho:** dar ao dublê um botão de locale
  (`createMemoryStore({ lcMessages: 'es' })`) e dirigir a rota de devolução fora
  do trilho com ele, pra que o caminho de `podeSerReentrega` seja exercitado por
  um `pgConstraint: null` de verdade.

### Contratos que degradam abertos

- **`nossa` tem padrão `null`.** Um quarto chamador de `gravarAposCobrar` que
  esqueça o parâmetro recebe em silêncio o comportamento de antes do conserto —
  a forma `if (coisa && !ok)` dentro do guarda escrito pra fechar um achado
  dessa mesma forma. As duas omissões de hoje são legítimas (a Stripe tem id
  próprio; o `hload` usa UUID aleatório). **Gatilho:** ao escrever o quarto
  chamador — e o conserto é tornar `nossa` obrigatório, com um sentinela
  explícito pra quem não precisa.

- **`parseIntent` da Stripe não tem invariante de valor.** A gêmea da Pagar.me
  afirma `amountCents + excedente + tipCents === recebido`; esta faz
  `Math.max(0, total - tip)` e não afirma nada. Com `metadata.tip_cents` maior
  que `pi.amount` — controlado pela conta conectada — o valor colapsa pra 0 e a
  gorjeta fica com o total. **Gatilho:** ligar a Espanha. Hoje é inalcançável
  porque o mercado está desligado.

- **`guardUser` monta o próprio JSON de 503** e manda `error: e.message`, que é
  a regra que o ramo 5xx do `errorBody` existe pra impor. Hoje a mensagem é uma
  constante, então nada vaza. **Gatilho:** o primeiro `AuthError` que carregue
  detalhe.

---

## O censo que essas rodadas produziram

Três achados em duas rodadas tinham a MESMA forma — erro 4xx sem `code`, então
o `errorBody` mandava a mensagem interna e o cliente imprimia texto de terceiro
num idioma que não era o do leitor. Consertar o sítio pela terceira vez seria
aceitar que existe uma quarta.

`api/__tests__/erro-com-codigo.test.js` prende a classe. Vale registrar como ele
ficou, porque a primeira versão dele era inerte de três jeitos diferentes, e os
três só apareceram quando o defeito foi plantado de volta:

1. **Janela de 30 linhas.** Perguntava "aparece algum `code` por perto?" e
   encontrava o `code` de OUTRO erro, de outra função. Hoje segue a VARIÁVEL,
   da atribuição até o `throw` dela.
2. **Exigia um literal de três dígitos.** O sítio do HIGH-1 é um ternário
   (`res.status >= 400 && res.status < 500 ? 402 : 502`) — ou seja, o censo
   escrito pra prender aquele achado não via aquele achado. Hoje julga pelo
   VALOR POSSÍVEL no lado direito.
3. **Não via erro construído por FÁBRICA.** `badRequest(msg)` põe o status
   dentro do ajudante, então o chamador não tem literal nenhum. Hoje o censo
   também exige o segundo argumento — e ao ganhar isso acusou **cinco sítios
   reais** em `create-charge.js` que mandavam texto em inglês pra tela
   (`amountCents must be a non-negative integer`, `zero-value charge`), num
   caminho que o trilho da Stripe já tratava certo. A assimetria de sempre.

Mais duas coisas que o próprio censo errou antes de acertar: ele deslocava a
numeração de linha (apagava blocos de comentário inteiros, engolindo as quebras)
e portanto citava o lugar errado; e contava crase como abertura sem fechamento,
o que fazia toda chamada com template parecer sem código — acusando o inocente.

## Fora do caminho do dinheiro, da auditoria de 19/09

- **O CI existe desde `23f2d70`** — e a primeira revisão dele achou duas coisas
  que só o CI acharia: ele fixava o Node 20, em que o `createClient` do Supabase
  nem inicializa (`engines` do pacote pedia `>=22`, e o nosso declarava `>=20`,
  ou seja, a produção declarava um runtime em que o app morre); e saía VERDE com
  quatro classes de teste pulando, entre elas a única que confere o inegociável
  #7 contra um Postgres real. Hoje ele instala Postgres, põe `RACHA_EXIGE_PG=1`
  e nomeia os arquivos que não podem pular, e o primeiro run de verdade (PR #9,
  2026-09-20) ficou verde nos três jobs com 2.486 passando — os mesmos números
  da máquina local, que é a primeira vez que dá pra dizer isso em vez de supor.
  **O que falta:** exigir os checks, o que depende de um plano — ver o item 4
  das precondições acima.
- **`producao-estrutural.test.js` falha de forma intermitente** na suíte
  completa e passa isolado. Uma caçada de 14 execuções não reproduziu; a
  investigação pareada não achou contaminação de env. Não está diagnosticado.
- **As migrações 0035 e 0036 estão escritas e não aplicadas** — o repositório
  afirma um esquema que o banco não tem.
- **Quatro advisories em `apps/web`**, todas na cadeia de build, nenhuma no
  código que o cliente executa.

---

## Décima terceira rodada e a re-revisão dela (2026-09-21)

O que as duas revisões acharam e que **não** foi consertado, cada um com gatilho.

### A janela das pendentes no teto da gorjeta — MEDIDA em 10x

`tetoDaGorjeta` soma `state.tipCents`, que é gorjeta **confirmada**. Cobranças
criadas antes de qualquer confirmação não estão no razão e não entram na soma,
então N cobranças com `tipCents === totalCents` passam cada uma por si. A
revisão de segurança mediu, contra o `createChargeService` de verdade:

```
cobrancas pendentes criadas com gorjeta=total: 10
totalCents=10000  tipCents CONFIRMADA=100000  (=10.0x a conta)
```

O atacante paga de verdade, então isto é inflação de base de folha e de
conciliação, não roubo — e é estritamente melhor que o estado anterior, em que
não havia teto nenhum (nove bilhões passavam). O conserto de verdade é contar
gorjeta pendente na reserva de vaga (`claim_slots`, migração 0033 já carrega a
reserva por conta) ou reafirmar o teto ao aplicar `PAYMENT_CONFIRMED`.

**Gatilho:** o primeiro piloto que feche mês com relatório de folha, ou o
primeiro `sk_live_` — o que vier antes. O teste que falta está descrito: criar
as N cobranças **antes** de qualquer confirmação e exigir que a (N+1)-ésima
seja recusada.

### O razão não tem o invariante que o teto de admissão promete

`guardCap` (`check-state.js`) só confere `MAX_SAFE_INTEGER`, e um `ADJUSTED`
que baixe o total não olha a gorjeta já confirmada: conta de R$ 100,00 com
R$ 10,00 de gorjeta confirmada, POS cancela itens e ajusta pra R$ 5,00, e o
relatório de folha mostra gorjeta maior que o consumo sem anomalia nenhuma.

**Gatilho:** o primeiro adaptador de POS que emita `ADJUSTED` — hoje nenhum
emite, e é por isso que isto não é conserto de agora.

### `api/` não tem linter, e o defeito desta rodada era estático

`router.js` chamava `tetoDaGorjeta` e nunca a importava: `ReferenceError` em
toda requisição a `/api/pay/stripe-intent`, o trilho de cartão inteiro em 500.
**As duas revisões leram o arquivo e passaram por cima.** O que pegou foi o
primeiro teste que dirigiu a rota — e, medido depois, `eslint --rule no-undef`
acusa a linha em segundos:

```
5ba46e7  →  1378:23  error  'tetoDaGorjeta' is not defined  no-undef
c5d37d1  →  (limpo)
```

Hoje `eslint.config.js` existe só em `apps/web`; a raiz roda `jest` e mais nada.
A revisão de segurança propôs, como alternativa sem dependência de estilo, um
censo de escopo com `@babel/parser` + `@babel/traverse` (~40 linhas, achou o
defeito plantado na primeira execução) — com a ressalva de que os dois pacotes
hoje são dependências transitivas do jest e precisariam ser declarados, senão o
censo evapora num upgrade e vira guarda que morre calada.

**Gatilho:** nenhum. Isto é precondição de go-live do trilho de cartão, não
item adiável — está aqui só porque entrou depois de as revisões lerem a árvore,
e merece a sua própria revisão.

### O corpo da rota do intent segue sem teste

O único teste que dirige `/api/pay/stripe-intent` retorna na linha do teto da
gorjeta. De lá até o fim — `assertChargeSlot`, `comContratoDeCaptura`,
`createWalletCharge`/`createBizumCharge`, `gravarAposCobrar`, o mapeamento de
`amount_too_small`, o `finally` que devolve a vaga — nenhuma linha foi
executada por teste nenhum. É o trecho onde o dinheiro se move.

**Gatilho:** o mesmo do item acima.

---

## A demo pública (2026-09-23)

Achados das duas revisões sobre a renovação da demo paga que **não** entraram
naquele PR, cada um com gatilho.

### `/api/pay` decide "é a demo" pelo token, sem provar a casa — HIGH

`router.js`: `isDemo = body.token === DEMO_TABLE_TOKEN`, e `DEMO_TABLE_TOKEN`
vem de `RACHA_DEMO_TABLE_TOKEN`. Das sete comparações com esse token no router,
só as duas curas passam por `isDemoVenue`. Medido pela revisão de segurança:
com a env digitada apontando pro token de uma mesa real, `POST /api/pay` devolve
200, o copia-e-cola sai com CRC `MOCK`, e a conta real vira `paga` sem dinheiro
nenhum ter se movido — **qualquer um com o QR daquela mesa fecha a conta dela
sem pagar**. O mesmo token ainda desliga o reconcile-on-read e mostra
"Simular confirmação" num Pix de verdade. É a forma "chamador esquecido": o
cabeçalho de `demo.js` nomeia esse typo como crítico, e a defesa só foi posta
num dos sítios.

**Fechado em 2026-09-23 (PR #19):** "é a demo" exige a CASA (`contaEDaDemo` →
`isDemoVenue`: `isTest` + `rcpt_demo`, nenhum dos dois gravável pelo dono; em
produção, só a casa da demo tem os dois) E um dos dois tokens da demo (o
`demoracha` fixo da landing ou o da env). Só pela casa, um `is_test` posto por
engano numa casa com `rcpt_demo` faria toda mesa dela fechar conta sem
dinheiro, mudo (compliance, M-A); com o token, as mesas dela seguem reais. O
token também serve às curas — que provam a casa por `resolveDemoTable` — e pra
gritar `[demo-token]` (uma vez por conta por hora) quando aponta pra uma casa real.
Fecha também a outra metade: a env diferente do `demoracha` fixo da landing
não desliga mais a demo. `/api/check`, `/api/pay` e `/api/pay/stripe-intent`
passam por ela. Censo e as duas formas de casa real em
`api/__tests__/demo-prova-a-casa.test.js`.

**Continua aberto:** o grito vai só pro log (inegociável #8 pede aviso) — a
configuração quebrada já falha pro lado seguro, então não move dinheiro errado.
Gatilho: a primeira vez que `[demo-token]` aparecer no log de produção.

### A janela entre inserir a conta e gravar o `OPENED` — LOW, anterior, PARCIAL

`supabase.js`: o `openCheck` grava a linha e, noutra ida ao banco, o `OPENED`.
Toda leitura nesse intervalo fazia `reduce([])` → `null` → `state.status` lança →
500. Acontece em qualquer mesa quando o garçom abre a conta enquanto alguém
sonda; a renovação da demo passa a provocar em rebanho.

**Fechado em 2026-09-23 (PR #16):** todo leitor pula a conta sem `OPENED` — a
leitura pública, o painel do dono, a lista de mesas —, e nenhum lança. A
primeira versão do pulo era muda, e as duas revisões da quarta rodada a
recusaram: por isso, **passados 30 s** (`conta-sem-opened.js`), cada pulo
escreve `[conta-sem-opened] check=<id> idade=<s> em=<leitor>`.

**Gatilho** (o antigo, "o primeiro 500 de `/api/check`", não pode mais
disparar — o pulo o matou): a primeira linha `[conta-sem-opened]` no log de
produção, ou o primeiro adaptador de POS que abra contas em lote.

### O aviso de privacidade da demo nomeia um controlador que não existe — MEDIUM, anterior, PARCIAL

`priv.teaser`/`priv.who` dizem que "{venue} ({taxId}) é quem decide o que se
coleta" e "{venue} guarda o nome". Na demo a casa é fictícia; quem trata o nome
digitado pelo visitante é a Racha (LGPD art. 9º II/III).

**Metade fechada em 2026-09-23:** a demo exigia um CPF VÁLIDO — na prática o do
visitante — numa cobrança de mentira, e a renovação da demo paga a deixava viva
o dia inteiro. A revisão de compliance recusou o gatilho e pediu antes do merge.
A demo não pede mais CPF, pela mesma regra que já tirava o NIF do Bizum: o
documento só existe onde o trilho precisa dele, e o MockPsp não precisa. O que
sobra é o NOME, que é opcional e segue com o aviso nomeando a casa fictícia.

**Gatilho:** antes da primeira campanha que leve tráfego pago pra landing.

### A tela Pix da demo manda usar o app do banco de verdade — MEDIUM, anterior

`pix.how` diz "abra o app do seu banco… cole o código", pra um código com CRC
`MOCK`, que nenhum banco aceita. A única marca de demo na tela é o botão
"(demo)" e o nome da casa.

**Gatilho:** o mesmo do item acima.

### Os achados da segunda rodada sobre a demo — anteriores a ela, cada um com PR próprio

**Um `openCheck` pela metade tranca a mesa pra sempre — MEDIUM.**
`supabase.js` insere a linha em `checks` e grava o `OPENED` noutra ida ao banco.
Se a segunda falhar (timeout, a função morta no meio), a mesa fica com uma conta
`aberta` sem eventos: `reduce([])` devolve `null`, `GET /api/check` responde 500
em TODA leitura, o `resetDemoCheck` lança o mesmo TypeError, o `openCheck`
leva 409 pelo índice de uma aberta por mesa, e o `closeCheck` recebe estado
nulo. Medido pela revisão de segurança num Postgres com as 36 migrações: a mesa
morre até alguém rodar SQL à mão. Vale pra QUALQUER mesa, não só a demo — a
renovação só a torna mais frequente em rebanho. O conserto é uma RPC que insere e
grava o `OPENED` na mesma transação.

**O que mudou em 2026-09-23 (PR #16):** a mesa ainda tranca, mas não em
silêncio. A leitura e o painel escrevem `[conta-sem-opened]` depois de 30 s, e
a conciliação diária emite achado `critical` `check_without_opened` — que pinta
a casa de vermelho e acorda o fundador (inegociável #8). **Exceto nas casas
`isTest`:** a varredura noturna as pula (`reconcileAllVenues`, sem
`includeTest`), e isso inclui a DEMO — justamente onde a renovação em rebanho
mais provoca a janela — e as casas de teste com recebedor vivo. Nelas a órfã só
deixa a linha `[conta-sem-opened]` no log, e o repositório não tem nada que leia
log e pagine. Fecha junto com a RPC; até lá, é uma exceção escrita, não uma
cobertura (compliance, quinta rodada, M-1/M-2).

**O reparo à mão, até a RPC:** `update checks set status = 'fechada' where id =
'<id da linha [conta-sem-opened]>'` — só numa linha sem nenhum `payments`
(confira antes). A mesa destranca na hora, e a conciliação passa a registrar a
conta como `info` `check_closed_without_opened` em vez do `critical`: julgar só
pelo razão deixava o alarme aceso pra sempre numa mesa já livre (segurança,
quinta rodada, M-B). O store de memória
passou a trancar a mesa como o índice do Postgres; antes ele deixava abrir
outra conta por cima, e o teste de "mesa trancada" era verde aqui e falso lá.

**Fechado em 2026-09-24:** migração 0037, `open_check` — a linha e o `OPENED`
numa transação só; o store de produção chama a RPC e decide o 409 pelo código
(23505), não por regex. O dublê desfaz a linha se o `OPENED` falhar. As defesas
acima (alarme, achado, painel que não cai) ficam pras linhas de antes da 0037.

**O `closeCheck` do dono é ler → `appendEvent` — MEDIUM.**
`check-service.js` fecha a conta com a mesma forma que a demo acabou de
abandonar, e o `adjustCheck` idem. Medido: dois `closeCheck` concorrentes com
latência dão 2 `CLOSED` e uma anomalia `high` em 5 de 5 — um toque duplo no
painel suja o razão imutável. O conserto é o mesmo `appendEventIfUnchanged` com
o `conflito`, e um censo de toda escrita de `CLOSED`/`ADJUSTED`.

**Fechado em 2026-09-24:** `closeCheck` e `adjustCheck` gravam por
`appendEventIfUnchanged` sobre o `seq` lido e, no `conflito`, releem; o toque
duplo dá UM `CLOSED` (com `motivo: 'dono'`) e os dois respondem que fechou.
Censo em `api/__tests__/fechar-duas-vezes.test.js`.

**O caminho do saldo da casa pode deixar um pagamento em voo — LOW, anterior.**
Depois de um resgate que devolve `r.check === null`, o `setPolling(false)` roda
e nada o religa. "Voltar" leva a uma conta velha com o poll desligado; um Pix
gerado dali é cobrado na conta viva da mesa e o ✓ nunca aparece, porque depende
do poll.

**Gatilho:** o primeiro piloto com saldo da casa ligado.

**Na janela do 404, o recibo ainda oferece "pagar mais" — LOW, anterior.**
Entre o dono fechar e o garçom abrir a conta nova, o recibo usa a última leitura
boa e continua mostrando "falta R$ X" com o botão, de uma conta fechada. O
servidor recusa com `check_closed`, então não há cobrança dupla — é só um convite
à toa.

**Gatilho:** o próximo PR que mexer no recibo ou na demo — não o do saldo da
casa. A compliance mostrou por quê: a casa fecha a conta com saldo recebido no
caixa, a pessoa toca "pagar mais", o `contaPaga` é zerado, o poll segue, e
quando a próxima conta abre no mesmo QR ela está nos itens da outra mesa.

**O fechamento pelo dono não diz quem fechou — LOW.** Com o `motivo` da demo, as
duas se distinguem pela ausência do campo; melhor gravar `{ motivo: 'dono' }`.

**Gatilho:** o PR do `closeCheck`.

**O recibo do saldo da casa está incompleto — LOW, anterior.** A tela de sucesso
do `HousePay` não mostra CNPJ, data, nem "não é nota fiscal".

**Gatilho:** o primeiro piloto com saldo da casa ligado.

### Da terceira rodada sobre a demo (2026-09-23)

**O aviso da conta paga some se a troca vem antes de o telefone vê-la paga —
LOW.** O recibo guarda os avisos da conta paga enquanto ela é a viva. Se a
carteira confirma e o garçom reabre no mesmo QR antes do próximo poll, o
telefone nunca viu a conta paga como viva: não mostra o aviso da mesa dos outros
(certo), mas também não mostra o da própria (a lista fica vazia). Medido pela
segurança com o poll bloqueado. O conserto é o servidor entregar os avisos da
conta em que a cobrança nasceu (`/api/check?t=…&c=<checkId>`, limitado à mesa do
token). Nota da compliance, que vale junto: o recibo NÃO é o canal oficial de
aviso de restituição — um estorno que chega depois da troca não entra, e está
certo que não entre. O dever de avisar e devolver é da casa, pelo painel. Nenhum
comentário ou documento deve afirmar o contrário.

**Gatilho:** o primeiro piloto com carteira ligada (`RACHA_WALLET_VENUES`).

**A resposta de `/api/pay` sai por lista de NEGAÇÃO — LOW.** Só `venueId` é
tirado; toda chave nova no `createCharge` chega ao cliente sozinha. Uma lista de
permissão fecha a classe.

**Gatilho:** o PR do `/api/pay` com o token da demo era o gatilho, e disparou
(PR #19, 2026-09-23) sem ser tratado: aquele PR mudou QUEM é a demo, não o que
a rota devolve, e misturar as duas mudanças numa rota de dinheiro dobraria a
revisão. Gatilho novo: a primeira chave acrescentada ao retorno do
`createCharge`, ou o primeiro piloto com carteira ligada, o que vier antes.

**`RACHA_DEMO_MODE` está ligado em produção — LOW, configuração.** Ele só libera
`POST /api/dev/confirm`. Em produção a rota responde 404 mesmo assim, porque o
PSP principal é o Pagar.me e só o MockPsp forja webhook assinado — conferido
por sonda sem efeito em 2026-09-23. Mas a sonda também mostrou que a PRIMEIRA
guarda não está de pé: a resposta veio do ramo de dentro, não do 404 de rota
inexistente. A segurança dessa rota repousa inteira na segunda camada, que é a
forma que as revisões desta semana acharam duas vezes. Remover a variável é
decisão de quem opera a produção.

**Gatilho:** a próxima vez que alguém mexer na configuração de produção.

