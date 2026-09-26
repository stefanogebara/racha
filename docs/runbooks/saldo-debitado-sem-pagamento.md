# Saldo debitado sem pagamento na conta

O cliente pagou com o saldo da casa, o saldo baixou, e a conta não recebeu o
pagamento. O caso vizinho, o adquirente que cobrou sem linha de pagamento
nossa, é outro: ver `dinheiro-sem-conta.md`.

## Como aparece

- **Conciliação da casa:** achado crítico `house_redeem_missing_payment_row`,
  com o valor e o cliente. Aparece na **página da carteira** (`AdminHouse`,
  desde 2026-09-26), no painel (`/api/panel`) e no stderr do
  `/api/house/admin`. A frase manda o dono acionar o suporte, avisar o cliente e
  **não devolver por fora** (senão o cliente recebe duas vezes quando o suporte
  estornar).
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
  'owner_recredit', '<quem rodou: id do usuário ou "ops:nome">');
```

- Se ele devolver **RH007**, o pagamento entrou na conta nesse meio-tempo. Então
  não há o que devolver; encerre o chamado.
- Se devolver **RH010**, não havia débito com esse txid. Confira o txid.
- O terceiro argumento é a data no MESMO formato ISO que o serviço grava;
  `now()::text` deixaria o `REDEEM_REVERSED` com outro formato no razão.
- **Nunca** edite `principal_cents` à mão. O estorno devolve o principal e cada
  lote de bônus exatamente, e deixa o `REDEEM_REVERSED` no razão (inegociável
  #6).

O achado irmão `house_redeem_missing_payment_row_paid` é outra coisa: ali a
conta **foi** paga, e o que falta é a linha em `payments`. Nesse caso preencha a
linha e **não** devolva o saldo (`docs/house-accounts/README.md`).

## Prazo e quem avisa

- **No mesmo dia do alerta**, e no máximo em 24 h. O saldo é pré-pago do
  cliente, e segurar valor debitado sem entrega é cobrança indevida (CDC art. 42
  § único).
- **Quem avisa o cliente:** o dono (a casa), pelo canal que o cliente usou, ou
  pelo `contato@useracha.app` se ele escreveu pra lá.
- **O balcão não conserta sozinho:** o estorno é SQL, na mão de quem opera o
  Racha. A casa que recebe o cliente, ou que vê o achado no painel, **aciona o
  suporte Racha em `contato@useracha.app`** no mesmo dia. Sem isso, o prazo
  acima é uma promessa que ninguém ouve (compliance, PR #42, re-revisão M-B).

## O que ainda falta no produto (TASKS)

- (Feito em 2026-09-26: o botão "devolver ao saldo", 0044.)
