/**
 * Copia o protótipo do app iOS pra dentro do build do site.
 *
 * O `ios/racha-ios.html` é um arquivo único — o protótipo vivo que é a FONTE do
 * design (decisões #26 em diante). Publicá-lo em `/ios` no mesmo deploy faz o
 * link de preview do PR mostrar as duas coisas: a plataforma web e o app
 * nativo, sem precisar de um Mac pra olhar.
 *
 * Roda no prebuild. Se o arquivo não existir, avisa e SEGUE: um preview
 * faltando nunca pode derrubar o deploy do produto que cobra dinheiro.
 */
import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const jobs = [
  [resolve(root, 'ios/racha-ios.html'), resolve(here, '../public/ios.html')],
  [resolve(root, 'ios/lab/img/carved'), resolve(here, '../public/img/carved')],
  // A Archivo vai junto: o protótipo deixou de puxá-la da CDN do Google (o
  // domínio de produção não manda IP de visitante pra terceiro nenhum sem que
  // isso esteja no mapa de dados). Ver o comentário no topo do racha-ios.html.
  [resolve(root, 'ios/fonts'), resolve(here, '../public/ios-fonts')],
];

for (const [from, to] of jobs) {
  try {
    await access(from);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
    console.log('ios-preview: copiado', from.replace(root + '/', ''));
  } catch (e) {
    console.warn('ios-preview: pulei', from.replace(root + '/', ''), '—', e.code ?? e.message);
  }
}
