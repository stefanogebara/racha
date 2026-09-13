'use strict';

/**
 * O CENSO DA AFIRMAÇÃO.
 *
 * Em 2026-09-10 a frase "o serviço vai pra equipe" foi corrigida em dois
 * arquivos Swift e declarada resolvida. Ela continuou viva em mais três
 * lugares — inclusive em `/ios`, servido ao público no domínio de produção —
 * e o teste escrito junto com o conserto (`TableSourceTests.swift`) não podia
 * ver nenhum deles: ele listava, à mão, os dois arquivos que eu estava
 * olhando. É a falha que o `docs/decisions/2026-09-10-frase-escrita-do-guarda-que-eu-olhava.md`
 * registra, aplicada a si mesma.
 *
 * A lição das duas revisões: **a unidade da varredura é a AFIRMAÇÃO, não o
 * arquivo**. Uma promessa errada é a mesma promessa errada em Swift, em TSX ou
 * em HTML, e o censo tem que alcançar as FONTES DE BUILD — um conserto
 * aplicado só no artefato gerado é um conserto com prazo de validade.
 *
 * Três garantias aqui, e a terceira é a que sustenta as outras duas:
 *
 *   1. nenhuma superfície publicada afirma o destino do serviço sem nomear
 *      quem distribui;
 *   2. o censo RECONHECE as frases aposentadas — ele é testado contra um
 *      corpo de frases ruins, não só contra a árvore de hoje, que passa por
 *      construção. Um padrão que só casa com a linha já corrigida não é censo;
 *   3. o artefato publicado é REPRODUTÍVEL a partir da fonte. Isso é o que
 *      torna "consertei só o gerado" impossível de deixar na árvore.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..');
const CLAIMS = JSON.parse(
  fs.readFileSync(path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8'),
);

/**
 * ONDE O CENSO ANDA.
 *
 * As superfícies PUBLICADAS mais as FONTES delas. `ios/lab` inteiro fica de
 * fora (é rascunho de design) menos `app.html`, que não é rascunho: é de onde
 * o `build.js` compila o `racha-ios.html` que a produção serve. Foi por essa
 * porta que a frase aposentada ia voltar.
 */
const SUPERFICIES = [
  { dir: 'apps/web/src', ext: /\.(ts|tsx)$/ },
  { dir: 'ios/Racha', ext: /\.swift$/ },
];
const SOLTOS = [
  'ios/racha-ios.html',   // publicado em /ios (embed-ios.mjs → vercel.json)
  'ios/lab/app.html',     // a FONTE do de cima
  'apps/web/index.html',
];

function anda(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(node_modules|dist|build|Pods|DerivedData)$/.test(e.name)) continue;
      anda(p, ext, out);
    } else if (ext.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Comentário não é afirmação: ninguém lê o comentário na mesa. E o censo
 * PRECISA ignorá-lo, porque o comentário que explica um conserto normalmente
 * CITA a frase que foi consertada — foi assim que a primeira versão do censo
 * do `<title>` acusou o próprio comentário que eu tinha acabado de escrever.
 *
 * O `//` só conta como comentário quando não vem depois de `:` — senão
 * `https://` decapita a linha. Limitação conhecida e aceita: um literal que
 * contenha `//` no meio some daqui, e nenhuma frase de produto tem isso.
 */
function semComentario(texto) {
  return texto
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const G = CLAIMS.gorjeta_destino;
const reDirecional = new RegExp(G.gatilho_direcional, 'i');
const reQuantidade = new RegExp(G.gatilho_quantidade, 'i');
const reDistribuidor = new RegExp(G.exige_distribuidor, 'i');

/**
 * O gatilho é a CONSTRUÇÃO, não o substantivo.
 *
 * A primeira versão deste censo exigia `gorjeta|serviço` na mesma linha da
 * direção. Ela deixava passar duas coisas, e as duas são o erro de sempre —
 * o padrão desenhado a partir da linha que eu estava olhando:
 *
 *   · a etiqueta `>vai pra equipe · toque pra tirar<`, onde o substantivo
 *     está no ELEMENTO VIZINHO. Era uma das duas frases vivas em produção;
 *   · o espanhol INTEIRO, porque `servicio` não casa com `servi[çc]o`. Uma
 *     língua de mercado fora do censo, sem nada dizendo isso.
 *
 * Agora: quem diz PRA ONDE o dinheiro vai tem que nomear quem distribui,
 * tenha ou não o substantivo do lado. `Serviço da equipe` (genitivo: de quem
 * ele é) continua legítimo; `o serviço vai pra equipe` (direcional: pra onde
 * ele vai) é a afirmação proibida.
 */
function afirmaDestinoSemDistribuidor(linha) {
  return (reDirecional.test(linha) || reQuantidade.test(linha)) && !reDistribuidor.test(linha);
}

describe('a afirmação sobre o destino do serviço', () => {
  test('o censo reconhece as frases aposentadas — e absolve as aprovadas', () => {
    // ESTE é o teste que faltou da outra vez. Uma mutação de controle prova
    // que o assert está ligado; ela não prova que o padrão cobre a CLASSE.
    const escaparam = G.frases_aposentadas.filter((f) => !afirmaDestinoSemDistribuidor(f));
    expect(escaparam).toEqual([]);

    const acusadas = G.frases_aprovadas.filter((f) => afirmaDestinoSemDistribuidor(f));
    expect(acusadas).toEqual([]);

    // E a dispensa tem que ser o que SALVA a frase aprovada, não o gatilho
    // tê-la ignorado. Sem isto, uma aprovada que o padrão simplesmente não vê
    // passaria por "absolvida" e serviria de prova falsa de cobertura.
    const inertes = G.frases_aprovadas.filter(
      (f) => !reDirecional.test(f) && !reQuantidade.test(f));
    expect(inertes).toEqual([]);

    // O corpo não pode encolher em silêncio até virar a linha de hoje.
    expect(G.frases_aposentadas.length).toBeGreaterThanOrEqual(8);
    // As três línguas do produto estão representadas entre as aposentadas.
    for (const marca of ['equipe', 'staff', 'equipo']) {
      expect(G.frases_aposentadas.some((f) => f.toLowerCase().includes(marca))).toBe(true);
    }
  });

  test('nenhuma superfície publicada (nem a fonte de uma) afirma o destino sem nomear quem distribui', () => {
    const arquivos = [
      ...SUPERFICIES.flatMap((s) => anda(path.join(RAIZ, ...s.dir.split('/')), s.ext)),
      ...SOLTOS.map((f) => path.join(RAIZ, ...f.split('/'))),
    ];
    // Um censo que anda em zero arquivos passa calado.
    expect(arquivos.length).toBeGreaterThan(20);

    const achados = [];
    for (const f of arquivos) {
      const linhas = semComentario(fs.readFileSync(f, 'utf8')).split('\n');
      linhas.forEach((linha, i) => {
        if (afirmaDestinoSemDistribuidor(linha)) {
          achados.push(`${path.relative(RAIZ, f)}:${i + 1}  ${linha.trim().slice(0, 120)}`);
        }
      });
    }
    expect(achados).toEqual([]);
  });
});

describe('o artefato publicado vem da fonte', () => {
  /**
   * `ios/racha-ios.html` é gerado, versionado e SERVIDO. Um conserto feito à
   * mão nele sobrevive até o próximo `node ios/lab/build.js` — foi assim que
   * a remoção da Google Fonts virou um conserto com prazo de validade, e teria
   * sido assim de novo com a frase da gorjeta.
   *
   * Reconstruir e comparar fecha os dois lados: artefato editado à mão falha,
   * fonte editada sem rebuild falha. Depois disso "consertei o arquivo errado"
   * deixa de ser um estado que a árvore aceita.
   */
  test('rebuildar a fonte reproduz o artefato byte a byte', () => {
    const alvo = path.join(RAIZ, 'ios', 'racha-ios.html');
    const temp = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'racha-')), 'saida.html');
    execFileSync(process.execPath, [path.join(RAIZ, 'ios', 'lab', 'build.js'), temp], { stdio: 'pipe' });
    expect(fs.readFileSync(temp, 'utf8')).toBe(fs.readFileSync(alvo, 'utf8'));
  });

  test('o build recusa embutir terceiro no alvo publicado', () => {
    // O guarda do `build.js` tem que DISPARAR, não existir. Sujo a fonte numa
    // cópia, mando construir, e exijo que ele saia com erro.
    const lab = path.join(RAIZ, 'ios', 'lab');
    const sujo = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'racha-')), 'sujo');
    fs.cpSync(lab, sujo, { recursive: true });
    const app = path.join(sujo, 'app.html');
    fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace(
      '<style>',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo">\n<style>'));
    let saiuComErro = false;
    let saida = '';
    try {
      execFileSync(process.execPath, [path.join(sujo, 'build.js'), path.join(sujo, 'saida.html')],
        { stdio: 'pipe' });
    } catch (e) {
      saiuComErro = true;
      saida = String(e.stderr);
    }
    expect(saiuComErro).toBe(true);
    expect(saida).toMatch(/fonts\.googleapis\.com/);
    // E não deixou o arquivo envenenado pra trás.
    expect(fs.existsSync(path.join(sujo, 'saida.html'))).toBe(false);
  });
});
