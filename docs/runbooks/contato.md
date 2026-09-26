# `contato@useracha.app` — como a caixa funciona e como se responde

Como a mensagem chega: quem escreve → MX do Forward Email (plano grátis, só
DNS; regra cifrada no TXT `forward-email=`) → Gmail pessoal do dono. Só
`contato@` encaminha; qualquer outro endereço do domínio leva bounce. O data-map
(seção 2) diz quem são esses dois provedores e o art. 33.

## Responder

**Desde 2026-09-26 a resposta sai COMO `contato@useracha.app`.** No Gmail do
dono, em "Enviar e-mail como", o `contato@` usa o SMTP do Resend
(`smtp.resend.com:465`, SSL, usuário `resend`). A senha é a chave
`gmail-enviar-como-contato` do Resend, que só envia (Sending access). O Resend
já assina `d=useracha.app`, então a resposta passa no DMARC `adkim=s`. O Gmail
está configurado pra "responder do mesmo endereço pra onde a mensagem foi", e
por isso responder a quem escreveu pro `contato@` já sai do `contato@`.
Testado: um envio pra uma conta Microsoft 365 aparece como **Delivered** no log
do Resend.

- **A resposta automática AINDA sai do Gmail pessoal**
  (`stefanogebara+canned.response@gmail.com`): o modelo de filtro do Gmail não
  usa o endereço alternativo. A resposta de verdade, escrita à mão, já não expõe
  o Gmail.
- Os envios contam na cota do Resend, que é a mesma do login da Racha (100 por
  dia no plano grátis). Pra uma caixa de contato, sobra.
- Pra desfazer: em Configurações → Contas → Enviar e-mail como, clique em
  **excluir**. Se a chave for revogada, só o envio como `contato@` para; o resto
  do Gmail não é afetado.
- Nome exibido hoje: "Stefano Gebara". Pra trocar por "Racha", use "editar
  informações" ali mesmo.

## Prazos (contados do dia em que a mensagem chega)

| O quê | Prazo | Base |
|---|---|---|
| Confirmar que recebeu, pelo mesmo canal | **imediato** | Decreto 7.962/2013 art. 4º V e VI |
| Responder a demanda de consumidor | **5 dias** | Decreto 7.962 art. 4º § único |
| Declaração completa de um pedido de titular | **15 dias** | LGPD art. 19 II |

**Confirmação automática: LIGADA desde 2026-09-26.** No Gmail do dono há um
filtro `to:(contato@useracha.app)` que faz duas coisas: nunca manda pro spam, e
envia o modelo "Racha contato — confirmação automática". O modelo é bilíngue
(pt + en), promete resposta em até 5 dias (corridos, não úteis: o decreto não
diz úteis) e pede o comprovante, ou a casa, a mesa e o horário. Ele sai do
Gmail pessoal (ver acima). Se o filtro sumir, confirme à mão no mesmo dia. Hoje
ninguém mais cobre a caixa (não há contato de reserva, `docs/domains.md`), então
olhe-a todo dia.

## Ligar um pedido a um dado

O e-mail de quem escreve **não identifica nada** que a Racha guarda: o cliente
não tem cadastro. Peça uma destas coisas:

- o comprovante, ou o `txid`;
- a casa, a mesa e o horário.

Com isso, para apagar o rótulo de um pagamento, rode `erase-payment-label.js`
(o art. 18 manual; lacuna 1 do data-map). Quando o dado é da casa (a casa é a
controladora do pagamento), avise a casa e resolva junto.

## Guardar

A prova da resposta (quem pediu, o quê, quando, o que foi feito) fica 5 anos. A
mensagem original sai da caixa quando o pedido é resolvido. Ver `retencao.md`.

## Entrega: o que já foi testado e o que falta

- **Testado em 2026-09-26:** um e-mail da própria Racha (Resend, DKIM alinhado)
  chegou na caixa de entrada do Gmail.
- **Testado em 2026-09-26, remetente de fora:** uma conta Microsoft 365
  (`student.ie.edu`) escreveu pro `contato@`. Chegou na CAIXA DE ENTRADA,
  marcada como importante. SPF, DKIM e DMARC passaram, e o ARC também: o Forward
  Email reassina com `d=forwardemail.net` e preserva o resultado original. A
  resposta automática saiu 9 s depois e CHEGOU ao remetente, confirmado pelo
  dono. O caminho dela: o Gmail responde ao Return-Path, que é o endereço SRS
  `SRS0=…@forwardemail.net`, e o Forward Email o desfaz e entrega. Ela sai como
  `stefanogebara+canned.response@gmail.com`, então expõe o Gmail pessoal (ver
  "Responder").
- **Não dá pra testar do próprio Gmail do dono:** a cópia que volta é mesclada
  com a enviada (ganha o rótulo INBOX), e o filtro não roda sobre ela.
