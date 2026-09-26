# `contato@useracha.app` — como a caixa funciona e como se responde

Como a mensagem chega: quem escreve → MX do Forward Email (plano grátis, só
DNS; regra cifrada no TXT `forward-email=`) → Gmail pessoal do dono. Só
`contato@` encaminha; qualquer outro endereço do domínio leva bounce. O data-map
(seção 2) diz quem são esses dois provedores e o art. 33.

## Responder

**A resposta sai do Gmail pessoal do dono**, não de `contato@`. O plano grátis
só recebe, e a raiz tem `spf ... -all` e DMARC `p=quarantine; adkim=s`: o Gmail
não consegue enviar *como* `contato@useracha.app` sem cair em quarentena. Quem
recebe a resposta vê o endereço pessoal. Isso é aceito no piloto assistido. Antes
do self-serve, a caixa passa a ter um envio próprio: Workspace, uma caixa paga
com SMTP, ou o Resend (que já assina `d=useracha.app`).

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
