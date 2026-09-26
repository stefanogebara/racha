# Domínios — quem é dono, e até quando

Existe porque a lista de origens confiáveis do app iOS (`TableQR.allowedHosts`)
decide se o app desenha o JSON de alguém como CONTA e manda pra ele o token ao
portador da mesa. Por cinco rodadas de revisão, "este host é nosso" foi a única
afirmação desse tipo no repositório sem nada que a conferisse — e ela estava
errada.

**`racha.app` não é nosso.** Eu tinha escrito no código que ele "não resolve, não
está registrado". O `curl` estourava no CONNECT, não na resolução, e as duas
coisas parecem iguais num terminal. Os fatos, de 2026-09-11:

```
dig +short A  racha.app       → 13.222.106.247
dig +short NS racha.app       → ns07.domaincontrol.com. ns08.domaincontrol.com.   (GoDaddy)
dig +short CNAME www.racha.app → pointing.wixdns.net.                              (Wix)
```

Registrado, com DNS na GoDaddy e o `www` servido pelo Wix. A Racha roda na
Vercel. Enquanto `racha.app` e `www.racha.app` estiveram na lista, um app de
pagamento confiava em dois hosts de terceiro — e o padrão do "digitar o código"
apontava pra um deles.

## A lista

| Host | Dono | Onde serve | Vence | Confiado pelo app? |
|---|---|---|---|---|
| `useracha.app` | **nós** — comprado em 2026-09-25 pelo dono na Vercel (time `stefanogebaras-projects`); registrador de registro **Name.com, Inc.** (a Vercel revende), trava de transferência ligada, DNS na Vercel | produção; o que o QR imprime desde 2026-09-25 (`ORIGEM_DE_PRODUCAO`); remetente dos e-mails do auth (Resend, região sa-east-1) | **2027-09-24 22:51 UTC** (RDAP; renovação US$15/ano) — renovar é obrigação: cartão impresso aponta pra ele | **sim** |
| `racha-gray.vercel.app` | nós (projeto `racha` em `stefanogebaras-projects`) | produção (mesmo projeto); impresso nos cartões anteriores a 2026-09-25 | subdomínio da Vercel: não vence, mas o nome volta a ser reivindicável se o projeto for renomeado ou apagado | **sim** |
| `racha.app` | **terceiro** (GoDaddy + Wix) | não serve a Racha | — | não, e não pode voltar |

## A regra

1. **Todo host em `TableQR.allowedHosts` aparece nesta tabela como nosso.** Um
   teste amarra as duas coisas (`api/__tests__/data-map.test.js`); adicionar um
   host sem registrá-lo aqui quebra a suíte.
2. **Encolher a lista é MIGRAÇÃO, não edição.** Ela é metade de um par cuja outra
   metade está impressa em objetos físicos em cima de mesas, e adesivo não se
   chama de volta. A ordem é: migrar o `PROD_ORIGIN`, servir o host antigo com
   redirect enquanto houver folha apontando pra ele, girar as folhas
   (`POST /api/tables/rotate`), e só então tirar da lista.
3. **Enquanto o `racha-gray.vercel.app` estiver impresso em alguma mesa, o
   projeto na Vercel não se renomeia e não se apaga.** É o que mantém o nome
   fora do alcance de quem chegar depois.

## E-mail

O aviso de privacidade oferece um canal direto ao cliente, então o domínio de
e-mail é a mesma classe de afirmação que a lista de origens — e errou do mesmo
jeito. A primeira versão publicou `privacidade@racha.com.br` escrito no código.

```
dig +short NS racha.com.br  → a.auto.dns.br. b.auto.dns.br.   (registro.br, DNS padrão)
dig +short MX racha.com.br  → 0 .                              (MX NULO, RFC 7505)
```

`MX 0 .` é o domínio declarando que **não recebe e-mail**. Quem escrevesse
levava bounce — e o canal que o `retencao.md` tinha acabado de chamar de "a
condição que faltava" faltava de novo.

Desde 2026-09-26 o endereço é o `contato@` da tabela abaixo, em `apps/web/src/empresa.ts`
(a variável `VITE_PRIVACY_CONTACT` saiu: um lugar só). Publicar caixa que não existe é pior do que mandar a pessoa
ao restaurante, que é o controlador do dado do pagamento e uma rota de verdade.

Um endereço só pode aparecer numa tela depois que a linha dele aqui disser
**entrega confirmada** — e há teste (`api/__tests__/data-map.test.js`) que
recusa qualquer `@` escrito no código do cliente sem essa marca. Estar CITADO
neste arquivo não basta: o endereço abaixo está citado justamente como o que
não pode voltar.

| Endereço | Entrega? | Onde aparece |
|---|---|---|
| `contato@useracha.app` | **entrega confirmada** 2026-09-26 — e-mail real da Racha (Resend → Forward Email → Gmail do dono) chegou na CAIXA DE ENTRADA, não no spam; e de remetente DE FORA (Microsoft 365, DMARC/ARC pass), com a resposta automática entregue de volta — ver `docs/runbooks/contato.md` | rodapé da landing (Decreto 7.962 art. 2º II, com o endereço físico ao lado desde 2026-09-26) e aviso de privacidade (`priv.rights`) |
| `privacidade@racha.com.br` | **NÃO** — `MX 0 .`, o domínio recusa e-mail | em lugar nenhum, e não pode voltar |

**Antes de publicar um endereço novo:** mandar uma mensagem de teste e
confirmar que chegou numa caixa que alguém lê. Um endereço no aviso é um
compromisso com um consumidor, não uma configuração.

## Migração do `racha-gray.vercel.app` (em curso desde 2026-09-25)

Feito: `useracha.app` comprado e ligado ao projeto; `ORIGEM_DE_PRODUCAO`, o
padrão do `CLIENT_URL` e a origem padrão do iOS apontam pra ele; o iOS aceita
os dois hosts. Falta, nesta ordem: (1) girar as folhas impressas com o host
antigo (`POST /api/tables/rotate`) — hoje não há casa real com mesa impressa,
só teste; (2) redirect do `racha-gray` pro `useracha.app`; (3) só então tirar o
`racha-gray` do `allowedHosts`. O webhook do Pagar.me ainda está cadastrado no
host antigo (`docs/runbooks/pagarme-webhook-auth.md`) — trocar lá antes do (2).

## `useracha.app` — renovação e DNS

**Renovar é obrigação, não conveniência.** Se o domínio vencer, quem o
registrar depois recebe o tráfego dos QR de pagamento em cima das mesas e pode
servir uma página de Pix falsa com o nome da Racha (CDC art. 14). Antes do
primeiro cartão impresso numa casa de verdade:

| Controle | Estado |
|---|---|
| Auto-renovação na Vercel | **ligada** — conferida em 2026-09-25 pela API (`GET /v5/domains/useracha.app` → `renew: true`) |
| Cartão válido na conta da Vercel | **ok** — conferido em 2026-09-25 no painel: padrão MasterCard débito final 1245, válido até 09/2032 (há um Visa pré-pago final 3365 VENCIDO em 03/2026, não padrão — remover) |
| 2FA na conta da Vercel | **DESLIGADO** — conferido em 2026-09-25 ("Two-Factor Authentication: Inactive"); o dono decidiu adiar. Conta como NÃO feito até estar registrado aqui com data. **PORTÃO DURO antes do 1º cartão numa casa real**, como a auto-renovação e o cartão: quem toma a conta aponta o `useracha.app` (impresso nos QR) pra uma página de Pix falsa (compliance, PR #31, M-4; CDC art. 14) |
| Responsável | o fundador (Stefano Gebara); sem contato de reserva ainda |
| Vigia diário | **existe**: `api/_lib/checks/dominio-watch.js`, na conciliação das 04:10, DEPOIS do aviso de dinheiro. Pagina (e-mail + WhatsApp, `account_alert`) com < 60 dias pro vencimento, estado ruim no registro, trava de transferência ausente, nameservers que não são os da Vercel, ou leitura do RDAP que falhou. **Desde 2026-09-26 também a caixa `contato@`**: MX da raiz diferente de `mx1`/`mx2.forwardemail.net`, o TXT `forward-email=` sumido, ou leitura do DNS que falhou (segurança, PR #39, M1) |

Registrar por vários anos de uma vez baixa o risco e custa pouco.

DNS (2026-09-25): e-mail do Resend em `send.` (SPF, MX) + DKIM na raiz;
**DMARC `p=quarantine; adkim=s; aspf=r`** (o e-mail do Resend sai assinado
`d=useracha.app` — conferido no Gmail, "signed-by: useracha.app"). Raiz desde
2026-09-26: **MX `mx1`/`mx2.forwardemail.net`** (prioridade 10) e
`v=spf1 include:spf.forwardemail.net -all` — o plano grátis do Forward Email,
só DNS, sem conta nem cobrança. A regra de encaminhamento é o TXT
`forward-email=…` CIFRADO pela API deles (`POST /v1/encrypt`): o Gmail do dono
não fica legível no DNS público. Só `contato@` encaminha — sem curinga, então
endereço inventado leva bounce em vez de spam. (O ImprovMX foi tentado antes:
o plano grátis já está usado pelo `twinme.me`. A Vercel recusa MX novo enquanto
o MX nulo existe — tirar o nulo PRIMEIRO; a raiz ficou ~1 min sem MX, sem efeito,
porque o nulo já recusava tudo.) Falta `rua=`
no DMARC — relatório externo pro Gmail não funciona sem autorização do lado
de lá; precisa de uma caixa no próprio domínio ou de um serviço de relatório.

- O `*` (curinga) é registro PADRÃO da Vercel, sem id no CLI: todo subdomínio
  resolve pra Vercel, mas nenhum outro time consegue anexar um sem verificação.
- `www.useracha.app` resolve e redireciona, mas o certificado não cobre `www`
  (erro duro no navegador, por causa do HSTS do `.app`). Nada imprime nem linka
  `www`, e ele não está no `allowedHosts`. Ou completar (adicionar `www` ao
  projeto como redirect) ou deixar como está — não usar.

**Quando a migração chegar no redirect do `racha-gray`:** redirecionar só o que
NÃO é `/api/` (ou usar 308), e mover ANTES os webhooks (Pagar.me, Stripe) e os
apps iOS antigos — PSP não segue redirect de webhook, e 301/302 vira POST em GET.
