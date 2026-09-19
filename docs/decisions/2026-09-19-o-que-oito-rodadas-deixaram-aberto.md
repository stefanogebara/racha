# O que oito rodadas de revisão deixaram aberto, e o que reabre cada coisa

**Decisão:** estes achados são reais, foram medidos, e nenhum deles bloqueia o
merge. Ficam aqui com o gatilho que os reabre, porque um achado que vive só em
thread de revisão é a "guarda que depende de alguém lembrar" que este
repositório já pagou pra aprender quatro vezes.

## Por que existe esta página

Entre 16 e 19 de setembro de 2026 o portão de revisão (fintech-compliance +
security-reviewer) rodou oito vezes sobre o mesmo branch. **Sete dessas rodadas
acharam defeito real no conserto da rodada anterior** — três CRITICAL, e a
maioria em código escrito durante a própria sequência de consertos.

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

- **Não existe CI.** É o achado de maior alavancagem do repositório inteiro:
  27 mil linhas de teste e 2.443 casos que só protegem quem lembra de rodá-los.
  Um workflow de ~30 linhas converte toda essa disciplina em garantia.
- **`producao-estrutural.test.js` falha de forma intermitente** na suíte
  completa e passa isolado. Uma caçada de 14 execuções não reproduziu; a
  investigação pareada não achou contaminação de env. Não está diagnosticado.
- **As migrações 0035 e 0036 estão escritas e não aplicadas** — o repositório
  afirma um esquema que o banco não tem.
- **Quatro advisories em `apps/web`**, todas na cadeia de build, nenhuma no
  código que o cliente executa.
