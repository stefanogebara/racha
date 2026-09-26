# Saldo debitado sem pagamento na conta

O cliente pagou com o saldo da casa, o saldo baixou, e a conta não recebeu o
pagamento. O caso vizinho, o adquirente que cobrou sem linha de pagamento
nossa, é outro: ver `dinheiro-sem-conta.md`.

## Como aparece

- **Conciliação da casa:** achado crítico `house_redeem_missing_payment_row`,
  com o valor e o cliente. Aparece na **página da carteira** (`AdminHouse`,
  desde 2026-09-26), no painel (`/api/panel`) e no stderr do
  `/api/house/admin`. Desde a 0044 a linha tem o botão **"Devolver R$ X ao
  saldo"**. A frase manda o dono devolver pelo botão, avisar o cliente e, se ele
  preferir o dinheiro, devolver ao saldo PRIMEIRO e só depois usar Reembolsar;
  devolver por fora antes paga o cliente duas vezes.
- **Cliente:** viu "Se o seu saldo baixou, fale com o balcão: o valor volta pro
  seu saldo" (`err.house_debit_missing`). Isso só acontece quando o lançamento
  foi recusado sem débito que o pagasse (0043, RH009) **e** o estorno automático
  falhou. O normal é o serviço estornar sozinho e dizer "seu saldo não foi
  debitado".
- **Cliente no balcão:** tem o comprovante ou a hora. Procure o débito pela
  carteira dele.

## Conferir antes de mexer (SQL, projeto do Racha)

```sql
-- o débito
select account_id, seq, payload
  from house_account_events
 where type = 'REDEEMED' and payload->>'txid' = '<txid>';

-- ele NÃO entrou em conta nenhuma?
select check_id, seq from check_events
 where type = 'PAYMENT_CONFIRMED' and payload->>'txid' = '<txid>';

-- já foi estornado?
select seq from house_account_events
 where type = 'REDEEM_REVERSED' and payload->>'txid' = '<txid>';
```

## Consertar

**Pelo botão (desde 2026-09-26, 0044).** Na página da carteira, a linha do
achado tem o botão "Devolver R$ X ao saldo". O servidor só aceita o débito que
a conciliação aponta **agora**, e só **5 minutos** depois do débito (pra não
atropelar um pagamento em voo). O estorno grava `reason: owner_recredit` e o
**autor** (o id do usuário que clicou). É o caminho normal.

**Pela mão (se o botão não servir).** Se há o débito, não há
`PAYMENT_CONFIRMED` e não há estorno, rode o estorno do próprio banco, com
motivo e autor:

```sql
select public.house_redeem_reverse('<account_id>', '<txid>',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'owner_recredit', '<quem rodou: id do usuário, ou um identificador de ops como "ops:01">');
```

- Se ele devolver **RH007**, o pagamento entrou na conta nesse meio-tempo. Então
  não há o que devolver; encerre o chamado.
- Se devolver **RH010**, não havia débito com esse txid. Confira o txid.
- O terceiro argumento é a data no MESMO formato ISO que o serviço grava;
  `now()::text` deixaria o `REDEEM_REVERSED` com outro formato no razão.
- O autor fica pra sempre num razão que só cresce: use um **identificador**, nunca
  o nome de uma pessoa (LGPD art. 6º III).
- **Nunca** edite `principal_cents` à mão. O estorno devolve o principal, o
  bônus de lote ainda válido ao lote dele, e o bônus de lote que já VENCEU como
  um lote novo com a validade da casa contada do estorno (0044) — o cliente não
  perde bônus por uma falha nossa. E deixa o `REDEEM_REVERSED` no razão
  (inegociável #6).

O achado irmão `house_redeem_missing_payment_row_paid` é outra coisa: ali a
conta **foi** paga, e o que falta é a linha em `payments`. Nesse caso preencha a
linha e **não** devolva o saldo (`docs/house-accounts/README.md`).

## Prazo e quem avisa

- **No mesmo dia do alerta**, e no máximo em 24 h. O saldo é pré-pago do
  cliente, e segurar valor debitado sem entrega é cobrança indevida.
- **A posição do produto sobre o CDC art. 42 § único** (que prevê devolução em
  DOBRO salvo "engano justificável"): uma falha automática, achada pela
  conciliação e desfeita inteira no mesmo dia, é engano justificável — o STJ
  (EAREsp 676.608) liga a dobra à conduta contrária à boa-fé objetiva. O que
  sustenta a posição é o prazo: tratar o "mesmo dia" como compromisso de
  serviço, não como meta.
- **Quem avisa o cliente:** o dono (a casa), pelo canal que o cliente usou, ou
  pelo `contato@useracha.app` se ele escreveu pra lá.
- **Quem conserta:** o dono, pelo botão. Se o botão recusar ("não está mais
  pendente" = o achado sumiu, recarregue; "ainda pode estar em andamento" = o
  débito tem menos de 5 min), **acione o suporte Racha em `contato@useracha.app`**
  no mesmo dia — o suporte usa o SQL acima. (A página da carteira mostra todos
  os achados; o painel resume nos 5 mais graves.)
- **Avisar o cliente:** depois de devolver, a página mostra "Avisar {nome} pelo
  WhatsApp", com a mensagem pronta. E a carteira do cliente mostra por 30 dias
  que o valor voltou.

## O que ainda falta no produto (TASKS)

- (Feito em 2026-09-26: o botão "devolver ao saldo", 0044.)
- Aviso AUTOMÁTICO (sem o dono tocar) exigiria WhatsApp Business com modelo
  aprovado pela Meta, ou SMS pago — hoje o dono avisa com um toque (PR #45).
