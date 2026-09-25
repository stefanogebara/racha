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

**Confirmação automática: PENDENTE, e o dono é quem configura.** No Gmail,
crie um filtro com `to:contato@useracha.app` e a ação "enviar modelo". O modelo
deve dizer "recebemos, respondemos em até 5 dias". Enquanto o filtro não
existir, confirme a mão no mesmo dia. Hoje ninguém mais cobre a caixa (não há
contato de reserva, `docs/domains.md`), então olhe-a todo dia útil.

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
- **Falta:** uma mensagem de remetente de fora, com DMARC estrito, vinda de um
  Gmail de terceiro e de um Outlook/Hotmail. Encaminhador pode mandar esse
  e-mail pro spam. Anote o resultado aqui e em `docs/domains.md`.
