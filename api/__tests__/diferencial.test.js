'use strict';

/**
 * O NONO INSTRUMENTO: O DIFERENCIAL CONTRA O COMMIT PAI.
 *
 * Nenhuma suíte deste repositório comparava o guarda com a versão anterior
 * dele. Todas perguntam "o corpo de hoje passa?" — e o corpo de hoje é escrito
 * junto com a regra de hoje, então ele não pode ver a frase que ONTEM era
 * recusada e hoje não é. Foi exatamente assim que a rodada 19 embarcou um
 * CRITICAL: `A gorjeta no acerto vai pro garçom.` era recusada em 6add1ed e
 * passava em 33e7672, nos dois guardas e no censo de build, com as seis suítes
 * verdes. Quem achou foi uma revisão de fora, construindo os dois e diferindo.
 *
 * Então o repositório passa a fazer isso sozinho: monta o censo do commit PAI,
 * roda os dois sobre a união dos corpos mais uma grade gerada, e exige que
 * NENHUM veredito vá de RECUSA pra PASSE. O outro sentido é livre — apertar o
 * guarda é o trabalho —, e um afrouxamento deliberado se declara.
 *
 * O QUE ISTO NÃO MEDE: só o lado JS. O gêmeo Swift é amarrado pelo corpo
 * compartilhado e pelo `fabricador`, que roda os dois. E só compara com UM
 * commit atrás: uma regressão introduzida e mantida por dois commits vira a
 * nova linha de base, que é o mesmo limite de qualquer diferencial.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..');
const F = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'afirmacoes.fixture.json'), 'utf8'));
const T = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'trilingue.fixture.json'), 'utf8'));

/** Declarações de afrouxamento DELIBERADO, com o motivo escrito. */
const AFROUXADAS = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8'),
).gorjeta_destino._afrouxamentos_declarados || {};

/** Monta um censo executável a partir de um `claims.test.js` + `claims.json`. */
function censoDe(dir) {
  const fonte = fs.readFileSync(path.join(dir, 'api', '__tests__', 'claims.test.js'), 'utf8');
  const corpo = fonte.slice(0, fonte.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');", 'const RAIZ = ' + JSON.stringify(dir) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
      'require(' + JSON.stringify(path.join(dir, 'scripts')) + " + '/");
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dif-')), 'censo.js');
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  return require(arq).acusa;
}

/** Extrai o commit pai para um diretório temporário. */
function pai() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-'));
  for (const f of ['api/__tests__/claims.test.js', 'docs/compliance/claims.json',
    'scripts/gen-claim-patterns.js']) {
    const destino = path.join(dir, f);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, execFileSync('git', ['show', `HEAD:${f}`],
      { cwd: RAIZ, encoding: 'utf8', maxBuffer: 1 << 26 }));
  }
  return dir;
}

describe('nenhum veredito vai de RECUSA para PASSE contra o commit pai', () => {
  const temGit = (() => {
    try { execFileSync('git', ['rev-parse', 'HEAD'], { cwd: RAIZ, stdio: 'pipe' }); return true; }
    catch { return false; }
  })();

  (temGit ? test : test.skip)('o corpo inteiro, mais a grade gerada', () => {
    const agora = censoDe(RAIZ);
    let antes;
    try { antes = censoDe(pai()); } catch (e) {
      // O pai pode não ter o arquivo (primeiro commit do guarda). Pular é dito
      // em voz alta, nunca silencioso.
      expect(String(e.message)).toMatch(/exist|ENOENT|unknown revision/i);
      return;
    }
    const frases = new Set([
      ...F.casos.map((c) => c.texto),
      ...T.trios.flatMap((t) => [t.pt, t.en, t.es]),
    ]);
    // Uma grade pequena de formas que o corpo não tem, pra que o diferencial
    // não meça só as frases que alguém já pensou.
    const NOMES = ['gorjeta', 'caixinha', 'serviço', 'comissão', 'taxa', 'troco', 'acerto', 'valor'];
    const QUADROS = [(n) => `A ${n} vai pro garçom.`, (n) => `O ${n} fica com a equipe.`,
      (n) => `A gorjeta no ${n} vai pro garçom.`, (n) => `Sobre a gorjeta\n- ${n} pra equipe`];
    for (const n of NOMES) for (const q of QUADROS) frases.add(q(n));

    const afrouxou = [...frases]
      .filter((f) => antes(f) === true && agora(f) === false)
      .filter((f) => !AFROUXADAS[f]);
    expect(afrouxou).toEqual([]);

    // Declaração que envelheceu sai: afrouxamento que não afrouxa mais é
    // perdão permanente, a dívida de sempre.
    const mortas = Object.keys(AFROUXADAS)
      .filter((f) => !(antes(f) === true && agora(f) === false));
    expect(mortas).toEqual([]);
    for (const [f, porque] of Object.entries(AFROUXADAS)) {
      expect(`${f}: ${porque}`).toMatch(/.{160,}/);
    }
  }, 120000);
});
