/* Assembles the single-file artifact: shell + the food renderer inlined.
   food.js stays a real module so it can be audited on its own sheet. */
const fs = require('fs'), path = require('path');
const dir = __dirname;
const food = fs.readFileSync(path.join(dir, 'food.js'), 'utf8')
  .replace(/^export /gm, '')                       // inline: no module scope
  .replace(/^\/\* ═+\n[\s\S]*?═+ \*\/\n/, '');     // its banner moves into the shell
const shell = fs.readFileSync(path.join(dir, 'app.html'), 'utf8');
const out = shell.replace('/*__FOOD__*/', food);
const target = process.argv[2] || path.join(dir, '..', 'racha-ios.html');

/* O ALVO É PUBLICADO. `racha-ios.html` vira `/ios` no domínio de produção
   (embed-ios.mjs → vercel.json), então o que sai daqui é servido a visitante
   real — e um terceiro embutido aqui é corresponsabilidade nossa (Fashion ID,
   TJUE C-40/17), esteja ou não no mapa de dados.

   A versão anterior tirava os `<link>` de CDN SÓ ao escrever `preview.html` —
   a cópia de auditoria, que ninguém publica. O alvo saía com eles. O conserto
   da Google Fonts foi aplicado à mão no ARTEFATO em 2026-09-10 e teria voltado
   no primeiro `node build.js`: conserto com prazo de validade. A fonte está
   limpa agora, e este guarda é o que impede a próxima. */
/* UMA FORMA POR FAMÍLIA, não a forma que eu tinha na frente.
   A primeira versão era /https?:\/\/…\.[a-z]{2,}/ — exigia esquema literal e
   TLD de letras, que é exatamente o `<link href="https://fonts.googleapis.com/…">`
   do incidente. Deixava passar `//fonts.googleapis.com/…` (relativo ao
   protocolo, o que a maioria dos snippets de CDN ainda produz), que numa
   página servida por HTTPS carrega o MESMO recurso do Google — mesmo IP de
   visitante, mesma corresponsabilidade — e deixava passar host por IP nu.

   A segunda revisão achou mais três formas: `https://x@fonts.googleapis.com`
   (userinfo antes do host), `"https:\/\/…"` (barras escapadas, que é a forma
   que um JSON embutido no artefato toma) e `http://[2606:4700::1]/` (IPv6).
   E um falso positivo que teria derrubado o build num comentário inocente:
   `//TODO.rever isso` casava como host. Comentário de linha JS sai antes.
   Achado da revisão de segurança de 2026-09-13. */
/* Exige FORMA DE HOST — TLD de letras ou IPv4 — senão o `//` de uma divisão
   ou de um comentário de linha vira "terceiro embutido" e o guarda que grita
   por qualquer coisa é desligado na primeira semana. */
const HOSTS_PROIBIDOS =
  /(?:https?:)?\\?\/\\?\/(?!localhost\b)(?:[^\s"'<>/@]*@)?(?=[a-z0-9[])(?:\[[0-9a-f:]+\]|[a-z0-9._~-]*(?:\.[a-z]{2,}|(?:\.\d{1,3}){3}))(?::\d+)?/gi;
const forasteiros = [...new Set(
  out.replace(/<!--[\s\S]*?-->/g, '')              // comentário não baixa nada
     // Comentário de linha só quando vem depois de ESPAÇO, `;` ou começo de
     // linha. A versão anterior era `[^:"']`, e com isso um valor de atributo
     // SEM ASPAS e um `url()` de CSS — os dois válidos em HTML — eram lidos
     // como comentário e a linha inteira sumia antes da checagem:
     // `<script src=//cdn.evil.test/x.js>` e `@import url(//fonts.googleapis.com/…)`
     // passavam. Conserto de falso positivo que abriu três falsos negativos,
     // no commit anterior. Achado pela revisão de segurança de 2026-09-13.
     .replace(/(^|[\s;])\/\/[^\n]*$/gm, '$1')
     .match(HOSTS_PROIBIDOS) || [])];
if (forasteiros.length) {
  console.error('build: o alvo publicado embutiria terceiros:\n  ' + forasteiros.join('\n  '));
  console.error('Sirva o recurso daqui (ver o bloco @font-face no topo do app.html).');
  process.exit(1);
}

fs.writeFileSync(target, out);
/* Cópia de auditoria local: as mesmas faces, por caminho relativo, porque
   `/ios-fonts/` só resolve no deploy e o lab abre por `file://`.
   SÓ quando não veio alvo explícito: o `claims.test.js` constrói pra um
   temporário, e escrever no `ios/lab` da árvore real a cada `npx jest` fazia
   o teste MUTAR o diretório de trabalho — invisível porque o arquivo está
   gitignorado, e quebrado num checkout somente-leitura. */
if (!process.argv[2]) {
  fs.writeFileSync(path.join(dir, 'preview.html'),
    out.replace(/url\(\/ios-fonts\//g, 'url(../fonts/'));
}
console.log('built', target, (out.length / 1024).toFixed(0) + 'KB');
