# Modelo de dados

## O log é a verdade

```
RachaEvent { id, rachaID, seq, at, origin, summary, body, revertedBy }
```

- **`seq`** é monotônico por racha e é a ordem da dobra. Nunca `at` — relógio
  anda pra trás entre aparelhos.
- **`origin`** é `user | agent | scan | system`. A UI marca as do agente.
- **`summary`** é pt-BR, escrito **no momento do append**, onde a intenção é
  conhecida. Reconstruir depois a partir do `body` faz o rótulo divergir do que
  aconteceu.
- **`.reverted(target:)`** é como se desfaz. Nada é apagado.

### Eventos

| Grupo | Eventos |
|---|---|
| Racha | `created`, `renamed`, `kindChanged`, `coverImageSet`, `noteAdded`, `settled`, `reopened` |
| Pessoas | `participantAdded`, `participantRemoved`, `participantRenamed`, `pixKeySet` |
| Itens | `itemsAdded`, `itemRemoved`, `itemEdited` |
| Divisão | `claimsSet`, `claimsCleared` |
| Extras | `extraAdded`, `extraUpdated`, `extraRemoved`, `extraToggled` |
| Dinheiro | `paymentRecorded`, `paymentConfirmed`, `paymentRemoved` |
| Moeda | `fxRateSet` |
| Meta | `reverted` |

### Totalidade da projeção

`RachaProjection.reduce` **nunca lança e nunca trava**. Evento que referencia
entidade inexistente, ou que se contradiz, vai pra `state.anomalies` e é pulado.
A validação estrita é no *append*. Quando um log já está no disco, recusar
mostrá-lo é o pior resultado possível — é dinheiro de verdade ali dentro.

Garantias específicas codificadas na projeção:

- `paymentRecorded` é **idempotente por id** (webhook repetido não cobra duas vezes).
- Duas reivindicações da mesma pessoa no mesmo item **colapsam em uma** — senão o
  peso dobrava e o dinheiro mudava em silêncio.
- Tirar uma pessoa **devolve os itens dela pro estado sem dono**, não redistribui.
  Reatribuir a comida de alguém sozinho é pior do que perguntar.
- `itemEdited` com `total` fixado **vence** o recálculo por quantidade: a nota é a
  autoridade. Sem `total`, mudar quantidade ou preço unitário recalcula.

## Estado derivado

```
RachaState { id, title, kind, currency, participants, items, claimsByItem,
             extras, payments, fxRates, coverAssetKey, notes, settledAt, anomalies }
```

Nada é armazenado duas vezes. `split`, `balances`, `settlement`, `isSettled` são
computados a partir do estado, sempre.

### Item

```
LineItem { id, name, quantity, unitPrice, total, category, rawText }
```

`total` é guardado ao lado de `quantity × unitPrice` em vez de derivado, porque
nota brasileira discorda de si mesma o tempo todo (item por peso, desconto numa
linha só). Quando divergem, **`total` vence** e `isInconsistent` marca a linha —
a UI mostra "confere?" em vez de recalcular escondido.

### Reivindicação

```
Claim { id, itemID, personID, weight }
```

`weight` é o que faz "o Pedro tomou dois dos quatro chopps" caber sem quebrar a
linha em três: pesos 2, 1, 1.

### Extra

```
Extra { id, label, kind, base, isEnabled, isGratuity }
kind: .percentage(bp:) | .fixed(Cents) | .perHead(Cents) | .discount(Cents)
base: .consumption | .consumptionPlusEarlierExtras | .equalHeads
```

`base` existe porque "10% do quê" é uma pergunta real e frequentemente discutida
numa mesa brasileira. Deixar implícito seria escolher por todo mundo.

### Pagamento

```
Payment { id, payerID, amount, method, note, confirmedAt, createdAt }
```

`isConfirmed` separa "eu disse que ia pagar" de "caiu". Saldo só conta dinheiro
confirmado, então um toque otimista nunca faz dívida sumir.

## Divisão

```
SplitResult { shares, total, itemsTotal, claimedTotal, unassigned, unassignedTotal }
PersonShare { personID, consumption, extras[], roundingAdjustment }
```

A invariante que **pode** falhar, e por isso é a que vale assertar:

```
claimedTotal + unassignedTotal == itemsTotal
```

Nenhum centavo de item reivindicado some entre o item e as pessoas. Participante
derrubado, peso errado, regressão no alocador — tudo aparece aqui. (Extras não
falham do mesmo jeito: o `Allocator` garante que as partes de cada extra somam
aquele extra, então dobrá-los junto só esconderia o sinal.)

## Saldo e acerto

```
NetBalance { personID, paid, owed, net }     net = paid − owed
SettlementPlan { transfers, residual }
```

`residual` é o que o grupo ainda deve ao restaurante. Nenhuma transferência entre
amigos consegue zerar isso, então sai separado em vez de ser empurrado pra dívida
de alguém. Um racha só está fechado quando `residual == 0` **e** ninguém deve a
ninguém — o restaurante ter sido pago não significa que quem adiantou foi ressarcido.

## Histórico entre rachas

`HistoryIndex` é reconstruído em memória a partir dos estados, sob demanda. Não é
tabela desnormalizada — um racha é pequeno, o telefone é rápido, e um índice
persistido que discorda do razão é exatamente a classe de bug que este código
recusa.

Responde: com quem você divide conta, grupos recorrentes, como a conta de um
lugar costuma ser, e **quanto cada pessoa ainda deve somando todos os rachas
abertos** — que é a pergunta "quanto o pessoal ainda me deve?".

## No disco

```
Application Support/Racha/Events/<uuid>.jsonl    ← o razão, append-only
Application Support/Racha/Threads/<uuid>.json    ← a conversa
Caches/Racha/Images/<chave>.webp                 ← imagens geradas
Keychain com.racha.keys                          ← chaves de API
UserDefaults                                     ← nome, chave Pix, cidade, preferências
```

Conversa e razão em arquivos separados de propósito: mensagem de chat não é fato
contábil, e perder a conversa nunca pode arriscar o dinheiro.

Chaves de API vão pro Keychain com
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — nunca sincronizadas, nunca
presentes num aparelho restaurado, nunca num backup em texto claro.
