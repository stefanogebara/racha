# Imagens geradas

## Modelo e preço

Levantado em setembro de 2026, por imagem 1024×1024:

| modelo | fornecedor | US$/imagem |
|---|---|---|
| **`gpt-image-1-mini` (low)** | OpenAI | **0,005** ← padrão |
| `gpt-image-1-mini` (medium) | OpenAI | ~0,011 |
| `imagen-4.0-fast` | Google | 0,020 |
| `gemini-3.1-flash-lite-image` | Google | 0,0336 |
| `gemini-3.1-flash-image` (Nano Banana 2) | Google | 0,045–0,15 |
| `gemini-3-pro-image` (Nano Banana Pro) | Google | 0,13–0,24 |

**O motivo do padrão é a transparência, não o preço.** `gpt-image-1` e
`gpt-image-1-mini` são os únicos modelos atuais que devolvem canal alfa de
verdade (`background: "transparent"`), e o recorte é o que faz a grade
funcionar: um prato pousado no papel do app, com a própria sombra de contato,
lê como objeto fotografado numa superfície. Um prato entregue com fundo embutido
lê como stock colado numa caixa, e estilo nenhum recupera disso — é a maior
diferença entre a galeria parecer desenhada e parecer gerada.

Imagen e a linha Gemini devolvem quadro opaco, então ficam como tier de
qualidade da **capa** (que é full-bleed e quer fundo) e nunca de item de linha.
No mais, `gpt-image-1-mini` no tier `low` ainda é ~4× mais barato que a
alternativa mais próxima e mais que suficiente para um ladrilho de 160 pt, que é
o tamanho em que essas imagens são realmente vistas. `medium` fica reservado pra capa do racha, que
aparece grande na timeline. Trocar de fornecedor é uma linha em
`ImageEngine.fromSettings`.

## O cache é a economia inteira

A chave é **o prato, não o item**:

```
v4.plate.picanha-com-fritas
v4.glass.chopp-500ml
v4.cover.jantar.chopp+farofa+picanha
```

Duas pessoas pedindo picanha em dois restaurantes em duas noites batem na mesma
imagem. Ao longo do histórico de um usuário a taxa de acerto em comida é alta,
porque gente pede as mesmas coisas. O custo marginal da centésima picanha é zero.

O `v4` é a versão do estilo e faz parte da chave: mexer numa palavra da receita
invalida só o que foi feito com a redação antiga, sem servir uma galeria de
aparências misturadas nem jogar fora cache já pago.

Antes de virar chave, o nome passa por `ImageStyle.subject`, que limpa o ruído do
PDV: `2X PICANHA C/ FRITAS **` → `picanha com fritas`.

Detalhes que evitam gastar duas vezes:
- **Chamadas concorrentes compartilham uma requisição** (`inFlight`). Uma timeline
  passando por doze chopps iguais gera uma imagem, não doze.
- **Falha é cacheada por 30 min.** Um item que o gerador recusa não é retentado a
  cada scroll.
- **O custo é mostrado.** Ajustes exibe `US$ X,XX em N imagens` e o tamanho do
  cache. Um app que gasta dinheiro em silêncio é um app que se apaga.

## Quatro mundos visuais

Um jantar tem que ler como uma mesa posta; um racha de Uber, Airbnb e ingresso
precisa da própria linguagem. `ItemCategory.world` decide:

| mundo | encenação | categorias |
|---|---|---|
| `plate` | cenital, prato de cerâmica fosca | carne, peixe, massa, petisco, salada, acompanhamento, sobremesa |
| `glass` | três quartos, copo brasileiro, condensação, balcão de madeira | cerveja, drink, vinho, refrigerante, café, suco |
| `object` | natureza-morta de produto, objeto isolado | transporte, hospedagem, ingresso, mercado, combustível, assinatura |
| `abstract` | papel dobrado e luz rasante, quase monocromático | couvert, serviço, taxa, outro |

Todo prompt termina com a mesma constante de casa (Hasselblad, 100 mm macro,
f/5.6, softbox em cima à esquerda, fundo `#FAFAF9`, cor levemente dessaturada com
subtom âmbar). É isso que faz vinte imagens geradas com semanas de diferença
parecerem do mesmo fotógrafo.

A capa do racha é composta dos **três itens mais caros** — uma foto da refeição,
não de uma categoria.

## Sem chave, sem sinal: nunca um buraco

`ProceduralImageProvider` desenha o prato localmente: fundo quente, disco de
cerâmica com sombra, dois ou três blobs orgânicos (círculo com raio ondulado em
harmônicos) em matizes presos na metade quente da roda de cores, e grão por cima.

É **determinístico** — mesma semente, mesma imagem, pra sempre (FNV-1a, não
`hashValue`, que o Swift semeia por processo). Um placeholder que se reembaralha
a cada abertura faz a timeline inteira parecer não confiável.

## Como a imagem chega

`imageResolve` (ver [`shaders.md`](shaders.md)): a imagem **revela** numa frente
de onda diagonal com cáustica e grão, em vez de fazer fade. Mas um acerto de
cache pula a animação inteira: uma foto que a pessoa já viu revelar de novo a
cada scroll seria irritante, não encantador. O efeito se paga por ser raro.
