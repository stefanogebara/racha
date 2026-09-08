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

1. **Ache a cobrança.** O painel do restaurante traz, na conta marcada, o
   `txid` da cobrança com saldo devolvível (campo `overpaidTxids`). É o mesmo
   id que aparece no painel do adquirente.
2. **Emita a devolução no adquirente**, pelo valor que o painel indica:
   - **Pix (Pagar.me):** painel → Cobranças → a cobrança → *Cancelar* pelo
     valor parcial. A devolução Pix tem prazo: **até 90 dias** contados da
     transação original. Passado isso, o caminho é uma transferência comum, e
     ela não fecha a marca automaticamente.
   - **Cartão (Stripe):** Payments → o pagamento → *Refund* parcial.
3. **Não devolva por fora do trilho** (Pix pessoal, dinheiro do caixa) se der
   pra usar o adquirente. A devolução pelo mesmo trilho é o que faz a marca
   fechar sozinha: o webhook chega, o razão registra, e a linha sai da
   conciliação. Uma devolução por fora deixa a conta vermelha até alguém
   registrar manualmente.
4. **Confira que fechou.** Na próxima leitura, `a devolver a clientes` volta a
   zero e o aviso sai da tela do cliente.

## Por onde o dinheiro sai

**Do consumo, nunca da gorjeta.** O excedente entra registrado como consumo, e
a devolução sai de lá. A gorjeta arrecadada é remuneração do time (Lei
13.419/2017 + STJ Tema 1102) e não é fundo de onde a casa tira dinheiro pra
restituir — nem por acidente de arredondamento. Ver `allocateRestitution` em
`api/_lib/checks/split-engine.js`.

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
BACEN, acionado pelo banco do pagador — não por nós.
