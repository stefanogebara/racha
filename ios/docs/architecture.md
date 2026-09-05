# Arquitetura

> Onde cada coisa mora e por quê. Se você só tem cinco minutos, leia
> [Regras invioláveis](#regras-invioláveis) e [O eixo](#o-eixo).

## O eixo

Um racha é **uma conversa com um agente**, e o agente não faz conta. Ele lê e
escreve um razão através de ferramentas; o razão é um log de eventos; o estado é
derivado do log; o dinheiro é sempre centavo inteiro.

```
      pessoa fala                     agente responde
           │                                 ▲
           ▼                                 │
   ┌───────────────┐   ferramentas    ┌──────────────┐
   │ AgentSession  │ ───────────────▶ │ AgentToolbox │
   └───────────────┘ ◀─────────────── └──────┬───────┘
           │           snapshot               │ append
           │                                  ▼
           │                        ┌──────────────────┐
           │                        │ RachaRepository  │
           │                        └────────┬─────────┘
           │                                 │
           │                        ┌────────▼─────────┐
           │                        │   EventStore     │  ← append-only, .jsonl
           │                        └────────┬─────────┘
           │                                 │ fold
           │                        ┌────────▼─────────┐
           └──── observa ─────────▶ │   RachaState     │
                                    └────────┬─────────┘
                                             │ puro
                                    ┌────────▼─────────┐
                                    │ SplitEngine      │
                                    │ SettleUp         │
                                    └──────────────────┘
```

Nada pula etapa. Um toque na tela e uma frase do agente entram pelo mesmo lugar
(`RachaRepository.append`), o que é o motivo de **toda** edição ser desfazível, não
só as do agente.

## Da mesa pro racha

O QR na mesa carrega `<origin>/?t=<token>` — o mesmo adesivo que o diner web já
usa (`apps/web/src/Qrs.tsx`). O token é rotativo (`POST /api/tables/rotate`) e é
tratado como credencial: nunca vai pro log, nunca pro event store, nunca pra tela.

```
   adesivo na mesa
        │  TableQR.parse — recusa wifi, Pix, Instagram
        ▼
   ┌──────────────┐   GET /api/check?t=…   ┌─────────────────────┐
   │ TableSource  │ ─────────────────────▶ │ servidor do Racha   │
   │ (protocolo)  │ ◀───────────────────── │ resolve o POS       │
   └──────┬───────┘      OpenCheck         │ manual │ Saipos │ … │
          │                                └─────────────────────┘
          ▼
   ┌──────────────┐  venueSet + itemsAdded + serviço
   │ CheckImport  │ ───────────────────────────────▶ RachaRepository
   └──────────────┘  (re-scan = diff, nunca duplica)
```

**As credenciais do POS não passam pelo telefone.** `idPartner`/`secret` do
Saipos vivem no ambiente do servidor (`api/_lib/pos/`) e ficam lá; o aparelho só
apresenta um token que leu de um adesivo. Um telefone de cliente com credencial
de PDV dentro é um telefone perdido de distância de um incidente na loja inteira.

Por isso os "providers" aqui não são `manual`/`saipos`/`colibri` — essa escolha é
do servidor, por venue. Do lado do app só existem duas fontes: o backend
(`BackendTableSource`) e a demo embutida (`DemoTableSource`), que mantém a
promessa de rodar sem chave e sem rede.

O contrato entre os dois lados é conferido por `scripts/check-pos-contract.py`:
ele compara as chaves que o decoder Swift lê com as que o servidor emite. Sem
isso, renomear `priceCents` no servidor não quebraria build nenhum — o app só
leria uma conta vazia, num sábado, na mesa de alguém.

## Regras invioláveis

Vindas do `CLAUDE.md` da raiz do repositório e do briefing do produto. Cada uma
está codificada num lugar específico, não confiada à disciplina de quem edita:

| Regra | Onde vive |
|---|---|
| Todo dinheiro é centavo inteiro, nunca float | `Cents` é tipo próprio, sem `/` e sem `*` por `Double`. Dividir dinheiro só existe em `Allocator`. |
| Cada centavo é contabilizado, e dá pra ver onde o resto caiu | `Allocation.remainderRecipients` → `PersonShare.roundingAdjustment` → seção "Arredondamento" no `LedgerSheet`. |
| O agente nunca muda um valor em silêncio | Toda ferramenta de escrita devolve `preview` + `eventIDs` → `LedgerEdit` → faixa desfazível embaixo da mensagem. |
| Desfazer é um gesto | `EditRibbon`: botão *e* swipe pra esquerda. `RachaRepository.undo(group:)` reverte a edição inteira. |
| O serviço de 10% é opcional (CDC) | `Extra.isEnabled` é sempre gravável. Nada no modelo consegue marcar um extra como obrigatório. |
| Serviço é proporcional ao consumo | `SplitEngine`: percentual é calculado **por pessoa**, sobre a base dela. Nunca rateado liso. |
| Gorjeta é remuneração da equipe | `Extra.isGratuity`, somada separada em `RachaState.enabledGratuity`. `PixPayload` só monta transferência entre pessoas — nunca roteia gorjeta pra chave pessoal. |
| Estado de pagamento é event-sourced | `RachaEvent` é append-only. `RachaProjection.reduce` é total: evento ruim vira anomalia visível, nunca trava a conta. |

## Camadas

### `Core/Money` — puro, sem I/O, exaustivamente testado

- **`Cents`** — inteiro com nome. A ausência de `/` e de `* Double` é o ponto:
  o compilador é o primeiro revisor.
- **`Allocator`** — `equal` (resto rotacionado, igual ao `split-engine.js`) e
  `proportional` (maior-resto / método de Hamilton). Devolve `Allocation`, que
  carrega **quem ficou com o centavo**, não só as partes.
- **`SplitEngine`** — itens com peso, extras proporcionais, couvert por cabeça,
  desconto. Puro: mesma entrada, mesma saída, pra sempre.
- **`SettleUp`** — partição exata em subconjuntos de soma zero (DP por bitmask,
  até 12 pessoas) + guloso dentro de cada um. Devolve `SettlementPlan` com
  `residual` separado.
- **`MoneyFormat`** — texto ⇄ `Cents` direto, sem `Double` no meio.
- **`Currency` / `FXRate`** — cotação travada no racha, em micros inteiros.

### `Core/Model` + `Core/Store` — o razão

`RachaEvent` (append-only) → `RachaProjection.reduce` → `RachaState` (derivado).
`EventStore` grava JSON-lines, um arquivo por racha: append é uma escrita no fim
do arquivo, e uma linha corrompida vira anomalia em vez de impedir a conta de abrir.

Desfazer **não apaga**: acrescenta `.reverted(target:)`. O log guarda o erro, a
projeção pula. Um razão que esquece é um razão com que você não consegue discutir.

### `Core/Pix` — BR Code de verdade

TLV do EMVCo + template do Bacen + CRC-16/CCITT-FALSE sobre o payload inteiro
*incluindo* o literal `6304`. Testado contra o vetor canônico (`123456789` → `29B1`)
e contra o exemplo do Bacen.

### `Agent` — ferramentas, streaming, jornal de edições

16 ferramentas em pt-BR. Cliente SSE próprio, porque o app precisa dos deltas
token a token **com o tempo preservado** — é isso que alimenta o shader do chat.
Argumentos de ferramenta só são parseados no `content_block_stop`: JSON parcial
que "quase" decodifica chamaria ferramenta de dinheiro pela metade.

`MockTransport` é modo de produção, não stub: sem chave, o app funciona e as
contas continuam reais.

### `Design` + `Shaders` — o material

Portado do `apps/web/src/styles.css` (Warm Glass) e levado adiante em Metal.
Nove shaders, inventário em [`shaders.md`](shaders.md). Um relógio só
(`ShaderClock`, CADisplayLink a 30Hz, desliga quando ninguém observa).

### `Imagery` — imagem por item, cache agressivo

`gpt-image-1-mini` por padrão (US$ 0,005/imagem). A chave de cache é **o prato**,
não o item — a segunda picanha da vida do usuário é de graça. Detalhes em
[`imagery.md`](imagery.md).

### `Features` — as três telas que são uma só

`RootView` não tem pilha de navegação. `Navigator.zoom` é um número de 0 a 1 e a
timeline e o thread são as duas pontas dele.

## Concorrência

- `RachaRepository`, `AgentSession`, `Navigator`, `AppSettings`, `Haptics`,
  `TiltSource`, `ShaderClock` são `@MainActor` — tudo que a UI observa.
- `EventStore`, `TranscriptStore`, `ImageCache` são `actor` — I/O fora da main.
- `SplitEngine`, `Allocator`, `SettleUp`, `PixPayload`, `RachaProjection`,
  `ItemCategorizer`, `ImageStyle` são funções puras em `enum`, sem estado.

O projeto está em Swift 5 com concorrência estrita mínima. Migrar pra Swift 6
estrito é trabalho real e está anotado em [`decisions.md`](decisions.md).

## O que não existe (e por quê)

- **Sem backend.** Tudo é local. O racha do jantar de ontem não precisa de
  servidor, e o repositório do web app já tem o lado de restaurante.
- **Sem sincronização entre aparelhos.** O log de eventos é a base certa pra isso
  (CRDT-friendly: eventos com seq por racha), mas não está feito.
- **Sem tab bar.** O thread é o produto; uma tab bar diria o contrário.
