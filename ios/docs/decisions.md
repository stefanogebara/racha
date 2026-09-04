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
