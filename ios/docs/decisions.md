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
