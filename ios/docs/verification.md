# Verificação

**Compilado e rodado num Mac em 2026-09-06** (Xcode 26.6, SDK iOS 26.5,
simulador iPhone 17 Pro — o runtime do 16 Pro não existe mais no Xcode 26; a
Metal Toolchain é download separado: `xcodebuild -downloadComponent
MetalToolchain`). O histórico abaixo — o app ter sido construído num contêiner
Linux, sem compilador — continua verdadeiro pra tudo que foi escrito antes dessa
data, e é por isso que a seção final lista o que ainda precisa de olho humano.

## O que o compilador achou (2026-09-06)

Três erros de compilação em 72 arquivos, todos triviais:

| Arquivo | Erro | Correção |
|---|---|---|
| `Typography.swift` | `Typo.Face.mono` e `.sans` com o mesmo raw value `"body"` | raw value próprio; nunca era lido |
| `Composer.swift` | key path chamando método (`\.name.lowercased()`) | closure |
| `Cents.swift` | `@inlinable` numa função interna tocando tipo interno | tirar o atributo; nenhuma conta mudou |

Concorrência (`@MainActor`, `actor`, puro) e disponibilidade de API passaram
sem um ajuste. Os 9 shaders Metal compilam. **93 testes em 14 suítes, verdes**
(`xcodebuild test`). Os dois avisos que ficam — `try?` com resultado ignorado
em `repository.append`, e `await` sem operação assíncrona em `ImageCache` — são
benignos.

Fora do compilador, o build e a tela acharam mais:

- **O scheme não tinha ação de teste** pro `xcodebuild`: um `<TestPlans>` vazio
  faz o Xcode ignorar a lista de `Testables`. Removido.
- **`INFOPLIST_KEY_UIAppFonts` não existe.** O Xcode aceitou o setting e o
  descartou em silêncio; o Archivo estava no bundle e não registrado. Entrou
  um `Racha-Info.plist` mínimo (só `UIAppFonts`) mesclado ao gerado — fora de
  `Racha/`, porque a pasta sincronizada copiaria o plist como recurso e o
  build falha com duas saídas.
- **O teclado subia por cima da capa do onboarding.** Os três passos vivem num
  `ZStack` com opacidade, então o `.onAppear` do campo de nome disparava no
  lançamento. Foco agora no `onChange(of: step)`.
- **`.preferredColorScheme(.light)` no `RachaApp`**, com comentário da paleta
  de papel, contra `UIUserInterfaceStyle = Dark` no projeto. Efeito: teclado
  claro sobre a noite e o `.ultraThinMaterial` da conversa virando uma laje
  cinza-médio opaca. Agora `.dark`.
- **Os blocos entalhados nunca apareciam.** Sem chave, o motor de imagem só
  sabe o prato procedural — e o prato entrava em `image`, por cima do bloco no
  `ZStack`. Pior: `ImageCache` gravava o prato em disco como se fosse gerado, e
  contava em `generatedCount`. Catorze linhas, um chapéu. Agora a view só pede
  ao motor quando ele gera de verdade (ou a categoria não tem bloco), e o
  procedural nunca chega ao disco nem ao contador.
- **`R$ 129,25` quebrava em duas linhas** no tile da galeria. O valor ganhou
  `layoutPriority`; o rótulo cede.

## Segunda passada: dirigindo o app de verdade (2026-09-06)

Captura de tela é um quadro sem dedo nenhum dentro. Entrou um alvo de
**testes de interface** (`RachaUITests`, 11 fluxos) que abre o app num aparelho
recém-limpo (`-racha.resetState`) e anda por ele. O que ele achou, e o que só
apareceu quando as telas foram olhadas uma a uma:

- **Nenhum botão era botão.** `RachaButton` precisa de um `DragGesture` cru pro
  shader de pressão (um `Button` engole a posição do toque), e isso custou o
  papel dele: pra VoiceOver, pro Controle Assistivo e pro robô, *Começar*,
  *Pagar* e *Escanear* eram pedaços de texto. Ninguém sem enxergar começava o
  app. O gesto fica; o papel voltou.
- **O onboarding lia as três telas ao mesmo tempo.** Os três passos ficam
  montados pra fazer a transição; `opacity: 0` esconde dos olhos, não do
  sistema. `accessibilityHidden` no que não é o passo atual.
- **"Pagar" na galeria não abria nada.** Quatro `.sheet(isPresented:)` no mesmo
  ScrollView; o SwiftUI honra um. Três eram código morto que lê certo linha a
  linha. Agora é um `.sheet(item:)`.
- **O relógio dos shaders nunca parava.** `ShaderClock` é `@Observable` e o
  display link batia ~30×/s enquanto alguém segurasse: a galeria parada
  redesenhava pra sempre. Três donos estavam errados, um deles vazando inscrição
  (e o espelho dele soltando uma que nunca pegou, congelando a animação alheia).
- **O agente comia um espaço a cada três palavras.** "Vou olhar a conta
  primeiro." chegava como "Vou olhar aconta primeiro."
- **A paleta da noite não tinha chegado em onze superfícies.** Campos, chips,
  compositor e a bolha do agente ainda eram `Color.white`; o texto deles é
  `Palette.charcoal`, que a migração remapeou pra CREME. Creme sobre branco.
- **O cartão usava `.ultraThinMaterial`** — a primeira linha do docblock dele
  diz "Not `.ultraThinMaterial`".
- **Os números do vidro estavam calibrados no papel.** A varredura especular
  somava +0,16 fixos e o interior subia 10% na direção do BRANCO: um sussurro
  sobre papel, um holofote sobre `#1E1812`. A faixa diagonal cobria o
  "deve R$ 107,70". Agora os dois escalam com a luminância de baixo.

### Ver qualquer tela sem tocar (só Debug)

O terminal não tem permissão de acessibilidade pra clicar no simulador, então
existe uma porta de debug — `#if DEBUG`, um flag explícito, não o auto-seed que
a decisão #20 proíbe:

```bash
xcrun simctl launch <udid> com.racha.ios -racha.debugRoute gallery   # 4 mesas semeadas
xcrun simctl launch <udid> com.racha.ios -racha.debugRoute thread    # a conversa da mesa aberta
xcrun simctl launch <udid> com.racha.ios -racha.debugRoute ledger    # a conta
xcrun simctl launch <udid> com.racha.ios -racha.debugRoute pay       # a sheet Pagar
xcrun simctl io <udid> screenshot tela.png
```

Capturado e conferido a olho nesta sessão: capa do onboarding, galeria vazia,
galeria com quatro mesas (poster `R$ 90,10` em Archivo 62/850), conversa, conta
com os 6 itens e os blocos por categoria, Pagar com BR Code. Nenhum crash no log.

## O que rodou, e passou

### `scripts/verify-money.py` — o núcleo de dinheiro

Porte linha a linha de `Allocator`, `SettleUp` e `BRL` pra Python, com as mesmas
propriedades dos testes Swift. **12 propriedades, ~40 mil casos, tudo verde.**

| # | Propriedade |
|---|---|
| 1 | Divisão igual soma exatamente o total — todo total de 0 a 2000 × 1 a 12 partes, e nenhuma parte difere de outra por mais de 1 centavo |
| 2 | Proporcional soma exatamente, em 9 conjuntos de pesos incluindo todos-zero |
| 3 | Totais negativos (estorno) também somam exatamente |
| 4 | Serviço por pessoa nunca inventa nem perde dinheiro (3 mil casos aleatórios) |
| 5 | Arredondamento meio-pra-cima simétrico em torno de zero; 3333@10% = 333, 3335@10% = 334 |
| 6 | Plano de acerto zera todo mundo e nunca passa de n−1 transferências (3 mil casos) |
| 7 | Quando falta dinheiro, sai como `residual` separado e o plano ainda fecha (1,5 mil casos) |
| 8 | A partição encontra subconjuntos independentes: dois pares → 2 transferências, não 3 |
| 9 | A partição nunca é pior que o guloso puro (600 casos) |
| 10 | Formatar e reler é identidade, de 0 a R$ 2.000,00 |
| 11 | Nada de float: `47,55` → 4755, não 4754. 13 casos de entrada real |
| 12 | Moedas sem subunidade (iene, peso chileno) não ganham vírgula |

**Não cobre:** o `SplitEngine` (que não foi portado) — esse tem testes de
propriedade em Swift, executados e verdes desde 2026-09-06.

### `scripts/check-shaders.py` — assinaturas Metal ⇄ Swift

**9 de 9 batendo**, aridade e tipo, argumento por argumento.

Essa é a checagem estática de maior valor do repositório: o SwiftUI liga
argumento de shader **por posição**, sem checar nome nem quantidade. Um argumento
a menos renderiza lixo — ou nada — sem erro de compilação, sem log, sem nada.

**Não cobre:** se o Metal compila, nem se o shader fica bonito.

### `scripts/check-pbxproj.py` — integridade do projeto

Parser de plist OpenStep (o `plistlib` do Python só lê XML e binário), mais:
todo id referenciado existe, todo objeto tem `isa`, cada alvo resolve fases e
configurações.

**Resultado:** 26 objetos, 2 alvos, nenhuma referência morta. Referência morta é
o que faz o Xcode abrir um projeto vazio sem dizer nada.

**Não cobre:** se o Xcode aceita o `objectVersion = 77` na versão instalada, nem
se o build passa.

### `scripts/check-swift.py` — estrutura

60 arquivos, 9.149 linhas, 128 tipos de topo. Delimitadores balanceados em todos
os arquivos (depois de tirar strings e comentários), nenhum tipo de topo
duplicado.

**Não cobre:** tipos, nomes, concorrência — praticamente tudo que um compilador faz.

### CRC do Pix

Conferido contra o vetor canônico do CRC-16/CCITT-FALSE (`123456789` → `29B1`) e
contra o payload de exemplo do Bacen. É o que decide se um QR gerado é aceito ou
recusado pelo app do banco.

## Executado em 2026-09-06 — `RachaTests/`

~~Escrito, não executado.~~ 93 testes em 14 suítes, todos verdes no simulador. As suítes principais:

| Suíte | Cobre |
|---|---|
| `AllocationTests` | Invariante da soma exaustiva, rotação, pontos-base |
| `SplitEngineTests` | Pesos, serviço proporcional, couvert, desconto, item sem dono, **e uma propriedade sobre 400 contas geradas** |
| `SettleUpTests` | n−1, subconjuntos, residual, um centavo |
| `PixPayloadTests` | CRC canônico, exemplo do Bacen, TLV, ASCII, adulteração |
| `MoneyFormatTests` | Formato, parse, ida e volta, câmbio, moedas sem subunidade |
| `ProjectionTests` | Ordem por seq, reversão, anomalias, idempotência de pagamento, total fixado |
| `AgentToolTests` | Recusa de reais em campo de centavos, parser SSE, resolução de nomes, categorização |

Num Mac:

```bash
xcodebuild test -scheme Racha -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

## O que precisa de olho humano num Mac

Atualizado em 2026-09-06. O que um simulador e uma captura de tela confirmam
está riscado; o resto continua em pé, porque captura não mede sensação, GPU
nem háptico.

1. ~~**Compilar.**~~ Compila (ver acima). Concorrência e disponibilidade
   passaram sem ajuste.
2. **Os nove shaders na tela.** Números como a força de refração (9 pt), a
   espessura da onda de choque (46 pt) e a intensidade do grão (0,018) foram
   escolhidos por raciocínio, não por olhar. Provavelmente querem ajuste fino.
3. **O zoom contínuo.** A resistência do arraste (`pow(0.82)`) e o limiar de
   flick (260 pt previstos) são números de sensação. Só o polegar decide — o
   robô toca e arrasta, mas não sente.
4. **Custo de GPU e bateria.** As mitigações estão documentadas em
   [`shaders.md`](shaders.md), mas não medidas.
5. **O háptico de fechamento.** A curva de intensidade foi escrita de ouvido, sem
   ouvido.
6. **Uma nota de verdade** fotografada e lida pelo agente ponta a ponta.
7. **A noite do bar no Swift.** Confirmado na tela: o `UIFontDescriptor` com
   `kCTFontVariationAttribute` entrega Archivo a 62/850 no poster (visível ao
   lado da captura anterior em SF comprimida), e o chão é a noite. O Archivo
   está registrado (`Racha-Info.plist`). **Fica pra o olho:** a conversa
   (`ThreadView`) e os cartões da conta usam `.ultraThinMaterial` sobre a
   noite, o que rende uma laje cinza-escuro (#333) — coerente entre si, mas
   é decisão de design se é isso ou o vidro dos shaders próprios da decisão #8;
   e as capas dos tiles perderam o quadrado creme (o bloco agora imprime creme
   direto na noite, como a #33 pede) — conferir se é o que se quer.
8. **A leitura da mesa (decisão #30).** `ScannerView` é a única parte do app que
   um simulador não exercita de verdade: precisa de câmera. **Não testado nesta
   sessão, de propósito** — o simulador não tem câmera; aparelho. Num aparelho:
   imprimir um QR do painel (`/qrs`), escanear, ver "Lendo a mesa…" e a comanda
   chegar; negar a permissão de câmera e conferir que a tela explica e oferece
   digitar o código; escanear um QR de wifi e conferir que nada acontece (o
   scanner ignora em silêncio, por projeto). Re-escanear a mesma mesa depois do
   garçom lançar mais uma rodada tem que **somar** os itens novos, nunca
   duplicar o jantar — `CheckImportTests` cobre a lógica, mas o caminho todo
   (rede + merge + UI) é de aparelho.
9. **A mesa (decisão #29).** Confirmado na tela: "Bar do Zé · Mesa 12 · agora",
   `R$ 90,10`, "Falta R$ 273,60 na mesa · Gui e Pedro ainda não pagaram · 1
   item sem dono", a sheet Pagar com o BR Code e o serviço removível. `allStates`
   devolve a mais recente primeiro. **Fica pra o aparelho:** Copiar Pix → validar
   o BR Code num app de banco em modo de teste (a chave é fictícia; o CRC tem
   que bater).
10. **`unassignedExtras`.** ~~Escritos, não executados.~~ Executados, verdes.

11. **Onboarding, passos 2 e 3, e as sheets de Ajustes e Novo racha.** A porta
    de debug não chega neles; precisam de um dedo. Também Ajustes → chave de API
    → conversa com o agente de verdade (aqui só o `MockTransport` rodou).

## Se algo estiver quebrado

A ordem que economiza tempo:

1. `python3 scripts/check-shaders.py` — falha silenciosa de shader não dá erro.
2. `python3 scripts/verify-money.py` — se mexeram no `Allocator` ou no `SettleUp`.
3. `xcodebuild test -scheme Racha -destination 'platform=iOS Simulator,name=<um iPhone disponível>'` — o resto.

O modo demonstração (`MockTransport`, `ProceduralImageProvider`) roda sem rede e
sem chave, então dá pra isolar UI de agente de imagem sem tocar em nenhuma API.
