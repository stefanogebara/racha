# A frase sobre um guarda nasce do guarda que se está olhando

**2026-09-10.** Registro de um padrão, não de um achado. Vive aqui e não no
`docs/compliance/data-map.md` porque um registro do art. 37 diz o que é verdade
sobre um tratamento; como a equipe erra é assunto de decisão de engenharia.

## O que aconteceu

Quatro rodadas dos dois portões obrigatórios sobre o mesmo alcance. Três vezes
seguidas o achado mais grave foi contra uma frase que a gente tinha acabado de
escrever, não contra código antigo:

1. **Rodada 1.** O mapa de dados afirmava que o `maskPixPayload` derrubava todo
   objeto aninhado. Derrubava — no laço de tipos. Logo abaixo havia um ramo que
   descia em `raw.pagador` e guardava o primeiro nome e dois dígitos do CPF. A
   frase descrevia a parte do arquivo que eu estava lendo quando a escrevi.
2. **Rodada 2.** O mesmo mapa citava `apps/web/test/bundle.test.ts` como garantia
   de que a Stripe não carrega em conta sem cartão. O teste PULAVA sem build. E
   no mesmo commit em que a gente pôs `<meta name="referrer" content="strict-origin">`
   com um comentário afirmando que o token da mesa não sai daqui, o
   `confirmParams.return_url` entregava esse token à Stripe como parâmetro.
3. **Rodada 3.** A correção do scanner iOS ganhou lista de permissão de origem, e
   a frase dizia "agora há lista de permissão e https obrigatório". O guarda
   tinha entrado num dos dois ramos do `TableQR.parse`.

E uma quarta, de outra natureza e mesma raiz: pra fechar um achado de compliance
sobre `*.vercel.app` num cliente de pagamento, a lista de release perdeu
`racha-gray.vercel.app` — que é o host que o `Qrs.tsx` IMPRIME no QR e o único
que responde. Um build publicado recusaria toda mesa de verdade. Falhava
fechado, então não era buraco: era o produto quebrado.

**E a própria correção trouxe o quinto caso, do mesmo feitio.** Pra justificar a
escolha eu escrevi no código que `racha.app` "não resolve — não está
registrado". O `curl` estourava no CONNECT, não na resolução, e as duas coisas
são idênticas num terminal e muito diferentes como fato. `dig` diz: A para
13.222.106.247, nameservers da GoDaddy, `www` num CNAME pro Wix. É de terceiro —
e esteve na lista de origens confiáveis de um app de pagamento, com o padrão do
"digitar o código" apontando pra ele. A observação era "o curl não completa"; a
frase afirmou "não está registrado"; a decisão de confiança foi tomada sobre a
frase. Fechado em `docs/domains.md`, que é a tabela que faltava, com teste.

## Por que isso não é desatenção

Em todos os casos o código estava certo no ponto que estava sendo olhado. O que
falhou foi a GENERALIZAÇÃO: quem acabou de consertar um caminho descreve a
propriedade como se ela valesse para todos, porque a evidência que tem na cabeça
é o caminho que consertou. Revisor nenhum lê a frase e o código com o mesmo peso
— a frase é mais fácil de acreditar, e é ela que faz o próximo revisor parar de
olhar. Por isso garantia escrita e falsa é PIOR que vazamento não documentado.

## O que fica valendo

**Toda afirmação de garantia num documento tem um teste, ou não é escrita.** A
frase e o código falham juntos, ou a frase não vale. Foi o que estas rodadas
produziram, um por afirmação:

| Afirmação | Teste |
|---|---|
| o webhook guarda N campos escalares | `api/__tests__/data-map.test.js` conta o `KEEP` do `mask.js` |
| terceiro só carrega com bandeira por casa | `apps/web/test/bundle.test.ts`, atravessando cliente e servidor |
| a volta do PSP não leva o token da mesa | lista de permissão de UMA forma pro `urlDeVolta` |
| um só decodificador de erro HTTP | censo dos arquivos que podem chamar `fetch` |
| o scanner só aceita origem conhecida | `RachaTests/TableQRTests`, com `defaultOrigin` hostil |
| o host que a gente imprime o app aceita | `data-map.test.js` lê `Qrs.tsx` e o `TableQR.swift` |

E dois hábitos que saíram daqui:

- **Lista de permissão, não de negação.** Cada censo que falhou nestas rodadas
  falhou por procurar a forma errada de fazer a coisa errada. `KEEP`, o casamento
  exato do `urlDeVolta`, a lista de arquivos que podem falar HTTP: todos dizem o
  que É permitido. A lista de palavras em português do censo de idioma é a
  exceção que confirma — ela é o único censo que continua achando coisa nova a
  cada lote, porque é a única que ainda é lista de negação.
- **Quando os dois portões discordam, quem decide é o que o produto FAZ.** O
  compliance estava certo sobre o risco do `*.vercel.app`; o remédio estava
  errado porque adesivo colado em mesa não se chama de volta. A ordem certa é
  migrar o domínio, servir o antigo com redirect, girar as folhas impressas e só
  então encurtar a lista.
