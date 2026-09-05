# Registro de decisões

Ordem cronológica. Cada uma tem o que foi decidido, contra o quê, e o que faria
mudar de ideia.

---

### 1. `Cents` é um tipo próprio, não um `typealias Int`

**Contra:** `typealias Cents = Int`, mais simples e sem conversões.
**Por quê:** um `typealias` deixa `Double` entrar por conversão implícita numa
posição de dinheiro. Um tipo distinto **sem** `/` por outro `Cents` e **sem** `*`
por `Double` torna a operação com perda literalmente indisponível: dividir
dinheiro só acontece em `Allocator`, onde o resto tem nome e dono. O compilador
vira o primeiro revisor.
**Mudaria se:** o atrito de conversão aparecesse em código de produto. Até agora
só aparece nas bordas (parse, formatação, shader), que é onde deve estar.

---

### 2. Alocação devolve `Allocation`, não `[Cents]`

**Por quê:** o briefing pede "mostre onde o resto de arredondamento cai". Uma
lista de partes perde o único fato que as pessoas realmente discutem numa mesa:
**quem ficou com o centavo a mais**. `remainderRecipients` é campo de primeira
classe, atravessa até `PersonShare.roundingAdjustment` e vira uma seção no
`LedgerSheet`. Custa uma seção e elimina a briga mais comum de conta dividida.

---

### 3. Acerto: partição exata + guloso, não só guloso

**Contra:** guloso puro (maior credor ↔ maior devedor), que dá n−1 transferências
e é o que quase todo app faz.
**Por quê:** o mínimo real é menor quando o grupo contém subconjuntos que se
resolvem sozinhos. Numa mesa de 6, `[+10, −10, +25, −25]` precisa de 2
transferências, não 3. O problema exato é NP-difícil (é partição de conjunto
disfarçada), mas até 12 pessoas — o teto realista de um jantar — uma DP por
bitmask (O(3ⁿ) ≈ 531 mil operações) resolve em milissegundos. Acima disso, cai no
guloso.
**Mudaria se:** aparecesse racha com dezenas de pessoas com frequência; aí valeria
uma heurística melhor pro caso grande.

---

### 4. `SettlementPlan` carrega `residual`

**Por quê:** quando o grupo ainda deve ao restaurante, nenhuma transferência entre
amigos consegue zerar isso. Espremer a diferença na dívida de alguém produziria o
momento "por que isso não fecha". Sai separado, com o texto explícito: *"isso é da
conta, não é dívida entre vocês."*

---

### 5. Event sourcing no app inteiro, não só nos pagamentos

**Contra:** um `RachaState` mutável salvo em JSON.
**Por quê:** o `CLAUDE.md` já exige log de eventos pra dinheiro, e o briefing
exige que toda edição do agente seja desfazível com um gesto. As duas coisas são
o mesmo mecanismo. Desfazer vira `append(.reverted(target:))` — o log guarda o
erro, a projeção pula, e a pessoa consegue ver o que o agente tentou fazer. Um
razão que esquece é um razão com que você não consegue discutir.
**Custo aceito:** reprojetar o racha inteiro a cada append. Um racha tem no máximo
algumas centenas de eventos; é barato e completamente previsível.

---

### 6. A projeção é total: nunca lança

**Por quê:** vem direto da lição gravada no `check-state.js` do backend. Um evento
mal formado ou disputado não pode tornar dinheiro real ilegível. Validação
estrita fica no *append*; na leitura, anomalia visível. Recusar abrir uma conta
por causa de um byte ruim é o pior resultado possível.

---

### 7. Sem pilha de navegação: `Navigator.zoom` é um número

**Contra:** `NavigationStack` com `matchedGeometryEffect`, que é o caminho normal.
**Por quê:** o briefing pede "um gesto contínuo, não um push de tela". Uma pilha
tem estados discretos; um número tem todos os intermediários. Com `zoom` sendo
dirigido diretamente pelo dedo, dá pra **pegar a transição no meio e mudar de
ideia** — é isso que faz um gesto parecer material em vez de botão.
**Custo aceito:** sem deep link nem restauração de estado de navegação de graça.

---

### 8. Shaders Metal próprios em vez de materiais do sistema

**Por quê:** `.ultraThinMaterial` é excelente e completamente genérico — faria o
Racha parecer o app de Ajustes. Refração de verdade (deslocar o conteúdo perto da
borda pelo gradiente do SDF) exige `layerEffect`; `colorEffect` fisicamente não
consegue, porque só vê o próprio pixel. E `imageResolve` e `tokenStream` não têm
equivalente em API nenhuma.
**Custo aceito:** GPU. Mitigado por um relógio único a 30 Hz que se desliga,
refração desligada em lista, e efeitos que se removem sozinhos ao terminar.

---

### 9. `TextRenderer` mede a cabeça de escrita em vez de estimá-la

**Contra:** assumir uma linha e usar a largura do texto.
**Por quê:** uma resposta de quatro linhas é o caso comum, e um shader ancorado
numa posição estimada fica visivelmente errado nela. `TextRenderer` anda pelos
runs já diagramados e reporta onde o último glifo realmente caiu.
**Custo:** exige iOS 18, que é o piso do projeto por causa disso.

---

### 10. Conversa em Opus 5

**Contra:** Haiku, muito mais barato.
**Por quê:** o agente resolve referências ambíguas em português ("o Pedro chegou
depois, só bebeu" precisa saber quais itens são bebida) e opera ao lado de
dinheiro. Erro nesses dois lugares custa dinheiro real de uma pessoa real. O
volume — poucos turnos por refeição — torna a diferença de preço irrelevante
perto disso. `Config.haiku` está pronto pra leitura de nota, onde o trabalho é
transcrição e o que importa é latência na mesa.

---

### 11. `gpt-image-1-mini` low, e o cache endereçado pelo prato

**Por quê:** US$ 0,005 por imagem, ~4× mais barato que a alternativa mais próxima,
e suficiente pro tamanho em que as imagens são vistas. Mas o modelo quase não
importa: a chave de cache é **o prato**, não o item, então a segunda picanha da
vida do usuário é de graça. Ver [`imagery.md`](imagery.md).

---

### 12. `MockTransport` é modo de produção, não stub de teste

**Por quê:** sem chave de API, o app precisa funcionar — e não é um demo falso: as
contas passam pelo mesmo motor de centavos, então os números que ele mostra são
verdadeiros. Só as frases estão no script. É também como as interações são
exercitadas no simulador.

---

### 13. Pastas sincronizadas do Xcode 16 no `.pbxproj`

**Contra:** listar os ~60 arquivos, ou depender de XcodeGen no fluxo normal.
**Por quê:** `PBXFileSystemSynchronizedRootGroup` faz o projeto referenciar a
**pasta**, não os arquivos. O `.pbxproj` fica com 26 objetos em vez de centenas,
arquivo novo entra no build sozinho, e some a classe de conflito "duas pessoas
adicionaram um arquivo" — que é a única coisa em que pbxproj é genuinamente ruim.
O `project.yml` fica como caminho de regeneração.

---

### 14. Swift 5, concorrência estrita mínima

**Por quê:** honestidade sobre o que foi verificado. O código é escrito com as
fronteiras de isolamento certas (`@MainActor` no que a UI observa, `actor` no I/O,
funções puras no resto), mas **nada disso foi compilado** — esta máquina não tem
toolchain Swift. Ligar Swift 6 estrito sem um compilador seria alegar uma garantia
que não existe.
**Próximo passo:** subir pra Swift 6 num Mac e resolver o que aparecer. As
fronteiras já estão desenhadas; deve ser trabalho mecânico.

---

### 15. Fontes não são versionadas

**Por quê:** DM Sans, Instrument Serif e JetBrains Mono são todas SIL OFL e
redistribuíveis, mas jogar binário de fonte num repositório de app faz ninguém
saber, de relance, qual versão está ali nem de onde veio.
`scripts/fetch-fonts.sh` deixa a procedência explícita e a atualização numa linha.
`Typo.font()` cai no serif/sans/mono do sistema sem as fontes — o app renderiza
certo, só perde calor.

---

### 16. O chão virou papel; a timeline virou contact sheet

**Contra:** manter os quatro orbes em gradiente do `styles.css`, que são a
assinatura do app web.
**Por quê:** numa página larga eles continuam certos. Numa tela de celular,
atrás de fotografias de comida, um lavado de cor grande e macio é a única coisa
que, sozinha, faz uma interface ler como gerada — e foi exatamente essa a
crítica. Trocar por papel de verdade (fibra, o pautado fraquíssimo de uma nota,
luz de cima-esquerda) mantém a família quente da marca, tira o clichê, e deixa a
**cor vir só da comida**. Ganho de lado: o fundo virou estático, então custa uma
passada de GPU no layout em vez de frames contínuos.
**E a grade:** alturas de card variadas davam ritmo decorativo — o tamanho do
card não dizia nada verdadeiro sobre o racha. Ladrilhos uniformes dizem que os
itens são pares, que é o que são, e deixam as fotos carregarem a página.
`paguei/devia` saiu do ladrilho: é detalhe de card, e repetido em todo ladrilho
transformava a galeria numa planilha com foto.

---

### 17. Transparência é requisito de produto, não preferência visual

**Por quê:** o recorte sobre papel lê como um objeto fotografado numa
superfície; a mesma imagem com fundo embutido lê como stock colado numa caixa.
Isso restringe o fornecedor de imagem de item de linha aos modelos que devolvem
alfa de verdade — hoje `gpt-image-1` e `gpt-image-1-mini` com
`background: "transparent"`. Imagen e a linha Gemini devolvem quadro opaco e por
isso servem só à capa, que é full-bleed e quer fundo.
**Custo aceito:** PNG em vez de WebP no item (o WebP com alfa não é aceito no
mesmo caminho), o que engorda o cache. O cache endereçado pelo prato absorve.

---

### 18. Auditoria de quadro por captura real

**Por quê:** o app nativo não compila aqui, mas a renderização web compila em
qualquer lugar — e o contêiner tem Chromium. Então o design passou a ser
verificado olhando: `lab/audit.js` captura cada estado de repouso **e a
transição congelada em 25%, 50% e 75%**, e cada quadro é inspecionado.
**O que só apareceu assim:** o `[hidden]` derrotado por `display:flex`; o
ladrilho voador continuando visível sobre a conversa por causa de um ternário
com `z01<=1` (sempre verdadeiro); a grade e o card ambos a meia opacidade no
meio do voo, que é literalmente o "visual glitch" reclamado; o canvas quadrado
esticado num quadro não-quadrado; e dois "falta" diferentes na tela sem nada
explicando a diferença (um inclui item sem dono, o outro não).
Nenhum desses aparece lendo o código.

---

### 19. O primeiro uso é uma prova, não um carrossel

**Contra:** três ou quatro telas de marketing explicando o que o app faz.
**Por quê:** ninguém lê carrossel de onboarding, e a alegação do produto —
"você só fala e eu faço a conta" — não se demonstra descrevendo. São três
tempos, cada um com uma tarefa:

1. **Abertura.** Diz o que é e **prova**: uma conta real dividida pelo motor
   real, com as partes **desiguais** (a Ju não bebeu, então a parte dela é
   menor). Divisão igual não prova nada — dividir por três qualquer um faz.
   A prova usa o churrasco, não o jantar, porque o jantar tem item sem dono e
   uma alegação que precisa de nota de rodapé não é prova.
2. **Seu nome.** A única coisa sem a qual o app não funciona, já que toda
   divisão precisa saber quem é "você". A chave Pix é oferecida aqui porque
   este é o único momento em que explicar *por quê* não custa nada, e é
   visivelmente opcional.
3. **Por onde começar.** Três portas de verdade. Duas caem direto numa
   conversa, porque a conversa é o produto — um boas-vindas que termina numa
   galeria vazia não ensinou nada.

---

### 20. O app não semeia dados de exemplo sozinho

**Contra:** instalar os rachas de amostra em todo primeiro lançamento (era o
que fazia antes).
**Por quê:** inventar um histórico para quem nunca teve um é desonesto, e
transforma o número do topo da galeria — quanto te devem — numa mentira no
primeiro lançamento. Agora a amostra entra só pela porta "ver um exemplo".
**Efeito colateral bom:** `hasOnboarded` passou a ser um flag próprio em vez de
ser derivado de "existe algum racha?" — alguém que apaga todos os rachas não
pode ver as boas-vindas de novo.

---

### 21. O mapa de fluxo é feito das telas, não de desenhos delas

**Por quê:** todo wireframe redesenhado descola do app na primeira semana. No
mapa (aba "Fluxo" da renderização web), cada nó é a **tela de verdade** — mesmo
CSS, mesma tipografia, mesmos números vindos do motor — a 0,295 de escala.
Se a tela mudar, o mapa muda junto; se o mapa parecer errado, é porque está.
**Custo aceito:** o mapa só existe na renderização web. O app nativo não tem um
equivalente, e não deveria — é documentação de design, não funcionalidade.

## 22 — Newsreader no lugar de Instrument Serif (2026-09-04)

**Contexto.** Doze rodadas de crítica independente sinalizaram a tipografia do
dinheiro. Medir resolveu: os algarismos da Instrument Serif são proporcionais —
o "1" tem 54% da largura do "0" (7,5pt contra 13,8pt em corpo 30). Nenhuma
coluna de valores composta nela alinha na vírgula, e tabular na mão com células
de largura fixa só deixa os "1" chacoalhando dentro da caixa.

**Decisão.** Newsreader para tudo que é linguagem e dinheiro. Uma família só,
com eixo óptico (display e texto são o mesmo desenho cortado duas vezes), e
algarismos de largura uniforme por construção — 16,83pt para todo dígito em
corpo 30. A coluna alinha porque a fonte diz, não porque o layout está
brigando. O mono saiu: fazia display, ledger e rótulo ao mesmo tempo, e um mono
de programador padrão é assinatura de trabalho feito por máquina.

**Consequência.** `Typo.Face.mono` agora aponta para Newsreader; o payload Pix
cai no monoespaçado do sistema. Duas famílias no app inteiro.

## 23 — O traço engrossa na sombra (2026-09-04)

Um contorno perfeitamente uniforme em volta de cada objeto é o sinal mais claro
de que nenhuma mão esteve envolvida. Uma goiva abre mais largo onde a lâmina
crava e mais fino onde ela levanta, então a xilogravura engrossa na aresta
sombreada. `swell()` desenha o contorno duas vezes: uma no peso base, outra a
1,9× recortada no semiplano abaixo-e-à-direita do terminador. A luz é fixa para
o conjunto inteiro, então o engrossamento cai sempre do mesmo lado.

## 24 — A comanda (2026-09-04)

O desenho estava de bom gosto em geral — papel creme, serifa, um vinho — o que
quer dizer que poderia ser de um hotel ou de uma loja de vinho. A comanda é a
única coisa que ele só poderia ser. A conta na thread virou a papeleta que o bar
brasileiro usa de verdade: número de quatro dígitos, borda picotada, pontilhado
correndo do nome até o valor, total riscado embaixo como uma nota impressa risca.

## 25 — O vinho compra estado, não botão (2026-09-04)

Duas críticas puxaram para lados opostos — "quatro vermelhos, corta pra um" e
"nenhuma cor semântica nos estados que decidem se alguém paga". As duas estavam
certas sobre a mesma coisa. O vinho agora marca estado (aberto, não pagou, sem
dono) e a ação primária é uma barra de tinta: continua sendo o objeto mais
pesado da tela por massa, sem gastar a única cor do sistema na palavra
"dividir".

## 26 — Xilogravura: o desenho vira gravura em relevo (2026-09-04)

**Contexto.** Cinco rodadas de crítica cega chamaram as ilustrações de o pior
ativo e o sinal mais claro de máquina. A versão anterior respondeu apertando o
traço — um peso, um horizonte, um ponto de vista. Ficou melhor e continuou
sendo desenho de linha, que é a forma que um gerador procura por padrão.

**Decisão.** Trocar a forma, não refinar. Xilogravura: o sujeito é uma massa
sólida de tinta; o detalhe não é somado em preto, é **removido em branco**,
porque a goiva tira tinta. Tom é uma corrida de cortes paralelos grossos. O
contorno é facetado, porque a lâmina anda em empurrões retos e o bloco lasca na
curva — `emit()` densifica todo caminho e desloca cada ponto na normal por um
ruído determinístico de duas oitavas. E a tinta nunca assenta perfeita, então um
pouco do papel atravessa (`speck`).

**Por que essa forma e não outra.** A xilogravura nordestina é a estampa do
cordel, a literatura de folheto vendida em feira. Uma comanda de bar pertence ao
mesmo mundo de papel impresso barato e cotidiano que a capa de cordel. A versão
em linha podia ter sido feita para um hotel em Copenhague; essa não.

**Consequência.** Cada sujeito é cortado como uma silhueta única e articulado
por dentro: dois blocos encostados com um fio de papel entre eles viram um
borrão só. O canal de papel que cada bloco carrega (o halo de 4,2× o peso) é o
que um impressor deixa sem cortar entre duas formas pra elas não correrem juntas
na folha — e é o que separa os sujeitos que se sobrepõem na natureza-morta.

**O que faria mudar de ideia.** Se a massa preta pesar demais numa tela de bar
com 15% de bateria e brilho baixo. A gravura é muito mais escura que a linha; é
a checagem que precisa de um telefone de verdade, não de uma captura.

## 27 — A noite do bar, não o papel creme (2026-09-05)

**Contexto.** Catorze rodadas de crítica cega bateram no mesmo teto: da terceira em
diante, toda rodada identificou o *gênero* — creme, serifa editorial, filete, um
vinho — como "a estética mais gerada que existe". Isso é julgamento sobre a
categoria, não sobre a execução; refinar a categoria não passa por ele. O
usuário apontou o air.inc como referência. A análise está em
`reference-air-inc.md`; o que importa aqui é o que ela mudou.

**O que o air.inc faz que nós não fazíamos.**
Uma atmosfera contínua em vez de seções com fundo; uma família tipográfica em
quatro cortes, com um corte comprimido super-preto a 259px contra corpo de 16px
(16:1 — o nosso era 4:1); cartões de vidro com borda de 1px translúcida e sem
sombra; demos como *UI fantasma monocromática atrás de conteúdo real colorido*;
a frase emocional no cursivo de acento; 24px como unidade e uma tela inteira
para uma palavra só.

**Decisão.** Traduzir o *sistema*, não o céu.

- **Tela.** O equivalente de Racha ao céu do Air é o bar à noite: uma tela
  escura e quente (`#141008`, umbra quase preta) com uma fonte de luz baixa, e
  a comanda creme como a única superfície clara — o papel que o Air reserva ao
  seu formulário branco. Para a xilogravura é a impressão natural em papel
  escuro: tinta creme, o bloco invertido, sem mudar uma receita.
- **Tipo.** Archivo, variável, com eixo de largura. `wdth 62 · 900` para a
  figura-cartaz (~120px em 390, entrelinha .85); `wdth 92 · 500` para títulos;
  `wdth 100 · 400` para corpo. Uma voz em três larguras, como o Control do Air.
  Algarismos tabulares em toda largura e peso — medido: dez dígitos idênticos ao
  centésimo de pixel. A Newsreader sobrevive como *acento*, do jeito que o Air
  usa o cursivo: itálica, para a fala da pessoa, nunca para o corpo.
- **Camadas.** Vidro no lugar de filete: cartões com borda `rgba(creme,.14)`,
  desfoque de fundo, lavagem interna; o racha aberto com a borda luminosa
  (gradiente cônico girando); linhas fantasma de baixo contraste atrás das
  figuras a força total.
- **Espaço.** 24px como unidade. Calha de página 24. Vão de seção 48. A figura
  do cartaz fica com um terço da tela.
- **Movimento.** `cubic-bezier(.22,1,.36,1)` a 0,6–0,9s para tudo que não é o
  morph de mola.

**Por que isso não é "vidro escuro genérico".** Quente, não frio — umbra, não
azul-marinho nem roxo; nenhum néon; disciplina de raio (16 cartão, 12 botão,
pílula, mais nada); uma só fonte de luz, baixa; e os dois objetos que só podem
ser deste produto — a comanda de papel e a xilogravura — fazendo o trabalho de
identidade.

**O que faria mudar de ideia.** Um telefone num bar escuro. Tela escura em OLED a
15% de bateria é a favor; contraste da comanda creme sobre umbra é a favor; a
legibilidade do corpo de 15px em creme a 62% é a dúvida que uma captura não
resolve.

## 28 — Parar o loop de crítica em 6/10, e por quê isso não é desistir (2026-09-05)

**Contexto.** Oito rodadas com o crítico Fable 5.1 (15–22), todas 6/10, depois
de catorze com o Opus (5,5–6,5). A instrução era seguir até 9. O relato completo
está em `design-critique-loop.md`; o que importa aqui é a decisão.

**O que as oito rodadas produziram.** Quase tudo que está certo no design atual:
a mesa lisa no lugar da vinheta, o papel que apaga em vez de pintar (o halo das
xilogravuras era o canal de separação pintado na cor do papel), uma família
tipográfica, a comanda chata, a cor como gramática (vermelhão = dinheiro saindo
do seu bolso, âmbar = pergunta em aberto, e nada mais), dois raios, uma ação de
dinheiro em cada tela, uma borda direita pra todo número — e três bugs de
dinheiro que uma revisão de design não tinha obrigação de achar: euros somados
em reais no hub; um racha "quitado" sem o pagamento que quita; o item sem dono
sem o 10% da casa, com o total da comanda R$ 1,80 abaixo do da mesa. Os três
estão corrigidos no protótipo e no motor Swift (`unassignedExtras`).

**O que as oito rodadas não moveram.** A nota. E, a partir da rodada 19, as
listas passaram a se contradizer entre rodadas (barra de status pedida na 16,
"cosplay" na 21; pílulas pedidas na 17, "template" na 21; o vermelho tirado de
"sem dono" na 18, "estado mais acionável tipografado como neutro" na 19). Um
crítico sem memória redecide gosto a cada rodada; a nota mede a distância até
uma entrega de estúdio, e essa distância tem dois componentes que pixel nenhum
move: um conjunto de pictogramas desenhado em código não tem "uma mão só" (é
uma encomenda pra um ilustrador, não uma rodada), e a conversa — fala, resposta,
sugestões, prompt — é o brief, não um template a remover.

**Decisão.** Parar aqui, com o estado verificado e documentado, e devolver a
decisão a quem pode olhar um telefone: o próximo ganho de nota é humano
(ilustrador, um bar escuro, uma escolha de produto), não mais uma rodada.

**Contra o quê.** Continuar rodando: cada rodada custa cinco minutos e devolve
uma lista real; mas da 19 em diante a lista marginal foi uma borda de 4px, uma
elipse de três pontos e a reabertura das pílulas. Trocar o crítico de novo: o
padrão se repetiu com dois modelos; o teto é do método (captura + contexto
zerado + barra de estúdio), não do modelo.

**O que faria mudar de ideia.** Um conjunto de pictogramas de verdade no lugar
das receitas. Com ele, vale uma rodada — porque aí a lista muda de natureza.

**Fora do brief, mas anotado.** O crítico disse duas vezes, com razão, que este
board é um razão entre amigos (Lisboa, praia, euros, "Pagar pro Gui") e que
acerto P2P é exatamente o fluxo de fundos que o produto de mesa evita. O brief
do iOS pediu o app de amigos; a estratégia do repo é a mesa. Os dois podem
dividir a conversa, a comanda e a xilogravura. Não podem dividir a primeira
tela. Isso é uma decisão de produto, e é de quem manda no produto.

## 29 — A mesa é o racha (2026-09-05)

**Contexto.** Vinte e duas rodadas de crítica depois, o board tinha virado um
razão entre amigos: viagem em euros, praia, "Pagar pro Gui", saldo líquido entre
pessoas. O crítico apontou duas vezes, fora do brief, que isso é um Splitwise e
que acerto P2P é exatamente o fluxo de fundos que o produto de mesa evita. Estava
certo. A estratégia do repositório é pagar na mesa: QR na mesa, cada um paga a
casa a própria parte pelo split do PSP, ninguém segura dinheiro.

**Decisão.** O app iOS é o lado do cliente do produto de mesa. A primeira tela é
a mesa em que você está: sua parte como a figura, o que falta na mesa e quem
ainda não pagou, e uma ação, Pagar. O Pix vai pra chave **da casa** (`Venue`),
com a comanda como referência pra conciliação. A mesa fecha quando a casa tem
tudo e nada está sem dono. Mesas anteriores viram histórico. A conversa, a
comanda, a xilogravura e o motor de centavos ficam como estão — a decisão muda o
hub e a sheet de pagamento, não o resto.

**Contra o quê.** Manter o app de amigos: funciona, é legal (Pix entre amigos
nas chaves deles, sem nós no meio), mas é outro negócio, com outra primeira tela
e outra razão de existir — e o gate de adoção (25% das comandas em oito semanas)
mede mesas, não viagens. Fazer os dois: podem dividir conversa, comanda e
desenho; não podem dividir a primeira tela.

**O que faria mudar de ideia.** O piloto mostrar que a mesa se divide *antes* de
sentar (o grupo já tem um racha aberto e o QR é só um evento nele). Aí a mesa
vira um capítulo do racha e o hub volta a ser a lista — mas com os pagamentos
continuando a ir pra casa, nunca entre amigos.

**Onde está.** Protótipo: `ios/lab/app.html` (semente de quatro mesas, `myDue`,
`current()`, sheet Pagar). Swift: `Venue.swift`, `venueSet`, `RachaState`
(`due(of:)`, `remainingOnTable`, `unpaidParticipants`, `isSettled` pela regra da
mesa, `comanda`), `PixPayload.forVenue`, `SettleSheet` reescrita como a sheet
Pagar, `GalleryView` como a mesa atual + mesas anteriores, `SeedData` com quatro
mesas. Nada compilado; `verification.md`.

## 30 — O telefone lê a mesa; o servidor fala com o PDV (2026-09-05)

**Contexto.** Decidida a mesa como o produto (#29), faltava o caminho de
entrada: o QR. O repositório já tinha a camada de POS do lado do servidor
(`api/_lib/pos/`: contrato, `manual`, e o Saipos de verdade) e o QR já era
impresso pelo painel como `<origin>/?t=<qr_token>`, lido por `GET /api/check`.

**Decisão.** O app escaneia e chama `GET /api/check?t=…` — nada mais. Quem
resolve o adaptador de PDV, por venue, é o servidor. Do lado do app, `TableSource`
tem duas implementações: backend e demo.

**Por quê, e é o ponto todo.** As credenciais do PDV (`idPartner`/`secret` do
Saipos) ficam no ambiente do servidor. Um telefone de cliente com credencial de
PDV dentro é um telefone perdido de distância de um incidente na loja inteira —
e seria uma credencial por venue, distribuída pra centenas de aparelhos que a
gente não controla. O token da mesa, ao contrário, é rotativo, escopado a uma
mesa e revogável num toque no painel.

**Detalhes que custaram decisão:**

- *A origem vem do QR, não do build.* Um venue white-label imprime o domínio
  dele; seguir o adesivo faz isso funcionar sem release.
- *Rótulo de mesa é texto livre.* O servidor aceita qualquer `label`; mesas
  reais se chamam "Varanda 2". Modelar como `Int` (o que eu tinha feito) perde
  metade delas em silêncio.
- *Re-escanear é diff, não import.* O garçom lança uma rodada, alguém escaneia
  de novo. Importar tudo outra vez dobraria a conta. O merge casa por nome
  dobrado + quantidade + total, contando multiplicidade (duas rodadas iguais
  são duas linhas), porque o id de item do Saipos muda entre leituras.
- *Preço não-inteiro é recusado, não adivinhado.* Um `priceCents` fracionário
  estoura em vez de virar arredondamento silencioso na conta de alguém.
- *Divergência item×total é exposta.* O total impresso manda (é o que a casa vai
  cobrar); a diferença aparece, não é "corrigida".
- *QR alheio é ignorado em silêncio.* Uma câmera varrendo uma mesa de bar vê
  wifi, Pix e Instagram; avisar a cada um seria ruído, não ajuda.

**Contra o quê.** Falar direto com o PDV do aparelho: um hop a menos e funciona
com o servidor fora do ar — e distribui credencial de loja pra telefone de
cliente. Não.

**O que faria mudar de ideia.** Um PDV que emita token efêmero por mesa, escopado
e revogável, pro próprio cliente. Aí o hop direto vira defensável.

**Onde está.** `Core/POS/` (`TableQR`, `TableSource`, `BackendTableSource`,
`DemoTableSource`, `CheckImport`, `RachaEnvironment`), `Features/Scan/`
(`ScannerView`, `ScanFlow`), `RachaTests/TableSourceTests.swift`,
`scripts/check-pos-contract.py`.

## 31 — A conciliação diária tinha canário, mas ninguém abria a gaiola (2026-09-05)

**Contexto.** Painel do restaurante. Antes de construir tela nova, fui procurar o
que faltava contra os inegociáveis. O #8 diz: conciliação diária, PSP × nossos
splits, por venue, ao centavo, com alerta alto em drift ≥ R$ 0,01.

**O que eu achei.** `reconcileVenue` e `reconcileVenueHouse` existiam e eram
testados. O único caller era `GET /api/house/admin` — ou seja, rodava só se o
dono de uma casa *com conta-corrente* abrisse aquela página. E o
`AdminHouse.tsx` nem exibia `data.reconcile`. Não havia cron. Um canário que
ninguém olha é um canário decorativo: o inegociável estava escrito, o código
estava escrito, e mesmo assim o sistema não conciliava nada.

**Decisão.** `api/_lib/checks/reconcile-daily.js` varre todos os venues; cron do
Vercel às 04:10; drift ou erro pagina pela ponte da Olímpia; o painel mostra o
resultado da última varredura.

**Detalhes que custaram decisão:**

- *Verde também aparece.* "Tudo bate ✓ — N contas conferidas às HH:MM". Se o
  painel só falasse em vermelho, "nada apareceu" e "nada foi conferido" ficariam
  idênticos na tela — que é exatamente o modo de falha do canário anterior.
- *Um venue que explode não derruba a varredura.* Vira um achado
  `venue_reconcile_threw` crítico e a varredura continua. O contrário deixaria
  as casas depois dele na ordem alfabética sem conciliação nenhuma, em silêncio.
- *Serial de propósito.* Varredura noturna não precisa de paralelismo e não vale
  martelar o banco por 30 segundos de latência.
- *Se a ponte de alerta falhar, o relatório inteiro vai pro stderr.* Perder o
  drift porque o notificador caiu seria trocar um silêncio por outro.
- *Throttle de 60s no painel.* O painel faz poll a cada 4s; sem isso, abrir a
  aba re-varreria tudo a cada carga.
- *"Isso não corrige sozinho, de propósito."* Está escrito na tela vermelha.
  Conciliação que auto-ajusta é conciliação que esconde bug de dinheiro.

**Contra o quê.** Rodar dentro do webhook, a cada pagamento. Pega drift mais
cedo e acopla o caminho do dinheiro à checagem — um erro na conciliação viraria
um pagamento recusado. A varredura fica fora do caminho crítico.

**Onde está.** `api/_lib/checks/reconcile-daily.js`, `api/_lib/notify.js`
(`notifyFounderReconcile`), `api/_app/router.js` (`/api/cron/reconcile`),
`vercel.json`, `apps/web/src/Panel.tsx` (`Conciliacao`),
`api/__tests__/reconcile-daily.test.js`.

## 32 — A divisão igual dividia o que faltava, não a conta (2026-09-05)

**O bug, que estava no ar.** No PWA do cliente, o modo "Igual" calculava a parte
sobre `remaining` — o que ainda falta — em vez de sobre o total da conta. Só o
primeiro pagante via o número certo. Numa conta de R$ 200 entre 4:

| pagante | via e pagava | devia pagar |
|---|---|---|
| 1º | R$ 50,00 | R$ 50,00 |
| 2º | R$ 37,50 | R$ 50,00 |
| 3º | R$ 28,13 | R$ 50,00 |
| 4º | R$ 21,10 | R$ 50,00 |

A casa recebia R$ 136,73 e ficava com R$ 63,27 na mesa, sem ninguém entender por
quê — cada telefone mostrava um número diferente pra "dividir entre 4", e todo
mundo achava que tinha pago sua parte. A mesa não fecha e o garçom vira o
cobrador. Como cada pagamento individual era válido, nada no servidor reclamava.

**Decisão.** `shareBaseCents` no modo `igual` divide `totalCents`. O teto
(`splitEqualLocal(total, n, 0)`) é intencional: cada telefone calcula sozinho,
sem saber quantos já pagaram, então não dá pra distribuir o centavo do resto por
posição. Se todos arredondassem pra baixo, a conta fecharia com resto e a mesa
não fecharia nunca. Com o teto, o buraco vai todo pro último pagante, que já era
limitado ao que falta — o desconto dele é sempre menor que 1 centavo por pessoa
(< R$ 0,20 numa mesa de 20), e **ninguém paga mais do que o número que a tela
prometeu**.

**Por que ninguém pegou isso.** `split.ts` é uma SEGUNDA implementação da
matemática que já existe em `api/_lib/checks/split-engine.js`, e o cabeçalho
dela promete que as duas "concordam ao centavo". Nada verificava a promessa.
Uma segunda implementação sem teste de paridade é só uma divergência com um
comentário em cima. Agora `apps/web/test/split.test.ts` roda no `node --test`
(Node 22 tira os tipos sozinho — zero build, zero dependência nova) e prova, em
milhares de casos: paridade de `splitEqual` e `servicoCents` com o backend, e a
propriedade que o código violava — **N pagantes em "igual" fecham a conta
exatamente**. Restaurando a linha antiga, 3 dos 10 testes quebram.

**Dois outros achados do mesmo caminho:**

- *Erro de pagamento virava beco sem saída.* A corrida mais comum da mesa é duas
  pessoas tocando "Pagar R$ 50" ao mesmo tempo: uma ganha, a outra leva 400 do
  servidor ("valor acima do que falta"). O `catch` jogava isso no `error` fatal,
  que era checado antes de tudo — a tela inteira virava uma frase. Agora
  `payError` é inline, recarrega a conta e deixa a pessoa tocar de novo.
- *Um blip de 4G apagava o código Pix.* O poll de 4s escrevia no mesmo `error`
  fatal. O caso real: o cliente copia o código, troca pro app do banco, o sinal
  do bar oscila, ele volta — e no lugar do Pix está "Failed to fetch".
  Verificado no Chromium, abortando `/api/check`: antes a tela virava a frase,
  agora fica de pé com "sem conexão — o código abaixo continua valendo", e o
  aviso some quando o sinal volta. Só a PRIMEIRA carga falha em tela cheia,
  porque aí realmente não há tela.

**O service worker que não entrou.** "PWA" convida a cachear tudo, mas o cliente
que escaneia o QR é sempre visita nova num cache vazio: o SW não ajuda em nada
na única carga que importa, e cacheia dado de dinheiro que muda a cada 4
segundos. O manifest fica (dá pra instalar `/carteira`); service worker, não.

**Onde está.** `apps/web/src/split.ts`, `apps/web/src/App.tsx`,
`apps/web/test/split.test.ts`, `apps/web/tsconfig.test.json`, `jest.config.js`.
