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
const HOSTS_PROIBIDOS = /https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}/gi;
const forasteiros = [...new Set(
  out.replace(/<!--[\s\S]*?-->/g, '')              // comentário não baixa nada
     .match(HOSTS_PROIBIDOS) || [])];
if (forasteiros.length) {
  console.error('build: o alvo publicado embutiria terceiros:\n  ' + forasteiros.join('\n  '));
  console.error('Sirva o recurso daqui (ver o bloco @font-face no topo do app.html).');
  process.exit(1);
}

fs.writeFileSync(target, out);
/* Cópia de auditoria local: as mesmas faces, por caminho relativo, porque
   `/ios-fonts/` só resolve no deploy e o lab abre por `file://`. */
fs.writeFileSync(path.join(dir, 'preview.html'),
  out.replace(/url\(\/ios-fonts\//g, 'url(../fonts/'));
console.log('built', target, (out.length / 1024).toFixed(0) + 'KB');
