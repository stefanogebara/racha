# Verificação

Honestidade primeiro: **este app não foi compilado nem rodado.** Foi construído
num contêiner Linux, que não tem toolchain Swift, Xcode nem simulador. O que foi
verificado está abaixo, com o que cada checagem cobre e o que ela não cobre.

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

**Não cobre:** que o Swift compila, nem que o `SplitEngine` (que não foi portado)
está certo — esse tem testes de propriedade em Swift, ainda não executados.

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

## Escrito, não executado

`RachaTests/` — 6 suítes em Swift Testing:

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
xcodebuild test -scheme Racha -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
```

## O que precisa de olho humano num Mac

Nada disso dá pra afirmar daqui:

1. **Compilar.** Esperar ajustes de concorrência e de disponibilidade de API.
   As fronteiras de isolamento estão desenhadas (`@MainActor` no que a UI observa,
   `actor` no I/O, puro no resto), mas não conferidas por compilador.
2. **Os nove shaders na tela.** Números como a força de refração (9 pt), a
   espessura da onda de choque (46 pt) e a intensidade do grão (0,018) foram
   escolhidos por raciocínio, não por olhar. Provavelmente querem ajuste fino.
3. **O zoom contínuo.** A resistência do arraste (`pow(0.82)`) e o limiar de
   flick (260 pt previstos) são números de sensação. Só o polegar decide.
4. **Custo de GPU e bateria.** As mitigações estão documentadas em
   [`shaders.md`](shaders.md), mas não medidas.
5. **O háptico de fechamento.** A curva de intensidade foi escrita de ouvido, sem
   ouvido.
6. **Uma nota de verdade** fotografada e lida pelo agente ponta a ponta.
7. **A noite do bar no Swift.** `Palette.swift`, `Typography.swift` e o
   `paperGround` do `Racha.metal` foram portados do protótipo (`ios/lab`) no
   nível dos tokens, com os nomes antigos mapeados pros valores novos. Dois
   pontos só um compilador confirma: o `UIFontDescriptor` com
   `kCTFontVariationAttribute` pra pedir Archivo a largura 62 / peso 850 (o
   fallback é SF `.width(.compressed)`), e cada view que usava `Palette.paper`
   como chão claro e agora recebe a mesa — a comanda em especial precisa dos
   tokens `slip*`. `scripts/fetch-fonts.sh` baixa o Archivo variável; falta
   registrá-lo em `INFOPLIST_KEY_UIAppFonts`.
8. **A mesa (decisão #29).** `Venue`/`venueSet` no modelo, `RachaState.due/
   remainingOnTable/unpaidParticipants/isSettled/comanda`, `PixPayload.forVenue`,
   a `SettleSheet` reescrita como Pagar, `GalleryView` e `RachaTile` novos,
   `SeedData` com quatro mesas. Tudo escrito sem compilador. Pontos que só o Xcode
   confirma: `Font.weight(_:)` nos botões de texto da sheet, o `@Environment`
   do `Navigator` na galeria, e se `allStates` devolve a mesa mais recente
   primeiro (é o que `current` assume). Teste manual: abrir, ver "Bar do Zé ·
   Mesa 12 · agora", Pagar → Copiar Pix → validar o BR Code num app de banco em
   modo de teste (a chave é fictícia; o CRC tem que bater).
9. **`unassignedExtras`.** Dois testes novos em `SplitEngineTests` (o serviço
   incide no item sem dono; couvert e valor fixo não vazam pro balde) e uma
   asserção nova na propriedade de 400 contas. Escritos, não executados.

## Se algo estiver quebrado

A ordem que economiza tempo:

1. `python3 scripts/check-shaders.py` — falha silenciosa de shader não dá erro.
2. `python3 scripts/verify-money.py` — se mexeram no `Allocator` ou no `SettleUp`.
3. `xcodebuild test` — o resto.

O modo demonstração (`MockTransport`, `ProceduralImageProvider`) roda sem rede e
sem chave, então dá pra isolar UI de agente de imagem sem tocar em nenhuma API.
