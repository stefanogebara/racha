# O webhook do Pix está SEM autenticação em produção

Medido no painel da Pagar.me em 2026-09-08, na conta live `Racha`
(`acc_Gk5VlBRhaCr29RDQ`). A própria API do dashboard responde:

```json
{
  "id": "hookset_jWXVzG8HZIAM9mRO",
  "url": "https://racha-gray.vercel.app/api/webhooks/psp",
  "status": "active",
  "max_attempts": 3,
  "authentication_type": "none",
  "events": ["charge.paid", "charge.refunded"],
  "send_disabled": false
}
```

`authentication_type: "none"`.

## Por que isso importa mais que um detalhe de configuração

A revisão de segurança de 2026-09-08 achou que o adaptador conferia a
credencial assim:

```js
if (webhookBasicAuth) { …confere… }
```

Com `PAGARME_WEBHOOK_AUTH` ausente, a conferência não roda e o endpoint aceita
**corpo não autenticado**. Era a forma do inegociável #7, e a suposição ao
corrigir era que "na prática deve estar configurado".

Não está. `authentication_type: "none"` confirma que o buraco é **real e vivo**,
não teórico.

O que ele permite, junto com o ramo de reembolso que não conferia status
(corrigido no mesmo dia): o `/api/pay` devolve o `txid` no corpo da resposta,
então o cliente conhece o `ch_` da própria cobrança. Um POST sem cabeçalho
nenhum:

```
POST https://racha-gray.vercel.app/api/webhooks/psp
{"type":"charge.refunded","data":{"id":"ch_<o txid dele>"}}
```

gravava um `PAYMENT_REFUNDED` do valor inteiro. A conta desquitava e reabria
pra quem já tinha pagado, e a conciliação do dia divergia pelo ticket todo.
Qualquer terceiro que descobrisse um `ch_` — print compartilhado, ticket de
suporte — fazia o mesmo em qualquer mesa.

## Estado (2026-09-08)

| Passo | Estado |
|---|---|
| 1. Autenticação Basic no painel | **FEITO** — a API do dashboard responde `"authentication_type": "basic"` |
| 2. `PAGARME_WEBHOOK_AUTH` em produção | **FEITO** — via `vercel env add`, escopo Production |
| 3. Deploy do código novo | **PENDENTE** |

O passo 2 ficou só em Production de propósito: é pra onde o hookset aponta. Um
preview sem a variável passa a RECUSAR webhook, que é o comportamento certo
pra um preview.

A Vercel guarda a variável como Secret, então `vercel env pull` devolve
`[SENSITIVE]` e o valor não é lido de volta. Isso é higiene certa, e significa
que a única verificação honesta é a sonda de ponta a ponta abaixo.

### A sonda de aceitação

Um POST com id de cobrança INEXISTENTE. Não move dinheiro nenhum — a
autenticação roda antes, e a busca da cobrança falha depois — mas separa
"passou pela autenticação" de "não passou".

```bash
AUTH='usuario:senha'   # o mesmo par do painel e da Vercel
BODY='{"type":"charge.paid","data":{"id":"ch_inexistente_probe"}}'
U=https://racha-gray.vercel.app/api/webhooks/psp

curl -s -o /dev/null -w 'sem header: %{http_code}\n' -X POST "$U" \
  -H 'content-type: application/json' -d "$BODY"
curl -s -o /dev/null -w 'com header: %{http_code}\n' -X POST "$U" \
  -H 'content-type: application/json' \
  -H "authorization: Basic $(printf '%s' "$AUTH" | base64)" -d "$BODY"
```

**Medido ANTES do deploy (2026-09-08), com o código antigo em produção:**

```
sem header:  HTTP 402
com header:  HTTP 402
```

Os dois passam. É a vulnerabilidade demonstrada: o endpoint aceitou um corpo
NÃO AUTENTICADO e o processou (402 é a busca da cobrança falhando no
adquirente — ou seja, já passou da autenticação).

**Esperado DEPOIS do deploy:**

```
sem header:  HTTP 401  {"success":false,"code":"webhook_invalid"}
com header:  HTTP 402  (ou outro 4xx da busca da cobrança) — o que importa é NÃO ser 401
```

Se `com header` vier 401 depois do deploy, o par na Vercel não bate com o do
painel. Corrigir a variável ANTES de qualquer outra coisa: nesse estado a
confirmação de Pix depende só da conciliação ativa.

## A ordem de aplicação. Cada passo é seguro sozinho.

O código novo falha FECHADO: sem `PAGARME_WEBHOOK_AUTH` ele recusa tudo. Então
a ordem importa, e esta ordem não tem janela de quebra.

1. **Painel da Pagar.me → Configurações → Webhooks → editar
   `hookset_jWXVzG8HZIAM9mRO`.** Autenticação: Basic. Escolher usuário e senha.
   *Seguro agora:* o código EM PRODUÇÃO hoje não confere cabeçalho nenhum, então
   ele ignora o `Authorization` que passa a chegar.
2. **Vercel → variável `PAGARME_WEBHOOK_AUTH = usuario:senha`**, exatamente o
   par do passo 1, com os dois-pontos.
   *Seguro agora:* o código em produção só usa a variável se ela existir, e
   passa a conferir um cabeçalho que já está chegando certo.
3. **Deploy do código novo.** A partir daqui a ausência da variável seria
   recusa, e ela não está ausente.

Inverter 1 e 3 derruba a confirmação de Pix: o webhook chega sem credencial, o
código novo recusa, e a confirmação passa a depender só da conciliação ativa —
que existe pra isso, mas é o plano B, não o plano.

## O que mais o painel disse

- **Só dois eventos assinados:** `charge.paid` e `charge.refunded`. Então
  `order.*`, `charge.created` e `charge.antifraud_*` **não chegam** nesta conta.
  A correção que fez evento irrelevante virar `ignored` em vez de 401 continua
  certa, mas nesta conta é defesa em profundidade, não um bug vivo — a nota
  anterior dizia que esses eventos "chegam a toda hora", e nesta conta não
  chegam.
- **`max_attempts: 3`.** Então uma resposta de erro repetida não desabilita o
  endpoint aqui: ela perde o evento depois de três tentativas. É pior de um
  jeito diferente — silencioso em vez de barulhento — e reforça por que
  `unusable_money_event` alerta em vez de devolver 409.
- **`charge.refunded` é assinado**, então todo o trabalho de estorno parcial e
  de reversão vale pra esta conta, não é só preparação pra Espanha.
