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

const { expandirDest: _exp, COMPOSTOS: COMPOR, PECAS } = require('../../scripts/gen-claim-patterns.js');
const reGorjeta = new RegExp(COMPOR.substantivo_gorjeta(G), 'i');
/** O que o NEGADOR pode negar — ver `_porque_nucleo_negavel`. */
const reNegavel = new RegExp(G.nucleo_negavel, 'i');
const reDestinatario = new RegExp(G.substantivo_destinatario, 'i');
const reDistribuidor = new RegExp(G.distribuidor_com_sujeito, 'i');
const reRevoga = new RegExp(COMPOR.revoga_dispensa(G), 'i');
/** Só os negadores; a evasão preposicional pertence à dispensa. */
const reNegador = new RegExp(COMPOR.negadores(G), 'i');
const reSuprimeGlobal = new RegExp(COMPOR.gatilho_forma_direcional(G), 'i');
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

/** Vírgula, `mas`, `porém`, `e sim`: daqui pra frente é outra afirmação. */
const reSeparador = new RegExp(G.separador_de_clausula, 'gi');
/** Frase de destino em QUALQUER lugar da oração. */
/**
 * UMA LISTA SÓ DENTRO DA DECISÃO. O censo localizava a oração com a lista
 * COMPLETA e julgava com a de RUNTIME: uma oração anterior casando um
 * substantivo só-do-build (`com você`, `pra gente`, `cozinha`) capturava o
 * índice, falhava o teste de destino, e o censo liberava — enquanto o guarda,
 * que usa uma lista só, recusava. Censo mais frouxo que o runtime, na direção
 * que o gerador existe pra impedir, no controle que governa o roteiro
 * IMPRESSO. A divisão de listas continua certa pro GATILHO; dentro de uma
 * decisão, não. Aqui é a completa — o censo é o lado estrito.
 * Achado pela revisão de segurança de 2026-09-13.
 */
const reDestinoQualquer = new RegExp(COMPOR.destino_em_qualquer_lugar_censo(G), 'i');
const reMarcador = new RegExp(G.marcador_de_lista);
/** Negador CONTRASTIVO: `não PRA casa` afirma; `não TEM` nega. Ver o gêmeo. */
const reContrasteColado = new RegExp(COMPOR.contraste_colado(G), 'i');
const reRegenciaDoNucleo = new RegExp(COMPOR.regencia_do_nucleo(G), 'i');
const reSujeitoNominal = new RegExp(COMPOR.sujeito_nominal(G), 'i');
/** Sujeito próprio em QUALQUER lugar do segmento — ver o gêmeo. */
const reSintagmaNominal = new RegExp(COMPOR.sintagma_nominal(G), 'i');
/** O sujeito que o veto da regra 1b existe pra proteger. Ver o gêmeo. */
const reNaoDinheiro = new RegExp(G.substantivo_nao_dinheiro, 'i');
const reDestAmbiguo = new RegExp(G.destinatario_ambiguo, 'gi');
/** O cômodo POSSUÍDO — a relação, não a palavra. Ver o gêmeo no Swift. */
const reAmbiguoPossuido = new RegExp(COMPOR.ambiguo_possuido(G), 'i');
const reEvasaoLicencia = new RegExp(COMPOR.evasao_que_licencia(G), 'i');
/** Burlar a FOLHA, sem os negadores nus — ver `_porque_evasao_de_folha`. */
const reEvasaoFolha = new RegExp(G.evasao_de_folha, 'i');
const rePalavraFuncional = new RegExp(COMPOR.palavra_funcional(G), 'gdi');
/**
 * Entre o negador e o núcleo só há material FUNCIONAL? Ver o gêmeo no Swift.
 *
 * SUBTRAÇÃO, não contagem. A versão anterior somava os CARACTERES cobertos e
 * comparava com as LETRAS presentes, e as duas contas medem coisas
 * diferentes: `a gente` cobre 7 caracteres e traz 6 letras, `R$ 12,00` cobre
 * 8 e traz 4. Cada alternativa com espaço ou pontuação dentro vendia folga, e
 * folga aqui compra uma palavra de CONTEÚDO curta — `tem R$ 12,00 taxa pra`
 * dava 14 >= 14 e dizia que o negador alcançava o núcleo, com `taxa` no
 * caminho, que é justamente o que o `_porque_alcance_antes` diz que bloqueia.
 * A polaridade é fail-open (alcançar = negado = não recusa), então isso ficava
 * entre um teste de negação e um escape. Achado pela revisão de compliance de
 * 2026-09-14.
 */
function soFuncionalAteONucleo(vao) {
  const restante = [...vao];
  for (const m of vao.matchAll(rePalavraFuncional)) {
    const [ini, fim] = m.indices[1];
    for (let i = ini; i < fim; i += 1) restante[i] = ' ';
  }
  return !/[\p{L}\p{N}]/u.test(restante.join(''));
}
const reCabecaDirecional = new RegExp(COMPOR.cabeca_direcional(G), 'i');
/** A cabeça do caminho fraco com preposição GENITIVA. Ver o gêmeo. */
const reCabecaGenitiva = new RegExp(COMPOR.cabeca_genitiva(G), 'i');
/** A CABEÇA de destino — PREFIXO, não whitelist ancorada. Ver o gêmeo. */
const reCabeca = new RegExp(COMPOR.cabeca_de_destino(G), 'i');
const reCabecaForte = new RegExp(COMPOR.cabeca_forte(G), 'i');
const rePronomeSujeito = new RegExp(G.pronome_sujeito, 'gi');
const rePrepPronome = new RegExp(COMPOR.preposicao_regendo_pronome(G), 'i');
const reVerboFinito = new RegExp(G.verbo_finito, 'i');
const reRelativa = new RegExp(COMPOR.relativa_qualquer(G), 'gi');
const reGenitivoDescritivo = new RegExp(COMPOR.genitivo_descritivo(G), 'gi');
const reSeparadorCorte = new RegExp(G.separador_interno, 'i');
/** Abertura de cláusula ADVERSATIVA — ver o gêmeo no Swift. */
const reAdversativa = new RegExp(COMPOR.adversativa_inicial(G), 'i');

/**
 * Só o ÚLTIMO segmento do prefixo. Ver `_porque_prefixo_por_segmento` e o
 * gêmeo no Swift.
 */
function ultimoSegmento(prefixo) {
  let ini = 0;
  for (const m of prefixo.matchAll(new RegExp(G.separador_de_clausula, 'gi'))) {
    ini = m.index + m[0].length;
  }
  return prefixo.slice(ini);
}
/** O que sobra depois da CABEÇA, ou `null`. Ver o gêmeo no Swift. */
function restoDepoisDaCabeca(oracao) { return cabecaValida(reCabeca, oracao); }
/** A cabeça casa E o que vem antes não é outra oração. Ver o gêmeo no Swift. */
function cabecaValida(re, oracao) {
  const m = re.exec(oracao);
  if (!m) return null;
  // O prefixo é julgado por VERBO FINITO, no ÚLTIMO SEGMENTO — ver o gêmeo.
  if (reVerboFinito.test(ultimoSegmento(oracao.slice(0, m.index)))) return null;
  return oracao.slice(m.index + m[0].length);
}
/** O negador atrás resgata? ORDEM e ESCOPO — ver o gêmeo e `_porque_alcance`. */
function negadorResgata(antesDoNucleo, cauda) {
  const m = new RegExp(COMPOR.negador_colado(G), 'i').exec(cauda);
  if (!m) return false;
  const resto = cauda.slice(m.index + m[0].length);
  // Resgata se ALCANÇA a gorjeta, ou se não diz mais nada além do verbo que
  // nega. Sem adjacência nenhuma — ver o gêmeo no Swift.
  // ORDEM, de volta, com REGÊNCIA do núcleo — ver o gêmeo no Swift.
  // O QUE O NEGADOR PODE ESTAR NEGANDO É OUTRA LISTA. Aqui a polaridade é
  // fail-ABERTO — mais palavras, mais resgate, menos recusa —, e por isso o
  // detector (`substantivo_gorjeta`, que cresce livre) não serve.
  // Ver `_porque_nucleo_negavel`.
  if (reRegenciaDoNucleo.test(antesDoNucleo) && !reNegavel.test(resto)) return false;
  if (!reNegavel.test(resto) && !soFuncionalAteONucleo(resto)) return false;
  return !reContrasteColado.test(resto);
}
/** Os SEGMENTOS de uma oração — separador com a conjunção. Ver o gêmeo. */
function segmentos(oracao) {
  // `String.split` com um regex que CAPTURA insere as capturas no resultado, e
  // o `separador_de_clausula` tem `\b(e sim|e|mas|por[ée]m|ou)\b`: o censo
  // ganhava segmentos extras com a conjunção nua, e o gêmeo Swift — que fatia
  // entre casamentos — não. Inerte hoje (são todas palavras funcionais, sem
  // destinatário e sem verbo), mas é divergência estrutural na função em que a
  // herança da coordenação mora. Apontado pela revisão de segurança.
  const re = new RegExp(G.separador_de_clausula, 'gi');
  const fora = [];
  let ini = 0;
  for (const m of oracao.matchAll(re)) {
    fora.push(oracao.slice(ini, m.index));
    ini = m.index + m[0].length;
  }
  fora.push(oracao.slice(ini));
  return fora.filter((x) => x && x.trim());
}
/** Ênfase de markdown e forma composta saem antes do julgamento. Ver o gêmeo. */
function normalizado(texto) {
  return texto.normalize('NFC').replace(/[*_`~]+/g, '');
}
/** O resto traz PREDICAÇÃO NOVA? Ver `_porque_predicacao` e o gêmeo no Swift. */
function temSujeitoNominal(trecho) {
  // A POSIÇÃO DO GRUPO 1, lida do próprio casamento — o gêmeo Swift usa
  // `m.range(at: 1).location` e aqui se procurava o texto do determinante
  // DENTRO do casamento com `indexOf`. Concordavam em tudo que se testou, e
  // divergiriam na primeira vez que o texto do determinante aparecesse
  // também no delimitador da esquerda. Havia ainda um `const p` calculado por
  // uma terceira fórmula e nunca usado. Apontado pela revisão de segurança de
  // 2026-09-14.
  for (const m of trecho.matchAll(new RegExp(COMPOR.sujeito_nominal(G), 'gdi'))) {
    if (!rePrepPronome.test(trecho.slice(0, m.indices[1][0]))) return true;
  }
  return false;
}
function temSujeitoSolto(trecho) {
  for (const m of trecho.matchAll(rePronomeSujeito)) {
    const p = m.index + m[0].length - m[1].length;
    if (!rePrepPronome.test(trecho.slice(0, p))) return true;
  }
  return false;
}
function temPredicacao(resto) {
  const semRelativa = resto.replace(reRelativa, ' ');
  if (reVerboFinito.test(semRelativa)) return true;
  return temSujeitoSolto(semRelativa);
}
/** Destinatário que NÃO é genitivo descritivo. Ver o gêmeo no Swift. */
function destinatarioNaoAtributivo(oracao, clausula) {
  // Evasão cancela a leitura benigna, e é lida na ORAÇÃO — ver o gêmeo.
  if (reRevoga.test(clausula || oracao)) return reDestinatarioCenso.test(oracao);
  return reDestinatarioCenso.test(oracao.replace(reGenitivoDescritivo, ' '));
}
/** Ver `_porque_quantidade` no claims.json — inclui MOEDA. */
const reQuantidade = new RegExp(G.quantidade, 'i');
/**
 * O CENSO DE BUILD USA A LISTA COMPLETA, e é assim que tem que ser: "a gorjeta
 * vai direto pra gente" na boca de um GARÇOM é a afirmação proibida, e é a
 * cópia do produto que este censo governa. A lista curta é do runtime, onde
 * "a gente" são as pessoas da mesa.
 *
 * A divergência que a revisão achou — "não fica com a cozinha, fica com o
 * garçom" recusada pelo guarda e aceita pelo censo, porque `cozinha` só existe
 * na lista completa e virava o terminador que engolia o `não` — não vinha da
 * LISTA e sim do `nega`, que olhava só o PRIMEIRO destinatário. Com todos, os
 * dois lados concordam usando cada um a sua lista, e é o
 * `afirmacoes.fixture.json` que prova, caso a caso.
 */
// O NOME DIZIA `RUNTIME` E O VALOR ERA A LISTA DO CENSO. O guarda de runtime
// usa a lista CURTA (`substantivo_destinatario_runtime`); aqui a lista é a
// LONGA, dentro da mesma decisão. Os dois lados concordam caso a caso — é o
// `afirmacoes.fixture.json` que prova —, mas o nome prometia identidade onde
// há divergência deliberada, e essa é a forma exata de mentira que este
// arquivo persegue. Renomeado na revisão de compliance de 2026-09-14.
const reDestinatarioCenso = reDestinatario;

/** Orações, como no guarda de runtime: `. ; ! ? : \n —` separam. */
function oracoes(texto) {
  // Ponto entre DÍGITOS não fecha oração — ver `_porque_separador_de_oracao`.
  return texto.split(new RegExp(G.separador_de_oracao, 'g')).map((o) => o.trim()).filter(Boolean);
}

/**
 * A oração NEGA o destino? A MESMA regra do guarda de runtime — ver o
 * `afirmacoes.fixture.json`, que é o que impede as duas de divergirem outra
 * vez. Percorre TODOS os destinatários: negar um e afirmar outro na mesma
 * oração ("não fica com o salão, fica com o garçom") é afirmação.
 */
function nega(oracao) {
  const dests = [...oracao.matchAll(new RegExp(reDestinatarioCenso.source, 'gi'))];
  if (!dests.length) return false;
  const gorjetas = [...oracao.matchAll(new RegExp(reGorjeta.source, 'gi'))];
  const direcionais = [...oracao.matchAll(new RegExp(reSuprimeGlobal.source, 'gi'))];
  const seps = [...oracao.matchAll(reSeparador)];
  let anterior = 0;
  for (const d of dests) {
    // A janela virou o PREFIXO inteiro — ver o gêmeo no Swift.
    // O separador interno voltou — ver o gêmeo no Swift.
    let ini = anterior;
    for (const sp of seps) {
      if (sp.index >= anterior && sp.index + sp[0].length <= d.index) {
        ini = Math.max(ini, sp.index + sp[0].length);
      }
    }
    const vao = oracao.slice(ini, d.index);
    const mNeg = new RegExp(reNegador.source, 'i').exec(vao);
    const antes = mNeg ? soFuncionalAteONucleo(vao.slice(mNeg.index + mNeg[0].length)) : false;
    // E o negador pode vir DEPOIS do destinatário, colado no verbo — "o garçom
    // NÃO fica com a gorjeta" é a resposta certa. Limite: o próximo separador.
    const fim = seps.find((sp) => sp.index >= d.index + d[0].length);
    const ateOnde = fim ? fim.index : oracao.length;
    // COLADO no destinatário, e sem `sem`: a cauda da própria frase virava
    // negação da promessa que ela acabara de fazer. Ver o gêmeo no Swift.
    // O negador atrás só resgata se for negação DE VERDADE: `não PRA casa`
    // retira o outro destino e AFIRMA este. Ver `_porque_contrastiva`.
    const cauda = ateOnde > d.index + d[0].length
      ? oracao.slice(d.index + d[0].length, ateOnde) : '';
    const depois = negadorResgata(oracao.slice(0, d.index), cauda);
    if (!antes && !depois) return false;
    anterior = d.index + d[0].length;
  }
  return true;
}

/** O distribuidor resgata SÓ se vier antes do destinatário. Ver o gêmeo. */
function distribuidorAntesDoDestino(oracao) {
  if (!temDistribuidor(oracao)) return false;
  const dest = new RegExp(reDestinatarioCenso.source, 'i').exec(oracao);
  if (!dest) return true;
  const dist = new RegExp(reDistribuidor.source, 'i').exec(oracao);
  return !dist || dist.index < dest.index;
}

/**
 * O segmento é uma FRASE DE DESTINO — cabeça de destino, sem verbo no prefixo
 * e sem predicação no resto? É a mesma pergunta do caminho fraco da regra 3,
 * reusada onde a regra 1 precisa atravessar segmento. Ver o gêmeo no Swift.
 */
function fraseDeDestino(seg) {
  const m = reCabeca.exec(seg);
  if (!m) return false;
  if (reVerboFinito.test(ultimoSegmento(seg.slice(0, m.index)))) return false;
  // O QUE VEM DEPOIS DA CABEÇA NÃO DESFAZ A PROMESSA — é a doutrina do CDC
  // art. 30 que a regra 1b já aplica: a primeira metade vincula. `a caixinha,
  // dos atendentes do salão São R$ 1.250,00 no total.` tem a promessa inteira
  // no segmento e uma frase NOVA colada atrás dela, sem pontuação no meio, e
  // exigir resto-sem-predicação deixava a frase aposentada passar. O que
  // desqualifica é verbo no PREFIXO (a promessa nunca começou) ou predicação
  // DENTRO da cabeça. Achado pelo `RachaTests`, 2026-09-14.
  return !temPredicacao(m[0]);
}

/** Esta oração carrega, ELA MESMA, a cláusula do distribuidor não negada? */
function temDistribuidor(oracao) {
  for (const m of oracao.matchAll(new RegExp(reDistribuidor.source, 'gi'))) {
    // A janela é a ORAÇÃO, não ±30 caracteres — ver o gêmeo no Swift.
    if (!reRevoga.test(oracao)) return true;
  }
  return false;
}

/**
 * A regra, e ela é a MESMA do guarda de runtime — provado pelo fixture
 * compartilhado, não por comparar strings de padrão. O `mesmaRegraDoCenso`
 * comparava os PADRÕES e não podia ver que os dois `nega` eram funções
 * diferentes; três pontos tinham divergido, um deles deixando o censo mais
 * frouxo que o runtime.
 */
function acusa(janelaCrua) {
  let janela = janelaCrua;
  // A pré-condição não pede mais o substantivo da gorjeta — ver o gêmeo.
  janela = normalizado(janela);
  if (!reDestinatarioCenso.test(janela)) return false;
  let partes = oracoes(janela);
  // UMA ORAÇÃO ABERTA POR ADVERSATIVA CONTINUA A ANTERIOR. `O restaurante
  // distribui a gorjeta à equipe, mas não pela folha.` é uma oração só, e a
  // evasão revoga a dispensa do distribuidor. Trocada a vírgula por travessão,
  // dois-pontos, ponto-e-vírgula ou quebra de linha — quatro sinais que um
  // modelo usa pelo mesmo motivo —, o `mas não pela folha` virava oração
  // separada, a revogação deixava de ser lida e a promessa proibida passava
  // com a qualificação colada. Uma cláusula aberta por `mas` não é uma
  // afirmação nova; ela QUALIFICA a anterior, e é o mesmo argumento do CDC
  // art. 30 que o resto do arquivo usa. Achado pelo eixo de RE-SEGMENTAÇÃO.
  const comAdversativa = (i) => partes[i]
    + (reAdversativa.test(partes[i + 1] || '') ? ` ${partes[i + 1]}` : '');
  for (const [iO, o] of partes.entries()) {
    // A dispensa do distribuidor vale no SEGMENTO dele — ver o gêmeo.
    if (reGorjeta.test(o)) {
      // Coordenação herda o distribuidor; a relativa não dispensa — ver o gêmeo.
      let distribuidorAnterior = false;
      for (const seg of segmentos(o)) {
        const matriz = seg.replace(reRelativa, ' ');
        const temDist = reDistribuidor.test(matriz);
        const temVerbo = reVerboFinito.test(seg) || reSuprimeGlobal.test(seg);
        // A HERANÇA DA COORDENAÇÃO FALHA FECHADO. Ela dizia `segmento sem
        // verbo CONHECIDO é continuação do anterior`, e verbo desconhecido
        // virava continuação: `O restaurante distribui à equipe e a gorjeta
        // PERTENCE ao garçom.` passava, e `pertence`, `beneficia`,
        // `destina-se` e `cabe` são exatamente os verbos que o
        // `distribuidorAntesDoDestino` cita como o motivo de este arquivo ter
        // parado de enumerar conectivo. A regra 9 do `SystemPrompt` MANDA o
        // modelo escrever a metade esquerda, então a frase mais provável do
        // produto dava carimbo a qualquer coisa coordenada depois dela.
        // Agora a continuação exige evidência POSITIVA: um segmento com
        // sujeito NOMINAL próprio é afirmação nova, não continuação.
        // Achado pela revisão de segurança de 2026-09-14.
        const dispensa = temDist
          || (!temVerbo && !reSintagmaNominal.test(seg) && distribuidorAnterior);
        if (temVerbo || temDist) distribuidorAnterior = temDist;
        if (!destinatarioNaoAtributivo(seg, o)) continue;
        // A REGRA 1 ATRAVESSA SEGMENTO SÓ SE O SEGMENTO FOR FRASE DE DESTINO.
        //
        // Ela perguntava se o TOKEN do destinatário está no segmento, e nunca
        // se ele está numa RELAÇÃO de destino — e é por isso que juntar duas
        // frases numa oração produzia recusa: `Já tirei o serviço, chama o
        // atendente que ele confere.` confirma que o serviço SAIU, e o guarda
        // pisava justamente nessa confirmação (CDC, inegociável #3). Vinte e
        // duas variantes do eixo de RE-SEGMENTAÇÃO eram essa classe, e eu
        // tinha escrito que a única alternativa era a vírgula deixar de
        // juntar — o que reabriria `A gorjeta, pro garçom.`, a promessa mais
        // curta do arquivo. Era falsa dicotomia: a regra 3 já tem a pergunta.
        // No MESMO segmento nada muda. Achado pela revisão de compliance.
        if (!reGorjeta.test(seg) && !fraseDeDestino(seg)) continue;
        if (!nega(o) && (reRevoga.test(comAdversativa(iO)) || !dispensa)) return true;
      }
    }
  }
  for (const o of partes) {
    // Contexto de dinheiro para a regra 1b — ver o gêmeo no Swift.
    const mDir = new RegExp(reSuprimeGlobal.source, 'i').exec(o);
    if (!mDir) continue;
    // O GENITIVO DESCRITIVO dispensa aqui TAMBÉM. `A gorjeta arrecadada é
    // remuneração da equipe` diz DE QUEM o dinheiro é, não pra onde vai, e é
    // a frase que o produto tem que poder dizer. A regra 1 já perguntava
    // isso; a 1b nunca perguntou — o veto de sujeito respondia por ela, por
    // acidente, e o acidente apareceu quando o veto foi restringido.
    if (!destinatarioNaoAtributivo(o, null)) continue;
    // Sujeito NOMINAL que não é a gorjeta veta; prefixo julgado, não contado;
    // destinatário que também é cômodo não basta na evidência mais fraca.
    // O PREFIXO DA 1B TAMBÉM É O ÚLTIMO SEGMENTO. `A conta fechou, vai tudo
    // pro garçom.` recusa; trocada a vírgula por ` e `, o sujeito `A conta`
    // passava a caber no teste ancorado, `conta` está no
    // `substantivo_nao_dinheiro`, e o veto desligava a regra. O sujeito que
    // interessa é o DESTA cláusula, não o da frase inteira — a mesma
    // doutrina do `_porque_prefixo_por_segmento`, na regra que a inventou.
    const prefixo = ultimoSegmento(o.slice(0, mDir.index));
    // O sujeito pode ser o dinheiro por outro nome — ver o gêmeo no Swift.
    const prefixoSemGorjeta = prefixo.replace(new RegExp(reGorjeta.source, 'gi'), ' ')
      .replace(new RegExp(COMPOR.anafora_de_dinheiro(G), 'gi'), ' ');
    // O VETO SÓ VALE ONDE ELE NÃO PODE ESCONDER UMA PROMESSA. A enumeração
    // do dinheiro estava com a polaridade virada pro escape: palavra de
    // dinheiro que a lista não conhece (`comissão`, `acréscimo`, `agrado`)
    // ficava no prefixo, virava `outro assunto`, e vetava a regra 1b. Numa
    // janela que FALA de dinheiro, o veto agora só vale pra um sujeito
    // NOMEADO como não-dinheiro — desconhecido significa recusa, que é a
    // polaridade que este arquivo exige. Fora de janela de dinheiro o veto
    // vale inteiro, e é lá que mora `A comanda vai pro garçom conferir.`
    // Ver o gêmeo no Swift e `_porque_veto_por_contexto`.
    const contextoDeDinheiro = reGorjeta.test(janela) || reQuantidade.test(janela);
    if (temSujeitoNominal(prefixoSemGorjeta)
      && (!contextoDeDinheiro || reNaoDinheiro.test(prefixo))) continue;
    // Um cômodo pode ser DESTINO DE MOVIMENTO e não pode ser DONO de
    // dinheiro. `Vai pra cozinha` é ambíguo; `Fica com o salão` e `É da copa`
    // não são — ver o gêmeo no Swift e `_porque_ambiguo`.
    const soAmbiguo = new RegExp(G.destinatario_ambiguo, 'i').test(o)
      && !reDestinatarioCenso.test(o.replace(reDestAmbiguo, ' '))
      && !reAmbiguoPossuido.test(o);
    const comecaNaForma = !temSujeitoNominal(prefixoSemGorjeta) && !soAmbiguo;
    if ((contextoDeDinheiro || comecaNaForma) && !nega(o)) return true;
  }
  // Sem retorno precoce: a regra 1 ABSOLVE a oração que traz o distribuidor, e
  // essa absolvição voltava `false` pro texto inteiro, cancelando a regra 3
  // pras outras orações. Ver o comentário gêmeo no RevisaoDeAfirmacoes.swift.
  // Sem retorno precoce pela negação: uma oração negando em qualquer lugar
  // desligava a regra 3 pro texto inteiro, e o assunto faz do prefixo negativo
  // a abertura mais provável. A negação é julgada por ORAÇÃO no laço.
  // TODAS as orações com destinatário, não a primeira: uma frase inocente na
  // frente ("A equipe da mesa 7 já fechou.") capturava o índice e desarmava a
  // classe inteira. Mesma forma "só o primeiro" que o `nega` já tinha tido.
  const iDest = -1;   // âncora do portão de mutação; ver mutacoes-afirmacao.test.js
  void iDest;
  for (let i = 0; i < partes.length; i += 1) {
    const o = partes[i];
    if (!reDestinatarioCenso.test(o) || !reDestinoQualquer.test(o) || nega(o)) continue;
    // O corte no separador vale SÓ no caminho forte — ver `_porque_corte`.
    // Caminho FORTE: quantidade consumida pela cabeça — ver o gêmeo.
    if (cabecaValida(reCabecaForte, o) !== null) return true;
    // Evidência fraca (quantidade só na oração anterior): a oração tem que ser
    // a frase de destino e MAIS NADA. Ver `_porque_dois_niveis`.
    // Caminho FRACO: cabeça ancorada e DIRECIONAL — ver o gêmeo no Swift.
    // Pista de EVASÃO vale como direcionalidade — ver o gêmeo no Swift.
    // O distribuidor dispensa no caminho FRACO, e só nele — ver o gêmeo.
    if (temDistribuidor(o) && !reRevoga.test(o)) continue;
    // A PISTA DE EVASÃO VALE PELA JANELA, não pela oração. Ela é uma
    // qualificação do caminho do dinheiro, e uma qualificação mora onde o
    // ritmo da frase a puser: `Com a equipe, sem passar pela casa.` vira
    // `Com a equipe — sem passar pela casa.` e a pista muda de oração, com o
    // mesmo sentido e outro veredito. A licença continua a ESTRITA
    // (substantivo da gorjeta numa oração anterior), que é o que impede
    // `Sua parte é R$ 61,00.⏎Com o garçom, em dinheiro.` de virar recusa.
    // Achado pelo eixo de RE-SEGMENTAÇÃO, 2026-09-14.
    const comEvasao = reEvasaoLicencia.test(janela);
    let mFraco = (comEvasao ? reCabeca : reCabecaDirecional).exec(o);
    // Cabeça GENITIVA: `- da equipe`, `Da equipe.`, `— dos atendentes`. Ver o
    // gêmeo no Swift e `_porque_cabeca_genitiva`.
    let soGorjetaAntes = comEvasao;
    if (!mFraco) { mFraco = reCabecaGenitiva.exec(o); soGorjetaAntes = true; }
    if (!mFraco) continue;
    // Prefixo julgado por VERBO nos dois caminhos — ver o gêmeo.
    // O VERBO DO DISTRIBUIDOR NÃO DESQUALIFICA QUANDO A CLÁUSULA BURLA A
    // FOLHA. A evasão revoga a dispensa do distribuidor — e não adiantava
    // nada, porque logo depois este teste desqualificava a oração pelo verbo,
    // que é o verbo do próprio distribuidor. Duas peças certas, uma
    // cancelando a outra. Ver `_porque_evasao_de_folha`.
    const burlaFolha = reEvasaoFolha.test(o) && reDistribuidor.test(o);
    if (!burlaFolha && reVerboFinito.test(ultimoSegmento(o.slice(0, mFraco.index)))) continue;
    // E A CABEÇA NÃO PODE CONTER PREDICAÇÃO. Os slots de modificador somam até
    // cinco palavras entre a preposição e o núcleo, e um verbo finito cabe lá
    // com folga — ancorada no `^`, a cabeça deixa o prefixo VAZIO, e o teste de
    // prefixo, que existe pra desqualificar exatamente isso, não vê nada.
    // `Serviço: 10% no fim da conta você chama o garçom.` virava recusa: o
    // `^` que eu pus pra fechar essa frase por um lado abriu-a pelo outro.
    // Achado pela revisão de compliance de 2026-09-14.
    if (temPredicacao(mFraco[0])) continue;
    const resto = o.slice(mFraco.index + mFraco[0].length);
    if (temPredicacao(resto)) continue;
    if (!partes.slice(0, i).some((q) => soGorjetaAntes ? reGorjeta.test(q)
      : (reQuantidade.test(q) || reGorjeta.test(q)))) continue;
    // Nada resgata uma afirmação já feita — a mesma lógica da regra 1b, que a
    // regra 3 não aplicava: bastava ABRIR com a frase sancionada pra liberar o
    // `- 100% pro garçom` depois dela.
    return true;
  }
  return false;
}

// O PERÍMETRO É DECLARADO NO JSON, não em duas regexes no meio do teste.
// Ver `_porque_extensoes` e `_porque_diretorios_fora` no `claims.json`.
const EXT = new RegExp(`\\.(${G.onde_o_censo_anda.extensoes.join('|')})$`);
// Diretórios que não são superfície de ninguém. `.*Tests` entrou junto com o
// perímetro derivado: `RachaTests`/`RachaUITests` são código de teste pela
// mesma razão que `__tests__` já era, e escrevê-los na lista declarada seria
// declarar doze arquivos um a um pra dizer a mesma coisa.
const FORA = new RegExp(`^(${G.onde_o_censo_anda.diretorios_fora.join('|')})$`);

function anda(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(RAIZ, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (FORA.test(e.name)) continue;
      if (G.onde_o_censo_anda.docs_fora.includes(rel)) continue;
      anda(p, out);
    } else if (EXT.test(e.name) && !/\.test\./.test(e.name)
      // A isenção vale por ARQUIVO também. Escrita só no ramo do diretório,
      // as duas entradas de arquivo do `docs_fora` não faziam nada — eram
      // `.json`, que o `EXT` já descarta —, e o `_porque_docs_fora` anunciava
      // um mecanismo que não existia. Ramo morto sob comentário dizendo que
      // funciona. Achado pela revisão de compliance de 2026-09-14.
      && !G.onde_o_censo_anda.docs_fora.includes(rel)) out.push(p);
  }
  return out;
}

/**
 * TODO arquivo de extensão vigiada, a partir do raiz — a base do perímetro
 * DERIVADO. Ver `_porque_perimetro_derivado`: a prosa afirmava esta derivação
 * enquanto o teste andava só pelas árvores declaradas, e o buraco que ela dizia
 * ter fechado já tinha aparecido duas vezes (`ios/docs`, `.claude/agents`).
 */
function tudoNoRepo() { return anda(RAIZ); }

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

  /**
   * O PERÍMETRO É DERIVADO, e este é o teste que a prosa dizia existir.
   *
   * Andar do raiz e exigir que todo arquivo de extensão vigiada esteja numa de
   * três gavetas — dentro do censo, isento como ANÁLISE da proibição, ou
   * declarado fora com motivo. Enquanto o perímetro era uma lista que alguém
   * escrevia, ele esqueceu `ios/docs` numa rodada e `.claude/agents` na
   * seguinte; a segunda continha o arquivo que ENUNCIA as regras da gorjeta a
   * um agente, que é texto de prompt pela definição do próprio
   * `_escrevendo_proibicoes`. Achado pela revisão de compliance de 2026-09-14.
   */
  test('o perímetro é DERIVADO: todo arquivo está dentro, isento ou declarado', () => {
    const dentro = new Set(superficies().map(
      (f) => path.relative(RAIZ, f).split(path.sep).join('/')));
    const fora = G.onde_o_censo_anda.fora_do_perimetro || {};
    const docsFora = G.onde_o_censo_anda.docs_fora;
    const candidatos = tudoNoRepo()
      .map((f) => path.relative(RAIZ, f).split(path.sep).join('/'))
      .filter((rel) => !dentro.has(rel) && !(rel in fora)
        && !docsFora.some((d) => rel === d || rel.startsWith(`${d}/`)));
    // ARQUIVO IGNORADO PELO GIT NÃO É SUPERFÍCIE: é artefato de build, e ele
    // nem sequer PODE ser revisado, porque não está no repositório. Quem
    // pergunta é o git, não uma lista — `apps/web/public/ios.html` e
    // `ios/lab/preview.html` são gerados, e declará-los à mão seria a mesma
    // lista paralela que este teste existe pra eliminar.
    const ignorados = new Set(candidatos.length ? execFileSync(
      'git', ['check-ignore', '--stdin'],
      { cwd: RAIZ, input: candidatos.join('\n'), encoding: 'utf8' },
      // `check-ignore` sai com 1 quando NENHUM caminho é ignorado.
    ).split('\n').filter(Boolean) : []);
    const orfaos = candidatos.filter((rel) => !ignorados.has(rel));
    expect(orfaos).toEqual([]);
    // A gaveta declarada tem a disciplina das dispensas: motivo escrito, e
    // nada de entrada que já não existe.
    expect(Object.keys(fora).filter((f) => !fs.existsSync(path.join(RAIZ, f)))).toEqual([]);
    for (const [f, porque] of Object.entries(fora)) {
      expect(`${f}: ${porque}`).toMatch(/.{80,}/);
    }
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
    // TODOS os campos de padrão do JSON, descobertos — não uma lista fixa.
    // A lista fixa tinha seis nomes e não podia ver um sétimo, e foi assim que
    // seis padrões da DECISÃO ficaram escritos duas vezes à mão, fora do
    // gerador. Achado pela revisão de compliance de 2026-09-14.
    //
    // NÃO-PADRÕES SÃO DECLARADOS, não inferidos por tipo. O filtro
    // `typeof === 'string'` não enxergava campo de outro tipo: uma lista ou um
    // número novo entrava no JSON e ficava fora da cobertura sem ninguém ver.
    const NAO_SAO_PADRAO = [
      'guarda', 'porque', 'frase_sancionada', 'janela_linhas', 'onde_o_censo_anda',
      'destinatarios_so_deteccao', 'frases_aposentadas', 'frases_aprovadas', 'dispensas',
    ];
    // Padrão que é SÓ DO CENSO, com motivo escrito. Emitir pro Swift um padrão
    // que o guarda não consulta é o vão pelo qual o `preposicaoColadaAtras`
    // sobreviveu à própria remoção da regra.
    // Padrão que é SÓ DO CENSO, com motivo escrito. Emitir pro Swift um padrão
    // que o guarda não consulta é o vão pelo qual o `preposicaoColadaAtras`
    // sobreviveu à própria remoção da regra.
    //
    // A LISTA TINHA 25 NOMES E 23 ERAM FALSOS: aqueles campos SÃO emitidos e
    // SÃO consultados pelo guarda — o teste irmão (`todo padrão emitido é
    // consultado`) falharia se não fossem. A isenção não isentava nada de
    // verdade, mas desligava a asserção `o Swift contém este valor` pra 23
    // peças: se o gerador parasse de emitir uma delas, `npx jest` continuaria
    // verde e só o Xcode notaria. Uma lista de exceções que não descreve
    // exceção nenhuma é a forma "guarda que nunca dispara" aplicada a um
    // teste. Apontado pela revisão de compliance de 2026-09-14.
    const SO_DO_CENSO = [
      'substantivo_destinatario',   // a completa inclui os pronomes da MESA; o
                                    // runtime usa a curta, de propósito
      'modificador_longo',          // entra composto no `contraste_colado` e no
                                    // `regencia_do_nucleo`, nunca sozinho
      'nome_de_quantia',            // entra composto na `anafora_de_dinheiro`,
                                    // e lá com os diminutivos derivados junto
      'destino_em_qualquer_lugar_censo',  // a versão com a lista LONGA de
                                    // destinatário; o runtime usa a curta
    ];
    // O alfabeto de marcadores vem do PRÓPRIO gerador, não de uma lista escrita
    // aqui: marcador novo no `PECAS` fica coberto sem ninguém lembrar. A lista
    // fixa de seis nomes que não podia ver um sétimo é o defeito de round 11, e
    // escrevê-la de novo aqui seria reintroduzi-lo um nível acima. E é por isto
    // que a checagem não é `[A-Z]{3,}`: o `distribuidor_com_sujeito` diz `CNPJ`.
    const RESIDUO = new RegExp('\\b(' + Object.keys(PECAS(G)).join('|') + ')\\b');
    const camposDePadrao = Object.keys(G).filter((k) => !k.startsWith('_') && !NAO_SAO_PADRAO.includes(k));
    expect(camposDePadrao.length).toBeGreaterThanOrEqual(10);
    // A lista de exceções não pode envelhecer em silêncio e passar a isentar
    // um campo que não existe mais.
    expect(NAO_SAO_PADRAO.filter((k) => !(k in G))).toEqual([]);
    expect(SO_DO_CENSO.filter((k) => !(k in G))).toEqual([]);
    for (const campo of camposDePadrao) {
      expect(typeof G[campo]).toBe('string');
      // Marcador em caixa alta é campo COMPOSTO. Sem composição declarada, o
      // padrão sairia com o literal `MARCADOR` dentro e casaria a palavra.
      // A checagem é sobre a SAÍDA e não sobre uma lista de nomes: a lista de
      // nomes é o defeito de round 11 reintroduzido um nível acima.
      const composto = COMPOR[campo];
      // Marcador no valor cru = campo COMPOSTO. Sem composição declarada o
      // padrão sairia com o literal `MARCADOR` dentro e casaria a palavra —
      // falha aqui, não em silêncio no runtime.
      if (RESIDUO.test(G[campo])) expect(Object.keys(COMPOR)).toContain(campo);
      // E a saída composta não pode sobrar marcador nenhum: substituição
      // parcial (`MOD` comido pelo começo de `MARCADOR`, `PREP` pelo de
      // `PREPDEST`) sai calada e errada.
      if (composto) expect(RESIDUO.test(composto(G))).toBe(false);
      if (SO_DO_CENSO.includes(campo)) continue;
      const valor = composto ? composto(G) : G[campo];
      expect(swift).toContain(valor.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    }
  });

  /**
   * E O CAMINHO DE VOLTA: um padrão EMITIDO e nunca CONSULTADO é invisível.
   * O censo acima prova que todo campo do JSON chega ao Swift; não provava que
   * o guarda de runtime olha pra ele. `preposicaoColadaAtras` sobreviveu à sua
   * própria remoção da regra por esse vão.
   * Achado pela revisão de compliance de 2026-09-14.
   */
  test('todo padrão emitido é consultado pelo guarda de runtime', () => {
    const { gerar } = require('../../scripts/gen-claim-patterns.js');
    // SÓ O GUARDA. A primeira versão contava menção no arquivo de TESTE como
    // consulta, e já havia um órfão passando por essa porta: `soDeteccao` era
    // emitido pro binário e citado só por um teste. Um padrão que sobrevive à
    // remoção da sua regra com uma linha de teste é exatamente o defeito que
    // este portão foi escrito pra achar — o portão continha uma instância do
    // que proíbe. Achado pela revisão de segurança de 2026-09-14.
    const guarda = fs.readFileSync(path.join(
      __dirname, '..', '..', 'ios', 'Racha', 'Agent', 'RevisaoDeAfirmacoes.swift'), 'utf8');
    const emitidos = [...gerar().matchAll(/static let (\w+) =/g)].map((m) => m[1]);
    expect(emitidos.length).toBeGreaterThanOrEqual(10);
    const orfaos = emitidos.filter((n) => !guarda.includes('ClaimPatterns.' + n));
    expect(orfaos).toEqual([]);
  });

  /**
   * E A TERCEIRA VOLTA: uma PEÇA definida e nunca USADA.
   *
   * O `PECAS` é o alfabeto da composição, e os dois testes acima o usam como
   * ORÁCULO — o `RESIDUO` é construído a partir das chaves dele. Oráculo não é
   * medido por ninguém: uma chave que nenhum campo cita fica ali, engorda a
   * alternância do `RESIDUO`, e o dia em que o nome dela aparecer como palavra
   * dentro de um padrão qualquer ela passa a exigir composição de um campo que
   * não compõe nada. Medido na primeira execução: `GORJETANOME`, `MODLONGO` e
   * `NEGCOLADO` estavam no alfabeto sem UM consumidor — sobras de padrões
   * reescritos, três nomes a mais no oráculo que governa os outros dois testes.
   *
   * Achado pela revisão de compliance de 2026-09-15 (MEDIUM-4).
   */
  test('toda PEÇA do alfabeto de composição é consumida por algum padrão', () => {
    const pecas = PECAS(G);
    const crus = Object.keys(G)
      .filter((k) => !k.startsWith('_') && typeof G[k] === 'string')
      .map((k) => G[k]).join('\n');
    // Do nome mais longo pro mais curto, retirando cada ocorrência: senão
    // `PREPDEST` no texto contaria como uso de `PREP`, que é a mesma
    // substituição parcial que o `compor` ordena pra evitar.
    let resto = crus;
    const usadas = new Set();
    for (const nome of Object.keys(pecas).sort((a, b) => b.length - a.length)) {
      if (resto.includes(nome)) { usadas.add(nome); resto = resto.split(nome).join(''); }
    }
    const mortas = Object.keys(pecas).filter((n) => !usadas.has(n));
    expect(mortas).toEqual([]);
  });

  test('nenhuma PEÇA é sinônimo exato de outra', () => {
    // `DEST` e `DESTRUNTIME` são a MESMA lista sob dois nomes, e isso é
    // deliberado: os padrões antigos dizem `DEST` e os novos dizem qual das
    // duas listas querem. Declarado aqui porque um par novo não é.
    const IGUAIS_DE_PROPOSITO = [['DEST', 'DESTRUNTIME']];
    const pecas = PECAS(G);
    const nomes = Object.keys(pecas);
    const pares = [];
    for (let i = 0; i < nomes.length; i += 1) {
      for (let j = i + 1; j < nomes.length; j += 1) {
        if (pecas[nomes[i]] === pecas[nomes[j]]) pares.push([nomes[i], nomes[j]].sort());
      }
    }
    const declarados = IGUAIS_DE_PROPOSITO.map((p) => [...p].sort().join('+'));
    expect(pares.map((p) => p.join('+')).filter((p) => !declarados.includes(p))).toEqual([]);
    // Declaração morta é declaração que passa a isentar o próximo par.
    expect(declarados.filter((d) => !pares.some((p) => p.join('+') === d))).toEqual([]);
  });
});

/**
 * OS FALSOS POSITIVOS QUE A GENTE CONHECE E ESCOLHEU PAGAR.
 *
 * A lista de destinatário falha FECHADO por desenho: token a mais custa falso
 * positivo, nunca escape. Isso é a decisão certa e não é de graça, e o preço
 * vinha sendo pago em prosa — um parágrafo de `_porque` dizendo "esta frase
 * vira recusa", sem nada que o verificasse. Prosa não mede: a frase muda, o
 * parágrafo fica, e a declaração passa a descrever um preço que já não existe
 * (ou a esconder um que cresceu).
 *
 * Aqui cada frase é EXECUTADA. Ela tem que estar recusada HOJE — do contrário a
 * entrada é ficção, e uma gaveta com entrada morta vira perdão permanente. E
 * quando alguém consertar uma delas, este teste falha alto e a entrada sai da
 * gaveta pela porta da frente, em vez de apodrecer nela.
 *
 * Escrito junto com o `_porque_personal`, na revisão de segurança de
 * 2026-09-15 (LOW-1).
 */
describe('os falsos positivos declarados ainda são falsos positivos', () => {
  const FP = G._falsos_positivos_conhecidos || {};

  test('a gaveta não está vazia nem é prosa curta', () => {
    expect(Object.keys(FP).length).toBeGreaterThanOrEqual(2);
    for (const [frase, porque] of Object.entries(FP)) {
      expect(`${frase}: ${porque}`).toMatch(/.{200,}/);
    }
  });

  test.each(Object.keys(FP))('ainda recusa: %s', (frase) => {
    // Recusada AINDA — se passou a passar, o preço deixou de existir e a
    // declaração tem que ser removida, não mantida por inércia.
    expect(acusa(frase)).toBe(true);
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

describe('o censo de build e o guarda de runtime aplicam a MESMA regra', () => {
  /**
   * Os PADRÕES já vinham de uma fonte só; a LÓGICA em volta deles não vinha, e
   * divergiu em três pontos — num deles o censo ficou MAIS FROUXO que o
   * runtime, que é a direção que o gerador existe pra impedir, no guarda que
   * governa o roteiro IMPRESSO entregue ao garçom. `mesmaRegraDoCenso`
   * comparava strings de padrão e não podia ver que os dois `nega` eram
   * funções diferentes.
   *
   * `docs/compliance/afirmacoes.fixture.json` é o corpo compartilhado: as duas
   * implementações rodam contra ele, com o mesmo veredito exigido dos dois
   * lados. Mesma forma do `documentos.fixture.json`.
   */
  const F = JSON.parse(fs.readFileSync(
    path.join(RAIZ, 'docs', 'compliance', 'afirmacoes.fixture.json'), 'utf8'));

  test('cada caso do fixture dá o veredito que o fixture diz', () => {
    const divergiram = F.casos
      .filter((c) => acusa(c.texto) !== c.recusa)
      .map((c) => `${c.recusa ? 'ESCAPOU' : 'FALSO POSITIVO'}: ${c.texto.replace(/\n/g, '⏎').slice(0, 70)}`);
    expect(divergiram).toEqual([]);
  });

  test('o fixture cobre os dois vereditos e não encolhe', () => {
    expect(F.casos.filter((c) => c.recusa).length).toBeGreaterThanOrEqual(18);
    expect(F.casos.filter((c) => !c.recusa).length).toBeGreaterThanOrEqual(10);
    // Razão escrita em cada caso: o fixture é a afirmação de que alguém leu.
    expect(F.casos.filter((c) => !c.porque || c.porque.length < 30)).toEqual([]);
  });
});

/**
 * AS DUAS CÓPIAS DO CONTRATO NÃO PODEM DIVERGIR.
 *
 * O `AGENTS.md` é a cópia que as ferramentas que leem `AGENTS.md` carregam no
 * lugar do `CLAUDE.md`, e no commit que o criou ela JÁ tinha divergido: o
 * parágrafo do portão de duas assinaturas — justamente o que registra que o
 * `security-reviewer` foi nomeado por meses sem existir — saiu truncado, e o
 * caminho do documento de estratégia virou `.Codex/plans/`, que não existe.
 * Regra copiada em dois lugares diverge, e a cópia que vale é a da ferramenta
 * que lê: é o modo de falha nomeado deste repositório, aplicado às próprias
 * regras. Apontado pela revisão de segurança de 2026-09-14.
 *
 * A única diferença LEGÍTIMA é onde vivem as definições dos agentes.
 */
describe('as duas cópias do contrato são a mesma', () => {
  test('AGENTS.md é o CLAUDE.md com a substituição declarada, e nada mais', () => {
    const claude = fs.readFileSync(path.join(RAIZ, 'CLAUDE.md'), 'utf8');
    const agents = fs.readFileSync(path.join(RAIZ, 'AGENTS.md'), 'utf8');
    expect(agents).toBe(claude.split('.claude/agents/').join('.codex/agents/'));
  });
});
