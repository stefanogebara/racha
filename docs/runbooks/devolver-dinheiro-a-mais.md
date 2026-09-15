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
   a marca diminui no valor devolvido (se a cobrança também mostra `a devolver`, o estorno sai PRIMEIRO dessa sobra — confira as duas linhas). **Não use "não pagou no caixa" pra registrar uma
   devolução**: o serviço ficaria na base da folha (Lei 13.419/2017) sem ter
   voltado, e nada no razão diria que o dinheiro voltou.

   Enquanto o estorno pelo adquirente for possível, é por ele que se devolve, e
   a rota de registro por fora **recusa** (`use_acquirer_refund`). Ela existe só
   pro caso do passo 6, e o motivo é que o adquirente é a testemunha: sem ele, a
   única prova de que o dinheiro voltou seria a palavra de quem opera o caixa —
   sobre um valor que sai da base da folha do time.
3. **Se a mesa NÃO pagou no caixa:** "não pagou no caixa" na linha da mesa. O
   pagamento era legítimo, e a pergunta fica respondida.
4. **Pagamento em DUPLICIDADE** (a conta já estava paga no Racha): a linha diz
   `serviço de um pagamento em duplicidade`. O consumo aparece como `a devolver`
   e o serviço também é a devolver — não há pergunta, e não há botão.
5. **Sem resposta, a pergunta não some**: depois de 48 horas ela vira
   `critical` na conciliação, como a dívida de restituição.

6. **Se o estorno pelo adquirente NÃO for possível** — ele falhou e voltou
   (a conta mostra `estorno FALHOU`), ou o **prazo do trilho acabou**: Pix, 90
   dias da transação (Res. BCB nº 1/2020 c/c nº 103/2021); cartão, 180 dias, que
   é o limite do adquirente. Aí devolva por fora (transferência, dinheiro no
   caixa) e **registre**, com `POST /api/checks/record-restitution` (a conta, a
   cobrança, o valor e a referência). Só nesses casos o teto dessa rota inclui a
   marca do pago-depois-de-fechar; fora deles ela responde `use_acquirer_refund`
   e o caminho é o passo 2.

   **O registro fecha a marca do pago-depois-de-fechar, não a do estorno que
   falhou.** São duas coisas: o `estorno FALHOU` continua na conta até alguém
   resolver aquela pendência (`POST /api/checks/resolve-issue` sem escopo, com a
   nota de quem resolveu) — é ela que diz ao cliente que ele tem a receber. Feche
   as duas, ou a conta segue vermelha com a dívida já paga.

   A ORDEM não importa mais: o razão guarda que o estorno daquela cobrança
   falhou, e resolver a pendência não apaga esse fato. (Até a revisão de
   ec86b37, apagava — e resolver primeiro, que é o natural porque é a marca que
   o cliente vê, trancava a devolução pra sempre.)

   **Na referência, nada do cliente**: nem nome, nem CPF, nem chave Pix — o id
   E2E do Pix, ou "dinheiro no caixa às 21h40". Ela fica num razão que não se
   apaga.

   **A referência também é a chave contra a repetição.** Registrar o MESMO
   comprovante duas vezes na mesma cobrança não cria um segundo lançamento: a
   segunda chamada responde a mesma coisa que a primeira. Então, se a chamada
   der timeout, REPITA com a mesma referência — é seguro. O que não se pode é
   repetir com uma referência nova pra "garantir": aí são duas devoluções.

   E se a conta tiver mudado enquanto você registrava (outro estorno caiu, um
   pagamento atrasado chegou), a resposta é `restitution_conflict` e **nada foi
   gravado** — recarregue a conta e confira o valor de novo, porque o teto pode
   ter mudado junto.

   **As respostas que esta rota dá**, porque ela é chamada por `curl` e não tem
   tela que traduza:

   | resposta | o que aconteceu | o que fazer |
   |---|---|---|
   | `200 {duplicate: true, recorded: {...}}` | esta referência já estava registrada | nada — confira em `recorded` se o valor é o que você quis |
   | `409 restitution_conflict` | a conta mudou no meio; **nada foi gravado** | recarregue, confira o teto, registre de novo |
   | `400 use_acquirer_refund` | o trilho do adquirente ainda está aberto | devolva por lá (passo 2) |
   | `400 nothing_to_restitute` | esta cobrança não deve nada de volta | confira se é a cobrança certa |
   | `400 amount_over` | acima do teto; `vars.leftCents` diz o máximo | registre só o que é devido |
   | `400 reference_required` | faltou a referência (mínimo 3 caracteres) | ponha o comprovante |
   | `503 payment_age_unknown` | não deu pra saber a idade da cobrança (ou é um trilho sem prazo cadastrado) | tente de novo; se insistir, fale com o time |
   | `500 restitution_unavailable` | o banco não respondeu — **pode ter gravado** | **confira a conta antes de repetir** |

**No primeiro deploy com isto**: todo pagamento atrasado ANTIGO, sem resposta,
aparece como `critical` na primeira conciliação da noite. Avise as casas do
piloto antes, e responda os antigos pelo painel.

## Por onde o dinheiro sai

**O excedente sai do consumo, nunca da gorjeta.** Ele entra registrado como
consumo, e a devolução sai de lá. A gorjeta arrecadada é remuneração do time
(Lei 13.419/2017 + STJ Tema 1102) e não é fundo de onde a casa tira dinheiro
pra restituir — nem por acidente de arredondamento.

**A exceção é o serviço de um pagamento que duplicou a conta**, e ela é a mesma
lei pelo outro lado: 10% sobre uma cobrança que não correspondeu a atendimento
nenhum nunca foi serviço prestado — é do cliente, e volta inteiro da gorjeta.
Devolver R$ 110 de uma duplicação de R$ 100 + R$ 10 deixa a base da folha menor
em exatamente R$ 10, não numa fatia proporcional.

**E num pagamento que chegou depois de fechar e ainda não foi respondido, o
consumo volta ANTES da gorjeta.** Devolver só o principal (R$ 100 de um Pix de
R$ 100 + R$ 10) devolve R$ 100 de consumo e zero de serviço — a marca fica
valendo os R$ 10 que ainda não voltaram, visível no painel. Pelo proporcional,
voltavam R$ 90,91 de consumo e R$ 9,09 de serviço: sobrava consumo pago, a marca
não fechava, e ficavam R$ 0,91 de serviço na folha sobre um atendimento que
talvez nunca tenha existido. Ver `api/_lib/checks/refund-allocation.js`.

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
