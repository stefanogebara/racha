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
| `payments.payer_label` — o nome livre que a pessoa digita | **90 dias** depois de a conta fechar | Serve pra dizer no painel e no comprovante quem pagou qual parte. Depois que a conta fecha, a única função que sobra é contestação, e o prazo de chargeback dos adquirentes é bem menor que isso. O VALOR fica; o NOME sai. | `purge_expired_personal_data()`, diário |
| `payments.psp_payload_masked` | vive com o pagamento | Retrato forense do momento em que o dinheiro entrou — é o que se olha quando alguém contesta. Já não tem dado de pagador desde 2026-09-10. | — |
| valores, `txid`, horários, `confirmed_at` | **5 anos** | Registro contábil e fiscal, e o prazo do art. 27 do CDC pra reparação. Não é dado pessoal depois que o nome sai. | — |
| `house_accounts.phone` + `.name` | enquanto a carteira existir, **+ 90 dias** depois de zerada e inativa | É a identidade da carteira: sem telefone não há como a pessoa achar o saldo dela. Saldo zero e sem uso é carteira morta. | `purge_expired_personal_data()`, diário |
| `check_views.session_hash` | **90 dias** | Aleatório do navegador, sem dado pessoal — mas é o contador do portão de adoção e o portão olha 8 semanas. Guardar linha crua além disso é guardar por guardar. | `purge_expired_personal_data()`, diário |
| `venues.*` (dono, contato, banco) | vida do contrato **+ 5 anos** | Contrato e obrigação fiscal. | manual, no encerramento |

## O que NÃO tem prazo aqui, e por quê

**Log da Vercel.** O `t` da mesa viaja na query string do `/api/check`, que é
consultado a cada 4 segundos, então ele está no log de acesso da plataforma —
uma capacidade ao portador num lugar onde a gente não controla o prazo. É a
lacuna 9 do mapa; o conserto é tirar o token da query string, não configurar
retenção de log.

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

## Pedido do titular (art. 18)

Ainda **não** existe rota de autoatendimento. Hoje o caminho é: a pessoa fala
com o restaurante (controlador), o restaurante fala com a gente, e a exclusão é
manual. Isso é aceitável num piloto assistido com poucas casas e deixa de ser no
dia em que o produto for self-serve — está registrado como o que falta na
lacuna 1 do mapa.
