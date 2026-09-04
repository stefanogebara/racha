# Contrato das ferramentas do agente

O agente **não faz conta**. Ele lê e escreve o razão; todo número que ele fala sai
de `ver_racha`. As ferramentas são o contrato entre o modelo e o dinheiro.

## Invariantes do contrato

1. **Todo valor é centavo inteiro.** `R$ 47,50` → `4750`.
   `JSONValue.cents(_:)` **recusa** um `Double` não-inteiro: um modelo que responde
   `47.50` num campo de centavos está na unidade errada, e falhar alto é melhor
   do que cobrar R$ 0,47 de alguém. Uma `String` passa pelo mesmo parser pt-BR do
   teclado, que é o único caso permissivo que vale a pena.
2. **Toda escrita devolve `preview` + `eventIDs`.** O `preview` é pt-BR e vira a
   faixa de edição embaixo da mensagem; os `eventIDs` são a alça do desfazer.
   Uma ferramenta que escreve sem devolver os dois é um bug, não uma otimização.
3. **Ambiguidade é erro, não escolha.** Dois "Ju" na mesa e `ParticipantResolver`
   devolve `.ambiguous`; a ferramenta falha e o prompt manda perguntar. Dinheiro
   no nome errado é mais caro que uma pergunta.
4. **Nada é inventado.** Item sem valor → erro. Chave Pix ausente → erro pedindo a
   chave. Nunca um palpite.
5. **Toda escrita devolve o snapshot fresco.** O modelo nunca mantém modelo próprio
   da conta — é o que faz "quanto o Gui deve?" continuar certo depois de a pessoa
   ter editado algo na mão no meio da conversa.

## As ferramentas

### Leitura

| Nome | Devolve |
|---|---|
| `ver_racha` | Estado completo: itens, donos, extras, quanto cada um deve, quem pagou, o que falta, **e em quem caiu cada centavo de arredondamento**. |
| `acertar_contas` | Menor conjunto de transferências + `falta_pagar` separado. Não move dinheiro. |
| `gerar_codigo_pix` | Copia-e-cola de uma transferência. Erro se o recebedor não tem chave salva. |
| `consultar_historico` | `pendencias` (atravessa **todos** os rachas abertos), `pessoas`, `grupos`. |
| `consultar_lugar` | Visitas, gasto mediano, itens que sempre aparecem, serviço, couvert. |

### Escrita

| Nome | Faz |
|---|---|
| `registrar_itens_da_nota` | Itens lidos de uma foto + serviço e couvert impressos. Ilegíveis vão em `ilegiveis`. |
| `adicionar_itens` | Gasto falado ("a Uber deu 38 reais"). |
| `editar_item` | Corrige. `total_cents` vence — a nota é a autoridade. |
| `remover_item` | Tira da conta. |
| `atribuir_itens` | O coração. `pessoas: []` tira todos os donos; `pesos` na mesma ordem. |
| `adicionar_pessoa` | Entra na mesa, com chave Pix opcional. |
| `definir_extra` | `percentual` (bp) · `por_cabeca` · `fixo` · `desconto`. |
| `ligar_desligar_extra` | Tira o serviço sem apagar. |
| `registrar_pagamento` | `confirmado: false` = intenção, não dinheiro. |
| `definir_moeda` | Trava a cotação no racha. |
| `renomear_racha` | Nome + tipo. O histórico usa o nome. |

## Exemplo de ida e volta

Pessoa: *"coloca a picanha dividida entre eu, o Gui e a Ju"*

```jsonc
// modelo → app
{ "name": "atribuir_itens",
  "input": { "atribuicoes": [
    { "item": "Picanha na chapa", "pessoas": ["eu", "Gui", "Ju"] } ] } }

// app → modelo
{ "ok": true,
  "estado": { "total_cents": 18150, "conferido": true,
    "pessoas": [
      { "nome": "Você", "eu": true, "consumo_cents": 4300,
        "deve_cents": 4730, "centavos_de_arredondamento": 1 },
      { "nome": "Gui",  "consumo_cents": 4300, "deve_cents": 4730 },
      { "nome": "Ju",   "consumo_cents": 4300, "deve_cents": 4730 } ] } }
```

E na tela, embaixo da resposta do agente:

```
✎  Picanha na chapa → Você, Gui, Ju          +R$ 129,00      [desfazer]
```

## Modelo e custo

- **Conversa: `claude-opus-5`.** O agente resolve referências ambíguas em
  português e raciocina perto de dinheiro — dois lugares onde o erro de um modelo
  mais barato custa dinheiro real de uma pessoa real. O volume (poucos turnos por
  refeição) torna a diferença de preço irrelevante.
- **Nota: `claude-haiku-4-5`** está configurado em `Config.haiku`, para quando a
  leitura de nota virar uma chamada separada — ali o trabalho é transcrição, e o
  que importa na mesa é latência.
- O bloco de sistema é **um só e cacheável** (`cache_control: ephemeral`). Ele é
  idêntico em todo turno de todo racha, então cachear é quase todo o custo por
  turno indo embora.

## Limites

- **Seis rodadas de ferramenta por turno.** Um modelo que chama ferramenta pra
  sempre queimaria bateria e dinheiro; nenhum pedido real precisa de mais.
- **O razão não volta atrás num turno que falhou.** Se a rede morre depois de o
  agente ter atribuído três itens, as três atribuições ficam. Foram edições reais,
  a pessoa viu acontecer, e cada uma é desfazível sozinha.
- **A transcrição não replica o tráfego de ferramenta ao recarregar.** Os
  resultados antigos referenciavam um estado que já andou; o modelo relê com
  `ver_racha`, que é mais barato e sempre certo.
