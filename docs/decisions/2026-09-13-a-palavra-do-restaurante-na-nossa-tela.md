# A palavra do restaurante na nossa tela

**2026-09-13.** Uma lacuna aceita com gatilho escrito, não um achado fechado.
Vive aqui porque é uma decisão de produto sobre uma tensão entre duas regras
que o `CLAUDE.md` já traz, e nenhuma delas cede sozinha.

## A tensão

O acordo de trabalho diz: **"Conteúdo de casa nunca é traduzido. Rótulos de
mesa ('Mesa 7') e linhas de cardápio ('Picanha na chapa') são as palavras do
restaurante. A moldura traduz; a placa do restaurante não."** É a regra certa
— reescrever o cardápio de alguém é apagar o produto dele.

O inegociável #2 diz que nenhuma superfície nossa afirma que o serviço vai
inteiro, ou direto, pra quem serve a mesa. O censo do
`docs/compliance/claims.json` faz isso valer em toda superfície que existe em
artefato: TSX, Swift, o protótipo publicado e as fontes dele. O
`RevisaoDeAfirmacoes.swift` faz valer no texto que o assistente gera em
runtime, que não existe em artefato nenhum.

**Sobra um terceiro tipo de texto: o que a CASA escreve e a gente publica.** Um
extra chamado `"Gorjeta — vai pra equipe"`, vindo do POS ou lido da foto da
nota, sai renderizado por `esc(e.label)` no `racha-ios.html:2383` — ao lado,
literalmente, do nosso aviso de que quem distribui é o restaurante. Censo de
build não pode vê-lo: ele não está em arquivo nenhum até o serviço rodar.
Apontado pela revisão de compliance de 2026-09-13.

## Qual é o tamanho disto hoje

Menor do que parece, e vale dizer em vez de deixar a frase assustando sozinha:

- **Na plataforma web, não existe.** Não há campo em que o dono digite rótulo
  de extra. O adaptador `manual` — o único de v0 — recebe um TOTAL, não linhas.
  Conferido varrendo `apps/web/src` e `api/_app/router.js`.
- **No app iOS, já flui**, mas só local: os rótulos vêm da foto da nota, pelo
  `registrar_itens_da_nota`, e não passam por servidor nosso nem por cliente
  de terceiro. O texto é a nota impressa da casa, relida.

## O gatilho

**O dia em que um adaptador de POS importar RÓTULOS de linha** — o `colibri` é
o alvo de v0 e tem leitura de comanda documentada. Aí a palavra da casa passa a
chegar por integração, em volume, sem ninguém ler cada uma, e a nossa tela
passa a publicá-la a um consumidor.

## O que a gente vai fazer, e o que não vai

**Não vamos reescrever o texto da casa.** Não é nosso, e a regra de cima existe
por um bom motivo. Aplicar o `RevisaoDeAfirmacoes` a um rótulo de POS seria
editar a comanda do restaurante — e um cliente que compara a nossa tela com o
papel na mão encontra duas versões da mesma linha, que é pior que o problema.

**Vamos separar a nossa voz da dele.** Quando um rótulo importado afirmar
destino de gorjeta, a nossa linha de serviço — a que diz "o restaurante
distribui à equipe, como manda a lei" — não fica encostada nela: é o
encosto que faz a afirmação da casa parecer nossa. E o rótulo vai pro relatório
do dono, porque quem pode corrigir a comanda é ele, não nós.

Fica escrito aqui em vez de virar código agora porque o adaptador que cria o
problema ainda não existe, e guarda escrito antes do caminho que ele protege é
como se escreve um predicado que nunca dispara — que é o erro que o
[`2026-09-10-frase-escrita-do-guarda-que-eu-olhava.md`](2026-09-10-frase-escrita-do-guarda-que-eu-olhava.md)
registra. O que existe agora é o gatilho, com nome.
