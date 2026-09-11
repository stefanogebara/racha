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
| `racha-gray.vercel.app` | nós (projeto `racha` em `stefanogebaras-projects`) | produção, e é o que o `Qrs.tsx` imprime no QR | subdomínio da Vercel: não vence, mas o nome volta a ser reivindicável se o projeto for renomeado ou apagado | **sim** |
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

## Pendente

Comprar um domínio nosso pra ser o `PROD_ORIGIN` — o app, o QR e o `CLIENT_URL`
apontam hoje pra um subdomínio de plataforma. Antes de qualquer build iOS sair
desta máquina.
