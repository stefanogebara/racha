# Inventário de shaders

Nove shaders em `Racha/Shaders/Racha.metal`, com os wrappers em
`RachaShaders.swift`. Rode `python3 scripts/check-shaders.py` depois de mexer em
qualquer um: **o SwiftUI liga argumento de shader por posição, sem checagem de
nome nem de aridade**, então um argumento a menos renderiza lixo — ou nada — sem
erro de compilação e sem mensagem em runtime.

## ABI

```
colorEffect       half4  f(float2 position, half4 color, ...extra)
layerEffect       half4  f(float2 position, SwiftUI::Layer layer, ...extra)
distortionEffect  float2 f(float2 position, ...extra)
```

`position` vem em **espaço do usuário (pontos)**, não em UV — por isso quase toda
função recebe `size` e se normaliza.

| # | Shader | Efeito | Onde aparece | Por que existe |
|---|---|---|---|---|
| 1 | `warmGround` | color | fundo do app | Os quatro gradientes do CSS, respirando. **Com dither de ±1/255** — sem ele os degradês largos e de baixo contraste fazem bandas visíveis em OLED. |
| 2 | `liquidGlass` | layer | `GlassCard` | Refração de verdade: desloca o conteúdo perto da borda pelo gradiente do SDF. Dispersão cromática **só no fio da borda** — no card inteiro vira tela quebrada. Brilho de quina que segue a inclinação do aparelho. É `layerEffect` porque `colorEffect` fisicamente não consegue refratar: só vê o próprio pixel. |
| 3 | `imageResolve` | layer | `DishImageView` | A foto **revela**: frente de onda diagonal amaciada por ruído, linha cáustica cavalgando a borda, grão que some. Fade não conta nada; isso conta que a imagem está condensando. |
| 4 | `tokenStream` | layer | `StreamingText` | Ancorado no **x/y do último glifo**, medido pelo `TextRenderer`, então acompanha texto quebrado em linhas em vez de assumir uma linha só. |
| 5 | `settledBurst` | layer | tela inteira, ao fechar | Onda de choque esmeralda que distorce o que atravessa, 24 faíscas no anel, bloom interno. Roda uma vez, ~1,1 s. |
| 6 | `zoomMorph` | distortion | timeline ⇄ thread | A metade *material* do zoom: tensão que **pica em 0,5 e some nas duas pontas**, então nenhum estado de repouso é distorcido. |
| 7 | `progressLiquid` | color | barra de "quanto falta" | Menisco com duas ondas fora de fase (uma senoide só denuncia), correntes internas, e `energy` que sobe quando o valor muda — a barra balança. |
| 8 | `paperGrain` | color | fundo | Grão de amplitude baixíssima + fibra de papel de comprimento de onda longo. Estático de propósito: grão animado vira ruído de vídeo e gasta bateria à toa. |
| 9 | `pressable` | distortion | `RachaButton` | Comprime **na direção do toque**, não uniformemente. Escala uniforme é a assinatura de um botão digital. |

## Orçamento de energia

A pessoa está num bar barulhento com 15% de bateria. Isso é requisito, não
enfeite:

- **Um relógio só.** `ShaderClock` é um `CADisplayLink` a 30 Hz preferidos,
  compartilhado, que se desliga quando o último observador some. Vários
  `TimelineView` seriam vários loops de redraw a 120 Hz.
- **Refração desligada em lista.** `RachaCard` passa `refract: false`. Vinte
  `layerEffect` rolando ao mesmo tempo é o único jeito de esses visuais virarem
  reclamação de bateria.
- **`zoomMorph` só em voo.** Fora do intervalo (0,02 · 0,98) o modificador nem é
  aplicado.
- **`imageResolve` some ao terminar.** Em `progress >= 0.999` é passagem direta,
  e um acerto de cache pula a animação inteira — o efeito se paga por ser raro.

## Acessibilidade

- **Reduce Motion** congela `warmGround` numa fase bonita em vez de apagar a cor
  (a cor é a marca; a deriva não é), desliga `zoomMorph`, `settledBurst`,
  `tokenStream` e a revelação da imagem.
- **Reduce Transparency** troca o vidro por superfície opaca em `GlassCard`.
- Nenhum shader carrega informação sozinho. Tudo que eles dizem também está dito
  em texto — a barra tem número ao lado, o burst tem a faixa "Fechado, tudo quite".
