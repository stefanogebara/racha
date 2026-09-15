# Devolver dinheiro que entrou a mais

**Quem lê isto:** quem opera o caixa de um restaurante que usa Racha, e quem
atende quando a conciliação diária aponta `overpaid_pending_restitution`.

## O que aconteceu

No Pix o cliente digita o valor no app do banco, e o banco aceita qualquer
número. Se ele digitou mais do que a conta pedia, o dinheiro está na conta do
restaurante e **a casa tem que devolver a diferença** — não é receita.
Código Civil art. 876: quem recebeu o que não lhe era devido é obrigado a
restituir, e a obrigação **não espera o cliente pedir**.

O painel mostra a linha `a devolver a clientes`, com o valor. O telefone de
quem estiver na mesa mostra "Esta conta recebeu R$ X a mais do que pedia".

## O que fazer

1. **Ache a cobrança.** Na lista de mesas do painel, a conta com dívida mostra
   `a devolver: R$ X` e, embaixo, a cobrança e o valor **daquela** cobrança:

   ```
   Mesa 7        R$ 200,00 / R$ 110,00   [paga]
                 a devolver: R$ 90,00
                 ch_abc123 · R$ 90,00
   ```

   O `ch_…` é o mesmo id que aparece no painel do adquirente. Numa conta
   rachada, só aparecem as cobranças que **realmente** receberam a mais — quem
   pagou a parte exata não entra na lista.
2. **Emita a devolução no adquirente**, pelo valor que aparece **ao lado da
   cobrança** (não pelo total do pagamento — devolver o pagamento inteiro
   reabre a conta e a mesa é cobrada de novo):
   - **Pix (Pagar.me):** painel → Cobranças → a cobrança → *Cancelar* pelo
     valor parcial. O evento que volta é `charge.refunded` (a Pagar.me não
     separa parcial de total no nível do evento — conferido na documentação de
     webhooks em 2026-09-08), e a Racha lê o `canceled_amount` da cobrança pra
     saber quanto voltou. A devolução Pix tem prazo: **até 90 dias** contados da
     transação original. Passado isso, o caminho é uma transferência comum, e
     ela não fecha a marca automaticamente.
   - **Cartão (Stripe):** Payments → o pagamento → *Refund* parcial.
3. **Prefira o trilho, mas se devolver por fora, REGISTRE.** A devolução pelo
   mesmo trilho fecha a marca sozinha: o webhook chega, o razão registra, a
   linha sai da conciliação.

   Quando não der (passou dos 90 dias, ou você devolveu em dinheiro na hora),
   registre a devolução — `POST /api/checks/record-restitution` com a conta, a
   cobrança, o valor e a **referência** (o comprovante do Pix, "dinheiro no
   caixa às 21h40", o que for). Sem esse registro a conta fica vermelha pra
   sempre e o telefone de quem sentar naquela mesa continua dizendo que a casa
   deve.

   **A referência não é burocracia.** Se o cliente abrir um MED depois de já
   ter recebido, é ela que prova o pagamento — e sem ela a casa pode ser
   debitada duas vezes pelo mesmo valor.
4. **Confira que fechou.** Na próxima leitura, `a devolver a clientes` volta a
   zero e o aviso sai da tela do cliente.

## Pagamento que chegou depois de a conta fechar

O Racha não registra o que o caixa recebe. Um Pix iniciado antes de o QR girar,
ou um cartão ainda em confirmação, pode confirmar DEPOIS de a equipe cobrar a
mesa no caixa e fechar a conta — e aí a mesa pagou duas vezes. O painel de
pagamentos (`/painel`, pelo link na lista de mesas do `/admin`) marca a linha
da mesa: `chegou depois de a conta fechar: R$ X`, com o id da cobrança, e a
conciliação levanta `paid_after_close`.

1. **Pergunte à mesa, ou confira o caixa.**
2. **Se a mesa TAMBÉM pagou no caixa: devolva pelo adquirente o valor da marca**
   (consumo + serviço), como no passo 2 acima. O webhook registra a devolução e
   a marca sai sozinha. **Não use "não pagou no caixa" pra registrar uma
   devolução**: o serviço ficaria na base da folha (Lei 13.419/2017) sem ter
   voltado, e nada no razão diria que o dinheiro voltou. Devolução em dinheiro
   no caixa não tem registro aqui — por isso o adquirente.
3. **Se a mesa NÃO pagou no caixa:** "não pagou no caixa" na linha da mesa. O
   pagamento era legítimo, e a pergunta fica respondida.
4. **Pagamento em DUPLICIDADE** (a conta já estava paga no Racha): a linha diz
   `serviço de um pagamento em duplicidade`. O consumo aparece como `a devolver`
   e o serviço também é a devolver — não há pergunta, e não há botão.
5. **Sem resposta, a pergunta não some**: depois de 48 horas ela vira
   `critical` na conciliação, como a dívida de restituição.

**No primeiro deploy com isto**: todo pagamento atrasado ANTIGO, sem resposta,
aparece como `critical` na primeira conciliação da noite. Avise as casas do
piloto antes, e responda os antigos pelo painel.

## Por onde o dinheiro sai

**Do consumo, nunca da gorjeta.** O excedente entra registrado como consumo, e
a devolução sai de lá. A gorjeta arrecadada é remuneração do time (Lei
13.419/2017 + STJ Tema 1102) e não é fundo de onde a casa tira dinheiro pra
restituir — nem por acidente de arredondamento. Ver `allocateRestitution` em
`api/_lib/checks/split-engine.js`.

## Antes de emitir: o saldo do recebedor

A devolução no adquirente **sai do saldo do restaurante**, não de um caixa da
Racha. Se o dinheiro já foi sacado e o saldo não cobre, a devolução falha (ou
fica pendente até o próximo repasse) — o adquirente não adianta valor. Confira
o saldo antes de emitir; se não cobrir, devolva por fora **e registre** como no
passo 3.

## Se ninguém devolver

A conciliação diária escala: `high` nas primeiras 48 horas, **`critical`**
depois — e um `critical` pinta o relatório da casa de vermelho e sai no alerta.
Uma dívida com o consumidor que não sobe de tom é uma dívida que fica
esquecida (CC art. 884, enriquecimento sem causa).

## Suspeita de fraude

Se o valor a mais parece parte de um golpe (pagamento alto seguido de pedido de
devolução em outra chave), **não devolva pela chave que o cliente indicar**:
devolva pela cobrança original, que volta pra conta de onde saiu. Golpe de
"pagamento a mais" existe justamente pra fazer a devolução sair pra outra
conta. Caso de fraude no Pix tem o MED (Mecanismo Especial de Devolução) do
BACEN, acionado pelo **banco do pagador** — não por nós, e não pelo
restaurante.

E se o MED chegar depois de você já ter devolvido: **responda com a
referência**, não devolva de novo. É exatamente pra isso que o registro do
passo 3 existe.
