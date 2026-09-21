# O fio que diz onde se digita

**Decisão:** a moldura de um CAMPO passa a ter régua de contraste
(`--fio-controle`, ≥3:1), a moldura de um cartão continua sendo desenho
(`--fio`), e a diferença entre as duas é imposta por um censo que calcula em vez
de um comentário que afirma.

## O que estava errado

A auditoria de design de 2026-09-21 mediu a folha token por token. O achado que
sobrou depois de tirar o cosmético:

```
--fio      #D4D2CB  sobre o papel  1,33:1   sobre o papel-alto  1,41:1
--fio-forte #A6A59F sobre o papel  2,17:1   sobre o papel-alto  2,30:1
```

E um campo desta plataforma não tem preenchimento que o distinga do cartão em
volta — `.campo` é `--papel` dentro de `--papel-alto`, que são 1,06:1 um do
outro. Ou seja: a moldura de 1px **é** a única coisa que diz onde se digita, e
ela estava a 1,33:1. A WCAG 1.4.11 pede 3:1 para informação visual necessária
para identificar um componente, e um campo de texto vazio é o exemplo canônico
da regra: sem a moldura não há campo, há espaço em branco.

Valia para `.campo`, `.namefield`, `.customrow` e `.cfggrid label` — o
formulário que move dados bancários inteiro.

## Por que `var(--faint)` e não um sexto cinza

O valor que resolve está em 3:1 sobre as três superfícies onde a moldura é
desenhada. O cinza novo que eu calculei primeiro (#80807A) caía a **1,03:1** do
`--faint` que já existe: dois nomes para o mesmo valor, que é exatamente a forma
que este arquivo já pagou para aprender quando apagou a camada de apelidos.
Então `--fio-controle: var(--faint)` — apelido semântico lido por call sites
reais, como `--erro-fio: var(--coral)`.

O acoplamento é monotônico na direção certa: escurecer o `--faint` (para
perseguir os 4,5:1 de placeholder) escurece a moldura junto; clarear quebra o
build, porque o piso de 3:1 está fixado por cálculo.

## Só campo

Botão com rótulo se identifica pelo rótulo; cartão é agrupamento e não tem
régua; divisória separa, não identifica. `.mode`, `.itempick`, `.stepper`,
`.langtoggle`, `.card`, `.panel`, `.pill` e as linhas de `.items` ficam com
`--fio`. Aplicar a régua onde ela não se aplica teria engrossado a folha inteira
e apagado a diferença entre desenho e obrigação — que é a diferença que esta
decisão existe para escrever.

## O comentário que estava errado

O bloco do `--faint` justificava 3,3:1 dizendo que a norma dispensa placeholder.
Não dispensa: a dispensa de 1.4.3 é para componente inativo, logotipo e texto
incidental. O que sustenta o valor é outra coisa, e é verificável — todo campo
desta plataforma tem **rótulo visível** (é para isso que `.campo` e
`.cfggrid label` existem), então o placeholder é exemplo, não é o nome do campo.
No dia em que um campo voltar a ser só-placeholder, o token não cobre mais o
caso, e agora isso está escrito onde alguém lê.

## O censo (`apps/web/test/contraste.test.ts`)

`tokens.test.ts` provava que a folha é consistente consigo mesma — passaria
inteiro com a paleta trocada por outra. Este prende o que a folha **afirma**:

1. **O espelho.** Dezessete tokens são cópia literal do `presence-system.css` do
   twin-me. Cópia sem censo não é sistema compartilhado, é coincidência com
   prazo de validade. Cada token da raiz é espelho declarado ou divergência
   declarada **com motivo** — o silêncio é a única resposta proibida. Quando o
   arquivo original está na máquina, o retrato é conferido contra ele (e viu que
   o Presence declara os tokens em `.ps-system, .presence-shell`, não em
   `:root`); no CI não está, e aí a tabela responde sozinha pelo que afirma.
2. **As razões.** "3,54:1", "5,2:1", "3,98:1", "3,3:1" eram números digitados à
   mão dentro de comentários, e comentário não reprova build. Agora são
   calculados do valor que está na folha, contra a superfície onde a cor é de
   fato desenhada, com a régua que se aplica a cada par.
3. **A regra continua valendo para o quinto campo.** A varredura acha campo pelo
   que a própria folha já diz (`cursor: text`), não por uma lista paralela que
   envelhece.

Medido contra mutantes: valor do espelho trocado, token novo sem declarar,
`--fio-controle` apontando pro `--fio`, campo voltando pro fio decorativo,
`--faint` encostando no `--grafite` — os cinco ficam vermelhos, e a folha limpa
fica verde.

## O resto da auditoria

- **288 KB de fontes órfãs** (`InstrumentSans-400/500/600`,
  `InstrumentSerif-400/400i`, `Inter-400/500/600`) apagados: nenhum `@font-face`
  as citava desde o redesenho. A única referência que sobrou no disco era um
  `dist/` velho, que é ignorado. `"Inter"` continua na pilha de `--ui` como
  fallback de fonte instalada, que é uso legítimo e não pede arquivo.
- **`.eyebrow` escopada** para `.landing .eyebrow`. Ela lia `--cr2`, que só
  existe dentro do bloco `.landing`: fora dali a regra prometia um estilo e saía
  sem cor nenhuma, porque o CSS descarta `color` em silêncio. Os dois usos de
  hoje estão na landing; o seletor é o que impede o terceiro, em outra tela, de
  nascer fantasma.

Medido no navegador sobre o build de verdade: a moldura sai em `rgb(130,131,123)`
a 3,57:1 do cartão, a Manrope carrega, e a eyebrow fora da landing agora cai em
texto de corpo em vez de versalete sem cor.

## O `node_modules` que estava versionado

Achado ao preparar este commit, e não pela auditoria: `apps/web/node_modules`
é um **link simbólico versionado** desde `5126c33` (2026-09-16), apontando pro
caminho absoluto `/Users/stefanogebara/racha-pr8/apps/web/node_modules` — uma
worktree local que já não existe. Quem clonar o repositório recebe um link
pendurado no lugar onde as dependências deveriam ficar.

O `.gitignore` já tem as duas regras (`node_modules/` **e** `node_modules` sem
barra, com o comentário explicando que a forma com barra não pega link
simbólico, porque pro git um link não é diretório). Mas `.gitignore` não
desversiona o que já entrou, e o link entrou antes da regra.

O CI não acusou porque `npm ci` apaga `node_modules` inteiro antes de instalar.
Local, o efeito foi o que se espera de um ciclo: `racha` → `racha-pr8` →
`racha`, e o `vite build` morria com "Too many levels of symbolic links" — que
foi como isto apareceu. Sai do índice neste commit.
