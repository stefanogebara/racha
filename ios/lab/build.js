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
fs.writeFileSync(target, out);
// Local audit copy with vendored fonts so screenshots show the real faces.
fs.writeFileSync(path.join(dir, 'preview.html'),
  out.replace(/<link rel="preconnect"[^>]*>\s*/g, '')
     .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*">/,
              '<link rel="stylesheet" href="fonts.css">'));
console.log('built', target, (out.length / 1024).toFixed(0) + 'KB');
