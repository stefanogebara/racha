# Racha — iOS

O app nativo do [Racha](../README.md). Cada racha — um jantar, uma viagem, um
churrasco, uma casa — é uma conversa com um agente, e você folheia entre elas.

> "coloca a picanha dividida entre eu, o Gui e a Ju"
> "o Pedro chegou depois, só bebeu"
> "quanto o pessoal ainda me deve?"

O agente não faz conta. Ele lê e escreve um razão event-sourced através de
ferramentas; todo número que ele fala sai do motor de centavos inteiros. Toda
edição dele aparece rotulada embaixo da mensagem, com um botão de desfazer.

## Rodar

Precisa de **Xcode 16+** e **iOS 18+** (o `TextRenderer`, que ancora o shader do
chat, é iOS 18).

```bash
open ios/Racha.xcodeproj      # ⌘R
```

Abre no primeiro uso: uma prova (conta real, partes desiguais, somando exato),
o seu nome, e três portas. A porta "ver um exemplo" instala os rachas de amostra
— um fechado, um aberto com item sem dono, uma viagem em euro. O app **não**
semeia nada sozinho.

Funciona sem chave nenhuma: entra em modo demonstração, com o agente rodando um
script e as imagens desenhadas localmente. **As contas são reais nesse modo** —
passam pelo mesmo motor. Só as frases do agente é que são de mentira.

Pra ligar tudo, em **Ajustes**:

| Chave | O quê |
|---|---|
| Anthropic | O agente de verdade (`claude-opus-5`). |
| OpenAI | Imagens (`gpt-image-1-mini`, US$ 0,005 cada, com cache agressivo). |
| Google | Alternativa de imagem (Imagen 4 Fast / Nano Banana). |

Chaves vão pro Keychain, device-only, nunca sincronizadas.

Opcional, pra tipografia completa:

```bash
cd ios && ./scripts/fetch-fonts.sh
```

## Verificar

```bash
cd ios

# no Mac, com Xcode:
xcodebuild test -scheme Racha -destination 'platform=iOS Simulator,name=iPhone 16 Pro'

# em qualquer máquina:
python3 scripts/verify-money.py     # 12 propriedades, ~40 mil casos
python3 scripts/check-shaders.py    # aridade Metal ⇄ Swift
python3 scripts/check-pbxproj.py    # integridade do projeto
python3 scripts/check-swift.py      # delimitadores, tipos duplicados
```

Ver [`docs/verification.md`](docs/verification.md) pro que foi e o que **não** foi
executado.

## Mapa

```
Racha/
  App/        entrada, ajustes, RootView (o zoom contínuo + porteiro do 1º uso)
  Core/
    Money/    Cents, Allocator, SplitEngine, SettleUp, formato — puro, sem I/O
    Model/    eventos, projeção, estado derivado
    Store/    log append-only, repositório, seed
    Pix/      BR Code EMV + CRC-16
    History/  índice entre rachas
  Agent/      16 ferramentas, cliente SSE, sessão, prompt, mock
  Imagery/    provedores, cache endereçado por conteúdo, prato procedural
  Design/     paleta, tipografia, vidro, háptico, movimento
  Shaders/    9 shaders Metal + wrappers
  Features/   Onboarding · Timeline · Thread · Balances
RachaTests/   Swift Testing
scripts/      verificadores + gerador de ícone + fontes
docs/         arquitetura, modelo, ferramentas, shaders, imagens, decisões
```

## Docs

- [Arquitetura](docs/architecture.md) — camadas, o eixo, regras invioláveis
- [Modelo de dados](docs/data-model.md) — eventos, projeção, invariantes
- [Ferramentas do agente](docs/agent-tools.md) — o contrato com o dinheiro
- [Shaders](docs/shaders.md) — os nove, e o orçamento de bateria
- [Imagens](docs/imagery.md) — modelo, preço, cache, os quatro mundos visuais
- [Decisões](docs/decisions.md) — 15 escolhas, contra o quê, e o que mudaria
- [Verificação](docs/verification.md) — o que foi rodado e o que não foi

## As três regras

1. **Todo dinheiro é centavo inteiro.** Nada de float, em lugar nenhum. `Cents`
   não tem `/` nem `* Double` — dividir dinheiro só existe em `Allocator`.
2. **Cada centavo é contabilizado, e dá pra ver onde o resto caiu.** Quem ficou
   com o centavo a mais é dado de primeira classe, não detalhe de implementação.
3. **O agente nunca muda um valor em silêncio.** Toda escrita volta com rótulo em
   pt-BR e os ids dos eventos, que viram a faixa desfazível na tela.
