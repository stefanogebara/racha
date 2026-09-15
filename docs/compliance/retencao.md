# Retenção — quanto tempo cada dado fica, e o que apaga ele

Fecha a **lacuna 1** do `docs/compliance/data-map.md`: até 2026-09-12 nada
expirava e nada apagava. Um nome preso a um pagamento guardado pra sempre falha
o art. 6º I e III da LGPD (finalidade e necessidade) e, na Espanha, o art.
5(1)(e) do GDPR.

Escrito antes do aviso ao cliente de propósito. O aviso precisa dizer um prazo,
e prazo escrito sem job que o cumpra é promessa falsa — que é o erro que este
repositório passou cinco rodadas de revisão aprendendo a não cometer.

## A tabela

| Dado | Prazo | Por quê esse prazo | Quem apaga |
|---|---|---|---|
| `payments.payer_label` — o nome livre que a pessoa digita | **90 dias** depois de a conta fechar, e **180 dias** do pagamento de qualquer jeito | Serve pra dizer no painel e no comprovante quem pagou qual parte; depois que a conta fecha, o rótulo deixa de ter função operacional. **O registro de uma contestação não é este campo** — é o `txid`, o valor, e o cadastro do pagador que fica com o adquirente. (A primeira versão desta linha dizia que "o prazo de chargeback é bem menor que isso": errado. O MED do Pix é ~80 dias, mas as bandeiras trabalham com 120 dias ou mais a partir da transação. A disputa que chegar no dia 100 é resolvida com o `txid` e o registro do adquirente, não com o apelido que alguém digitou.) O teto de 180 dias existe porque fechar conta é ação humana: casa que abandona o piloto deixa contas abertas pra sempre. | `purge_expired_personal_data()`, diário |
| `payments.psp_payload_masked` | vive com o pagamento | Retrato forense do momento em que o dinheiro entrou — é o que se olha quando alguém contesta. O código parou de gravar dado de pagador em 2026-09-10, **mas apagar quem escreve não apaga o que já foi escrito**: as linhas anteriores ainda tinham `payer_hint` e `payer_doc_hint`, e herdavam a vida de 5 anos da linha. A 0031 os remove de toda linha, sem prazo — não deviam existir em momento nenhum. | `purge_expired_personal_data()`, uma vez e depois zero pra sempre |
| valores, `txid`, horários, `confirmed_at` | **5 anos contados do encerramento do exercício fiscal da transação** | Obrigação legal e regulatória (LGPD art. 16 II; CTN arts. 173/174 contam do exercício SEGUINTE, então "5 anos da transação" erra por até um ano) e defesa em processo (art. 16 III; o prazo do art. 27 do CDC corre do conhecimento do dano, não do pagamento). **Continua sendo dado pessoal.** A primeira versão desta linha dizia "não é dado pessoal depois que o nome sai" e isso é falso: o `txid` resolve pro cadastro do pagador no painel do adquirente, e a reidentificação por meios razoáveis é o critério do art. 12 §1 — a gente tem o login do painel. Depois do expurgo a linha é **pseudonimizada, não anônima**, e continua dentro de todas as proteções do mapa de dados. A retenção é lícita pelo art. 16, não por deixar de ser dado pessoal. | — |
| `house_accounts.phone` + `.name` | enquanto a carteira existir, **+ 90 dias** depois de zerada e inativa | É a identidade da carteira: sem telefone não há como a pessoa achar o saldo dela. Saldo zero e sem uso é carteira morta. | `purge_expired_personal_data()`, diário |
| `check_views.session_hash` | **90 dias** | Aleatório do navegador, sem dado pessoal — mas é o contador do portão de adoção e o portão olha 8 semanas. Guardar linha crua além disso é guardar por guardar. | `purge_expired_personal_data()`, diário |
| `charge_slots` — o livro de vagas do teto de cobranças (migração 0033) | cada linha carrega a própria janela — **15 minutos** nas de cobrança e recarga, 6 horas nas de aviso, um dia nos contadores de aviso — e o expurgo diário apaga a que passou dela: as de cobrança e recarga (onde está o id de conta) ficam **até cerca de 24 horas**; as de aviso (com o id de conta da mesa, pseudônimo) até cerca de 48 | Controle de abuso: impedir que um token de mesa fotografado emita cobranças sem limite. Guarda só chaves (`check:`/`account:`/`venue:`/`alerta:`/`alerta-dia:`), e os ids de conta de saldo e de conta da mesa são pseudônimos — por isso tem prazo, e curto. Ver o teste de balanceamento no `data-map.md`. | a própria reivindicação (a chave dela, e lotes de linhas com mais de um dia) e `purge_expired_personal_data()`, diário |
| `venues.*` (dono, contato, banco) | vida do contrato **+ 5 anos** | Contrato e obrigação fiscal. | manual, no encerramento |

## O que NÃO tem prazo aqui, e por quê

**Log da Vercel.** O `t` da mesa viaja na query string do `/api/check`, que é
consultado a cada 4 segundos, então ele está no log de acesso da plataforma —
uma capacidade ao portador num lugar onde a gente não controla o prazo. É a
lacuna 9 do mapa; o conserto é tirar o token da query string, não configurar
retenção de log.

**E é ele, não o `check_views`, o registro do Marco Civil.** O art. 15 obriga
provedor de aplicação PJ a guardar *registros de acesso a aplicações* por 6
meses, e o art. 5º VIII os define como data e hora de uso **a partir de um IP
determinado**. O `check_views` não tem IP nenhum (migração 0028) — é um
aleatório gerado no navegador — então apagá-lo em 90 dias não esbarra no art.
15. O registro que o art. 15 alcança é o log de acesso da plataforma. Dito aqui
pra ninguém ter que reconstruir esse argumento sob pressão de uma ordem
judicial.

**Painel do adquirente.** Nome completo e CPF do pagador existem lá, não aqui —
de propósito (é por isso que o `maskPixPayload` é lista de permissão). O prazo é
do Pagar.me, sob o contrato deles.

## Como roda

`purge_expired_personal_data()` é uma função SQL, chamada por
`/api/cron/retention` uma vez por dia. Ela **anonimiza** (`payer_label → null`)
em vez de apagar a linha: apagar o pagamento destruiria o razão, e o razão é
event-sourced e imutável por princípio. O que sai é o dado pessoal, não o fato
de que houve um pagamento.

A função devolve quantas linhas tocou em cada categoria, e o cron loga o
resultado. Zero por muitos dias seguidos é sinal de que ela parou de funcionar,
não de que não havia o que apagar — o mesmo raciocínio do canário vermelho que
nunca dispara.

## O registro de que rodou (art. 6º X, não art. 37)

O expurgo funcionava e a metade que DETECTA não existia. O único rastro de uma
execução era stderr e uma mensagem numa ponte que vira no-op silencioso sem
`RACHA_NOTIFY_SECRET` — e "a ausência da batida é o alarme" só vale se alguma
coisa alertar sobre a ausência. Nada alertava, e em regime a batida diz zero
todo dia, que é a mensagem mais fácil de parar de ler que existe.

`retention_runs` (migração 0032) é uma linha por execução: data, as quatro
contagens, e — no pedido de titular — o `txid` atendido. A gravação acontece
**dentro** da função, na mesma transação: registro que pode divergir do que
aconteceu não é registro.

Quem vigia é o cron da **conciliação**, que já roda todo dia e agora de fato
pagina — até 2026-09-12 não paginava, e essa frase era falsa em três
documentos. A ponte de avisos (`restaurant-ai-mcp/api/racha-notify.js`) roteava
só o radar de ativação e exigia um campo `status` que a Racha não manda em
evento de fundador nenhum, então **todo** alerta voltava 400 e virava linha de
stderr. A batida noturna, cujo contrato é "a ausência dela é o alarme", nunca
chegou uma vez — o contrato estava satisfeito de forma vazia. Corrigido nos dois
lados, com censo em cada um. Detalhe: se o
último expurgo tem mais de 48 horas, ou nunca houve nenhum, a linha entra no
alerta e força o envio. Dois dias de folga porque a purga é diária — um dia
perdido é um deploy demorado, dois é defeito. A checagem é embrulhada em
`try`: higiene não pode calar o alerta de dinheiro.

Uma correção de rótulo que importa: **isto NÃO é o art. 37.** O art. 37 pede o
registro das *operações de tratamento*, e esse registro é o
`docs/compliance/data-map.md`. Esta tabela é PROVA DE EXECUÇÃO — art. 6º X
(responsabilização e prestação de contas) — mais o registro de resposta do art.
18 §4. A distinção não é acadêmica: chamar a tabela de "o art. 37" faz alguém
concluir depois que a obrigação está cumprida por um log de execução enquanto a
ROPA de verdade envelhece sem ninguém olhar.

E é onde uma resposta do art. 18 §4 finalmente tem onde apontar: até aqui o
"comprovante" de uma exclusão a pedido era uma linha no terminal de quem
executou. O pedido de titular grava **mesmo quando não acha linha**, porque
"pediram e não havia" é a resposta que alguém contestaria depois.

**E o titular tem direito de saber disto se perguntar.** Executar uma exclusão
deixa uma linha em `retention_runs` com o `txid` e a contagem, por 5 anos, com
base no art. 7º II c/c art. 16 I — é justamente o comprovante que o art. 18 §4
lhe assegura. Não está no aviso da tela de propósito: o aviso já é longo e cada
cláusula a mais custa leitura das que carregam as promessas. Está aqui, que é
onde quem for responder ao pedido lê. No dia em que existir rota de
autoatendimento, a cláusula vai junto pra tela.

A própria tabela tem prazo de 5 anos — o mesmo do registro contábil, porque é
registro de conformidade e não dado operacional — e o prazo é **executado pela
própria purga**, não escrito num comentário. Num documento cuja tese inteira é
dito-versus-feito, essa distinção tinha que estar na frase.

## Pedido do titular (art. 18)

**O prazo de 90 dias é o PADRÃO, não a resposta a um titular.** Quem pede
exclusão tem direito a ela agora. `erase_payment_label(txid)` (migração 0031) é
o instrumento: apaga o nome de UM pagamento e devolve quantas linhas tocou, pra
quem executou poder registrar a resposta que o art. 18 §4 exige. Antes dele o
caminho era SQL ad-hoc contra produção com a service role — sem log, sem
revisão, a uma cláusula `WHERE` de distância de zerar a tabela inteira.

Ainda **não** existe rota de autoatendimento, e o caminho é: a pessoa fala com o
restaurante, o restaurante fala com a gente, a execução é manual com o
instrumento acima. Isso se sustenta num piloto assistido, mas só com as três
coisas juntas — e vale dizer qual delas é a que estava faltando:

1. **O aviso identifica o controlador e dá um contato.** É obrigação de
   controlador publicar encarregado (art. 41 §1), e controlador aqui é a casa. Um
   aviso sem nome e sem canal não é "canal assistido", é ausência de canal — era
   esse o defeito, não o processo manual.
2. **O contrato com a casa compromete um prazo de resposta** que permita a ela
   cumprir o art. 19. Isso é a lacuna 4 do mapa e continua aberta.
3. **Existe instrumento limitado pra executar** — o `erase_payment_label`.

E uma ressalva que não depende de piloto: pro `check_views` a **Racha é
controladora**, então pra essa fatia o contato tem que ser nosso desde o
primeiro dia, e o direito que acompanha legítimo interesse é o de **oposição**
(art. 18 §2), não só o de exclusão. Os dois estão no aviso.
