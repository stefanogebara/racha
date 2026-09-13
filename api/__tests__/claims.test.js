'use strict';

/**
 * O CENSO DA AFIRMAÇÃO — terceira versão.
 *
 * O histórico das duas anteriores e o porquê da inversão estão em
 * `docs/compliance/claims.json`, em `_porque_esta_na_terceira_versao`. O
 * resumo: o CONECTIVO entre a gorjeta e quem a recebe é infinito ("vai pra",
 * "fica com", "é de", "repassado a", "keeps", "se queda con", ou nenhum verbo
 * — "100% pro garçom"). Os dois SUBSTANTIVOS das pontas são finitos. A v2
 * enumerava conectivos, que é o jogo que a língua natural sempre ganha: doze
 * fugas em treze tentativas, e a pior foi `gar[çc]on` não casar com `garçom`.
 *
 * Então o gatilho são os substantivos, o conectivo não é modelado, e quem
 * quiser dizer as duas coisas na mesma janela nomeia o distribuidor ou pede
 * dispensa por escrito no JSON. Dispensa errada é item de revisão; paráfrase
 * faltando era incidente de produção.
 *
 * Quatro garantias:
 *   1. nenhuma janela publicada junta gorjeta e destinatário sem nomear quem
 *      distribui — e "quem" é um SUJEITO, não só o verbo;
 *   2. o censo reconhece cada frase aposentada, e cada dispensa é usada de
 *      verdade (dispensa que não dispensa nada é buraco esquecido);
 *   3. as frases aprovadas passam PELA dispensa, não por não terem sido
 *      vistas;
 *   4. o artefato publicado é reprodutível a partir da fonte.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..');
const G = JSON.parse(
  fs.readFileSync(path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8'),
).gorjeta_destino;

const reGorjeta = new RegExp(G.substantivo_gorjeta, 'i');
const reDestinatario = new RegExp(G.substantivo_destinatario, 'i');
const reDistribuidor = new RegExp(G.distribuidor_com_sujeito, 'i');
const reRevoga = new RegExp(G.revoga_dispensa, 'i');
const { expandirDest: _exp } = require('../../scripts/gen-claim-patterns.js');
const reSuprimeGlobal = new RegExp(
  _exp(G.gatilho_forma_direcional, G.substantivo_destinatario_runtime), 'i');
const JANELA = G.janela_linhas;

/**
 * Comentário não é afirmação: ninguém lê o comentário na mesa. E o censo
 * PRECISA ignorá-lo, porque o comentário que explica um conserto quase sempre
 * CITA a frase consertada.
 *
 * Em Markdown, `>` de citação NÃO é comentário: o leitor lê. Foi num arquivo
 * Markdown que a frase sobreviveu mais tempo.
 */
function semComentario(texto, ext) {
  if (ext === '.md') return texto;
  return texto
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * A regra, numa função. Os testes abaixo exercitam ESTA — não cópias dela.
 *
 * A dispensa do distribuidor é REVOGADA por negação na cláusula ou logo antes:
 * `folha de pagamento` como substantivo nu fazia de "sem passar pela folha de
 * pagamento" uma dispensa — e "você não precisa esperar a folha" é exatamente
 * como se vende o arranjo ilegal.
 */
/** Orações, como no guarda de runtime: `. ; ! ? : \n —` separam. */
function oracoes(texto) {
  return texto.split(/[.;!?:\n—]/).map((o) => o.trim()).filter(Boolean);
}

/**
 * A oração NEGA o destino, em vez de afirmá-lo?
 *
 * A MESMA regra escopada do guarda de runtime, e pelo mesmo motivo: um
 * `reRevoga.test(oracao)` solto faz qualquer preâmbulo tranquilizador
 * ("Sem dúvida, …") desligar a regra — 112 de 160 afirmações proibidas
 * passavam assim no Swift. A janela vai do FIM do substantivo da gorjeta (ou
 * dez caracteres antes da forma direcional, o que vier depois) até o
 * destinatário.
 */
function nega(oracao) {
  const d = new RegExp(reDestinatario.source, 'i').exec(oracao);
  if (!d) return false;
  let ini = 0;
  const g = new RegExp(reGorjeta.source, 'i').exec(oracao);
  if (g && g.index + g[0].length <= d.index) ini = g.index + g[0].length;
  const dir = new RegExp(reSuprimeGlobal.source, 'i').exec(oracao);
  if (dir && dir.index <= d.index) ini = Math.max(ini, dir.index - 10);
  ini = Math.max(0, Math.min(ini, d.index));
  return ini < d.index && reRevoga.test(oracao.slice(ini, d.index));
}

/** Esta oração carrega, ELA MESMA, a cláusula do distribuidor não negada? */
function temDistribuidor(oracao) {
  for (const m of oracao.matchAll(new RegExp(reDistribuidor.source, 'gi'))) {
    const ini = Math.max(0, m.index - 30);
    if (!reRevoga.test(oracao.slice(ini, m.index + m[0].length + 30))) return true;
  }
  return false;
}

/**
 * A regra, e ela é a MESMA do guarda de runtime — de propósito.
 *
 * O censo julgava a janela inteira: bastava UMA cláusula de distribuidor em
 * qualquer posição pra dispensar tudo. Então
 * `'a gorjeta vai direto pro garçom. O restaurante distribui à equipe, como
 * manda a lei'` passava — e essa cauda é exatamente o que a regra 9 do
 * `SystemPrompt` manda dizer e o que as `frases_aprovadas` ensinam a escrever.
 * O guarda Swift foi reescrito pra recusar isso e o censo ficou pra trás, o
 * que importa MAIS aqui: é o censo que governa o roteiro IMPRESSO entregue ao
 * garçom, que é oferta vinculante do CDC art. 30.
 *
 * Regra por ORAÇÃO pra dispensa, janela inteira pro gatilho — nomear quem
 * distribui não desdiz o caminho já prometido.
 * Achado pela revisão de compliance de 2026-09-13.
 */
function acusa(janela) {
  if (!reGorjeta.test(janela) || !reDestinatario.test(janela)) return false;
  const partes = oracoes(janela);
  // 1. Uma oração que junta os dois substantivos traz o distribuidor ela
  //    mesma — ou está negando.
  for (const o of partes) {
    if (reGorjeta.test(o) && reDestinatario.test(o) && !nega(o) && !temDistribuidor(o)) return true;
  }
  // 1b. E a FORMA DIRECIONAL numa oração não é resgatável por cláusula de
  //     distribuidor nenhuma, nem na mesma oração.
  for (const o of partes) {
    if (reSuprimeGlobal.test(o) && !nega(o)) return true;
  }
  // 2. Repartida entre orações: o distribuidor tem que ser nomeado ATÉ a
  //    oração do destinatário, nunca depois dela.
  if (partes.some((o) => reGorjeta.test(o) && reDestinatario.test(o))) return false;
  if (partes.some(nega)) return false;
  const iDest = partes.findIndex((o) => reDestinatario.test(o));
  const iDist = partes.findIndex(temDistribuidor);
  if (iDist >= 0 && iDest >= 0 && iDist <= iDest) return false;
  return iDest >= 0;
}

const EXT = /\.(ts|tsx|swift|html|md)$/;
const FORA = /^(node_modules|dist|build|Pods|DerivedData|__tests__|test|\.git)$/;

function anda(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(RAIZ, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (FORA.test(e.name)) continue;
      if (G.onde_o_censo_anda.docs_fora.includes(rel)) continue;
      anda(p, out);
    } else if (EXT.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

function superficies() {
  const { arvores, soltos } = G.onde_o_censo_anda;
  return [
    ...arvores.flatMap((d) => anda(path.join(RAIZ, ...d.split('/')))),
    ...soltos.map((f) => path.join(RAIZ, ...f.split('/'))),
  ];
}

/**
 * Devolve `{ achados, usos }`. A segunda metade é o que mantém o JSON honesto.
 *
 * DUAS CORREÇÕES estruturais sobre a v3, as duas do mesmo defeito:
 *
 *  · a âncora da dispensa era testada contra a JANELA, não contra a linha, e
 *    depois de dispensar o laço pulava `JANELA-1` linhas. Somadas, davam um
 *    silenciador de uso geral: bastava pôr a linha ofensora ao lado de uma
 *    linha ancorada, no mesmo arquivo, e ela nunca começava janela própria.
 *    Havia uma instância viva — `docs/onboarding/README.md:111` é violação por
 *    si só e estava sendo perdoada por uma âncora escrita pra linha 110.
 *  · o achado era reportado no INÍCIO da janela, que muitas vezes não é a
 *    linha que afirma nada. Agora se reporta na última das linhas que
 *    carregam o gatilho, e é ELA que a âncora tem que casar.
 *
 * Achado pela revisão de compliance de 2026-09-13.
 */
function varrer() {
  const achados = [];
  const usos = new Map();
  for (const f of superficies()) {
    const rel = path.relative(RAIZ, f).split(path.sep).join('/');
    const linhas = semComentario(fs.readFileSync(f, 'utf8'), path.extname(f)).split('\n');
    for (let i = 0; i < linhas.length; i++) {
      // O SÍTIO é a linha que NOMEIA O DESTINATÁRIO: é ali que a afirmação
      // aterrissa, e é ela que uma dispensa tem que nomear. Reportar no início
      // da janela dava até três achados pra uma entrada do dicionário (en/pt/es)
      // e fazia a dispensa apontar pra linha da chave, que não afirma nada.
      if (!reDestinatario.test(linhas[i])) continue;
      // A janela olha pros dois lados: o substantivo de gorjeta pode estar na
      // linha anterior (a chave do dicionário, ou a oração que quebrou).
      const fatia = linhas.slice(Math.max(0, i - JANELA + 1), i + JANELA).join('\n');
      if (!acusa(fatia)) continue;
      const d = G.dispensas.find((x) => x.arquivo === rel && linhas[i].includes(x.ancora));
      if (d) {
        const k = `${d.arquivo}|${d.ancora}`;
        usos.set(k, (usos.get(k) || 0) + 1);
        continue;
      }
      achados.push(`${rel}:${i + 1}  ${linhas[i].trim().slice(0, 110)}`);
    }
  }
  return { achados, usos };
}

describe('a afirmação sobre o destino do serviço', () => {
  test('nenhum padrão lido deste arquivo é undefined', () => {
    // `new RegExp(undefined, 'i')` compila pra /(?:)/ — casa TUDO. Renomear
    // uma chave no JSON e esquecer uma linha do teste transformou um oráculo
    // em tautologia verde pra sempre, no commit que consertava exatamente
    // essa classe do lado Swift. A checagem fecha a classe inteira.
    for (const [nome, re] of Object.entries({
      substantivo_gorjeta: reGorjeta, substantivo_destinatario: reDestinatario,
      distribuidor_com_sujeito: reDistribuidor, revoga_dispensa: reRevoga,
    })) {
      expect(G[nome]).toBeDefined();
      expect(re.source).not.toBe('(?:)');
    }
  });

  test('o censo reconhece TODA frase aposentada', () => {
    // A v2 passava aqui e falhava na vida porque o corpo era feito de
    // fragmentos que eu mesmo tinha recortado. Estas são linhas de verdade.
    const escaparam = G.frases_aposentadas.filter((f) => !acusa(f.linha))
      .map((f) => `${f.linha}   [${f.onde}]`);
    expect(escaparam).toEqual([]);
    expect(G.frases_aposentadas.length).toBeGreaterThanOrEqual(20);
    // As três línguas, e as três formas: movimento, posse e quantidade.
    for (const marca of ['garçom', 'garçons', 'staff', 'equipo', 'camarero', 'fica com', 'é d', '100%', 'pessoal', 'time']) {
      expect(G.frases_aposentadas.some((f) => f.linha.toLowerCase().includes(marca)))
        .toBe(true);
    }
  });

  test('as frases aprovadas passam PELA dispensa, não por não terem sido vistas', () => {
    const acusadas = G.frases_aprovadas.filter((f) => acusa(f));
    expect(acusadas).toEqual([]);
    // Cada uma tem que DISPARAR os dois substantivos: se o gatilho não a vê,
    // ela não prova cobertura nenhuma — prova só que o padrão é cego ali.
    const inertes = G.frases_aprovadas.filter(
      (f) => !(reGorjeta.test(f) && reDestinatario.test(f)));
    expect(inertes).toEqual([]);
  });

  test('nenhuma superfície publicada junta gorjeta e destinatário sem nomear quem distribui', () => {
    const arquivos = superficies();
    expect(arquivos.length).toBeGreaterThan(50);
    // O roteiro impresso é superfície: foi onde a frase sobreviveu por último.
    expect(arquivos.some((f) => f.includes(`docs${path.sep}onboarding`))).toBe(true);
    expect(varrer().achados).toEqual([]);
  });

  test('toda dispensa é usada, e em UM sítio só', () => {
    const { usos } = varrer();
    const ociosas = G.dispensas.map((d) => `${d.arquivo}|${d.ancora}`).filter((k) => !usos.has(k));
    expect(ociosas).toEqual([]);
    // EXATAMENTE uma. Uma dispensa que passa a cobrir dois sítios cobriu um
    // que ninguém leu — e "alguém leu esta linha" é o que a dispensa afirma.
    const espalhadas = [...usos.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
    expect(espalhadas).toEqual([]);
    expect(G.dispensas.filter((d) => !d.porque || d.porque.length < 30)).toEqual([]);
  });
});

describe('o artefato publicado vem da fonte', () => {
  /**
   * `ios/racha-ios.html` é gerado, versionado e SERVIDO. Um conserto feito à
   * mão nele sobrevive até o próximo `node ios/lab/build.js`. Reconstruir e
   * comparar fecha os dois lados: artefato editado à mão falha, fonte editada
   * sem rebuild falha.
   */
  test('rebuildar a fonte reproduz o artefato byte a byte', () => {
    const alvo = path.join(RAIZ, 'ios', 'racha-ios.html');
    const temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'racha-')), 'saida.html');
    execFileSync(process.execPath, [path.join(RAIZ, 'ios', 'lab', 'build.js'), temp], { stdio: 'pipe' });
    expect(fs.readFileSync(temp, 'utf8')).toBe(fs.readFileSync(alvo, 'utf8'));
  });

  /**
   * UMA FORMA POR FAMÍLIA, não uma forma.
   *
   * A v1 deste teste mutava com `https://fonts.googleapis.com/…` — a mesma
   * forma que estava escrita dentro do guarda. Provava que o guarda dispara no
   * caso que ele já tratava, e nada mais. A revisão mostrou que
   * `//fonts.googleapis.com/…` (relativo ao protocolo) passava e carregava
   * EXATAMENTE o mesmo recurso do Google numa página servida por HTTPS.
   */
  test('um comentário de linha com ponto NÃO derruba o build', () => {
    // `//TODO.rever essa parte` casava como host na versão anterior do padrão.
    // Guarda que grita por coisa inocente é guarda desligado na primeira semana.
    const sujo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'racha-')), 'lab');
    fs.cpSync(path.join(RAIZ, 'ios', 'lab'), sujo, { recursive: true });
    const app = path.join(sujo, 'app.html');
    fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace(
      '<style>', '<script>\n//TODO.rever essa parte\nconst r = 10 //b.ce\n</script>\n<style>'));
    const saida = path.join(sujo, 'ok.html');
    expect(() => execFileSync(process.execPath, [path.join(sujo, 'build.js'), saida], { stdio: 'pipe' }))
      .not.toThrow();
    expect(fs.existsSync(saida)).toBe(true);
  });

  test.each([
    ['esquema explícito', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo">'],
    ['relativo ao protocolo', '<link rel="stylesheet" href="//fonts.googleapis.com/css2?family=Archivo">'],
    ['IP nu, sem TLD', '<img src="http://93.184.216.34/pixel.gif">'],
    ['script de CDN', '<script src="//cdn.exemplo.test/x.js"></script>'],
    ['userinfo antes do host', '<link rel="stylesheet" href="https://x@fonts.googleapis.com/css2">'],
    ['barras escapadas (JSON embutido)', '<script>var u = "https:\\/\\/fonts.googleapis.com/css2";</script>'],
    ['IPv6 entre colchetes', '<img src="http://[2606:4700::1]/pixel.gif">'],
    // Estas três passaram a vazar no commit que consertou o falso positivo do
    // `//TODO`: o removedor de comentário lia `=` e `(` como se fossem código
    // JS. Valor de atributo SEM ASPAS e `url()` de CSS são os dois válidos em
    // HTML, e os dois carregam o mesmo terceiro.
    ['atributo sem aspas', '<script src=//cdn.exemplo.test/x.js></script>'],
    ['@import de CSS', '<style>@import url(//fonts.googleapis.com/css2);</style>'],
    ['url() em style inline', '<div style=background:url(//exemplo.test/p.png)>x</div>'],
  ])('o build recusa embutir terceiro no alvo publicado: %s', (_nome, injecao) => {
    const sujo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'racha-')), 'lab');
    fs.cpSync(path.join(RAIZ, 'ios', 'lab'), sujo, { recursive: true });
    const app = path.join(sujo, 'app.html');
    fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('<style>', `${injecao}\n<style>`));
    const saida = path.join(sujo, 'saida.html');
    let erro = null;
    try {
      execFileSync(process.execPath, [path.join(sujo, 'build.js'), saida], { stdio: 'pipe' });
    } catch (e) { erro = e; }
    expect(erro).not.toBeNull();
    // E não deixou o arquivo envenenado pra trás.
    expect(fs.existsSync(saida)).toBe(false);
  });
});

describe('o guarda de runtime usa os MESMOS padrões do censo', () => {
  /**
   * A v3 escreveu os padrões duas vezes à mão — uma em JS, uma em Swift — e
   * eles já tinham divergido em quatro tokens no commit cujo teste dizia
   * impedir isso. A divergência não é simétrica: uma frase pega no build e não
   * no runtime chega ao cliente; uma exempta no build e acusada no runtime faz
   * o guarda REESCREVER texto correto.
   *
   * Comparar COMPORTAMENTO não fecharia (NSRegularExpression e RegExp divergem
   * em construções), então o Swift deixou de ter cópia: é gerado. Mesma forma
   * da reprodutibilidade do `racha-ios.html` — o artefato tem que ser o que a
   * fonte produz.
   */
  test('ClaimPatterns.swift é exatamente o que o gerador produz', () => {
    const { gerar, ALVO } = require('../../scripts/gen-claim-patterns.js');
    expect(fs.readFileSync(ALVO, 'utf8')).toBe(gerar());
  });

  test('o gerador emite todos os padrões que a regra usa', () => {
    const { gerar } = require('../../scripts/gen-claim-patterns.js');
    const swift = gerar();
    // Se um campo novo entrar no JSON e não no gerador, o runtime fica com uma
    // regra mais frouxa que o build e ninguém percebe.
    const { expandirDest } = require('../../scripts/gen-claim-patterns.js');
    for (const campo of ['substantivo_gorjeta', 'substantivo_destinatario',
      'distribuidor_com_sujeito', 'revoga_dispensa', 'gatilho_forma_direcional',
      'substantivo_destinatario_runtime']) {
      // `gatilho_forma_direcional` carrega `{DEST}`, que o gerador expande.
      const valor = expandirDest(G[campo], G.substantivo_destinatario_runtime);
      expect(swift).toContain(valor.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    }
  });
});

describe('as duas listas de destinatário não podem crescer em separado', () => {
  /**
   * Numa rodada só, `substantivo_destinatario` ganhou quinze tokens e
   * `gatilho_direcional_para_suprimir` não ganhou nenhum. O efeito não é
   * silencioso, é PIOR que silencioso: a afirmação passa a ser DETECTADA e não
   * SUPRIMÍVEL, e a versão do guarda que acrescentava a frase sancionada
   * publicava a promessa proibida com selo legal nosso embaixo.
   *
   * O guarda de runtime não acrescenta mais nada — recusa a volta inteira —
   * então hoje o custo é só de cobertura. O teste fica porque a relação entre
   * as duas listas era, até aqui, não escrita e não testada, que é como elas
   * divergiram num commit.
   */
  const reRuntime = new RegExp(G.substantivo_destinatario_runtime, 'i');
  // `{DEST}` é expandido pelo gerador a partir da lista de runtime — as duas
  // listas eram escritas à mão e divergiram três vezes, a última por um
  // acento. O teste tem que expandir igual, senão mede outro padrão.
  const { expandirDest } = require('../../scripts/gen-claim-patterns.js');
  const reSuprime = new RegExp(
    expandirDest(G.gatilho_forma_direcional, G.substantivo_destinatario_runtime), 'i');

  test('toda frase aposentada ou é suprimível no runtime, ou é da classe declarada', () => {
    // Sobre dados de VERDADE, não sobre as alternativas dos padrões: tentar
    // fatiar a regex em tokens produz lixo (`\btime\b` vira `btimeb`) e um
    // teste que mede o próprio artefato em vez do comportamento.
    const soDeteccao = new RegExp(G.destinatarios_so_deteccao.join('|'), 'i');
    const orfas = G.frases_aposentadas
      .map((f) => f.linha)
      .filter((l) => !reRuntime.test(l) && !soDeteccao.test(l));
    expect(orfas).toEqual([]);
    // A classe declarada é a exceção, não a regra.
    const declaradas = G.frases_aposentadas.filter((f) => !reRuntime.test(f.linha));
    expect(declaradas.length).toBeLessThanOrEqual(8);
    expect(G._porque_so_deteccao || '').toMatch(/.{120,}/);
  });

  test('a FORMA direcional continua reconhecendo as frases que ela é oráculo de vigiar', () => {
    // Ela não decide mais comportamento — o guarda recusa a volta inteira —
    // mas é com ela que o teste Swift afirma que nenhum quadro do stream ficou
    // legível. Um oráculo que parou de casar avalia coisa nenhuma.
    const casadas = G.frases_aposentadas.filter((f) => reSuprime.test(f.linha));
    expect(casadas.length).toBeGreaterThanOrEqual(18);
  });
});
