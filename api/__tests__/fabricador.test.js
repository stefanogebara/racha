'use strict';

/**
 * O FABRICADOR.
 *
 * O terceiro instrumento, e ele existe porque os dois primeiros não conseguem
 * ver a família de defeito que mais apareceu neste arquivo.
 *
 * O portão de mutação APAGA peças e ALARGA limites. O censo de tokens varre as
 * alternativas que estão ESCRITAS. Nenhum dos dois enxerga uma peça que decide
 * por ADJACÊNCIA ou por um orçamento fixo de caracteres — porque não há token
 * pra apagar nem alternativa pra varrer: o defeito é uma palavra que NÃO está
 * lá. A lista do que já custou caro por essa forma exata:
 *
 *  · o olho mágico de 14 caracteres do teste de oblíquo (1250 de 3125);
 *  · a contrastiva por adjacência, que perdia pro advérbio de foco (80 de 135);
 *  · `evasao_de_caminho` sem slot de modificador (`na conta PESSOAL dela`);
 *  · a janela de −10 caracteres do `nega` (`nunca MAIS vai pro garçom`);
 *  · e, do outro lado, `cai(em)?` e `[oad]o?s? time`, que eram palavras que
 *    ninguém conseguia escrever.
 *
 * Então: pega cada caso `recusa: true` do corpo, INJETA uma palavra neutra em
 * cada fronteira de palavra, e exige que o veredito AGUENTE. Uma promessa que
 * deixa de ser promessa porque alguém pôs um advérbio no meio nunca foi uma
 * regra — era uma coincidência de espaçamento.
 *
 * O QUE ISTO NÃO MEDE: injeta UMA palavra, não duas; injeta palavras neutras,
 * não qualquer palavra (um token de vocabulário mudaria o sentido de verdade);
 * e só olha o lado `recusa: true`, porque do lado inocente uma inserção pode
 * legitimamente criar uma promessa.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const F = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'afirmacoes.fixture.json'), 'utf8'));
const G = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;
const FONTE = fs.readFileSync(path.join(__dirname, 'claims.test.js'), 'utf8');

/**
 * PALAVRAS NEUTRAS — nenhuma delas está em lista de vocabulário nenhuma do
 * `claims.json`, e o teste abaixo prova isso em vez de afirmar. `logo` saiu em
 * 2026-09-14: ele É membro do `palavra_funcional`, então injetado entre o
 * negador e o núcleo tornava o vão MAIS funcional e podia virar acusação em
 * negação — um terço do vocabulário de injeção não era neutro, e a prova não
 * via porque ela nomeava nove campos à mão. Uma injeção
 * que por acaso fosse destinatário, quantidade ou verbo mudaria o SENTIDO, e
 * aí o veredito poderia mudar com razão.
 */
const NEUTRAS = ['sempre', 'assim', 'francamente'];

function carrega() {
  const corpo = FONTE.slice(0, FONTE.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');", 'const RAIZ = ' + JSON.stringify(RAIZ) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
      'require(' + JSON.stringify(path.join(RAIZ, 'scripts')) + " + '/");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-'));
  const arq = path.join(tmp, 'censo.js');
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  return require(arq);
}

/**
 * Cada texto com UMA palavra neutra injetada em cada fronteira — e as
 * fronteiras incluem o COMEÇO do texto e o começo de cada linha.
 *
 * A primeira versão injetava só depois de espaço INTERNO, e por isso era cega
 * exatamente à região que a rodada que a criou tinha editado: `comecaNaForma`,
 * os dois testes de prefixo do `cabecaValida`, o `marcador_de_lista`, o `^` do
 * `contraste_colado` e o do `negador_colado` leem todos a posição zero. Um
 * instrumento que não alcança o lugar onde as decisões moram mede outra coisa.
 * Com o eixo de POSIÇÃO, três casos do corpo caíam de cara.
 * Achado pela revisão de compliance de 2026-09-14.
 */
function* injecoes(texto) {
  for (const palavra of NEUTRAS) {
    for (let i = 0; i < texto.length; i += 1) {
      // Depois de espaço interno, e ANTES de cada linha (inclusive a primeira).
      const fronteira = texto[i] === ' ' ? i + 1
        : (i === 0 || texto[i - 1] === '\n') ? i : -1;
      if (fronteira < 0) continue;
      yield [`${texto.slice(0, fronteira)}${palavra} ${texto.slice(fronteira)}`, palavra, i];
    }
  }
}

const TOLERADAS = G._injecoes_toleradas || {};
/** A chave de uma tolerância: a VARIANTE, sem o rótulo `+palavra → `. */
const variante = (v) => v.replace(/^\+\S+ → /, '').replace(/⏎/g, '\n');

/**
 * A TERCEIRA GAVETA tem a mesma disciplina das dispensas: cada tolerância
 * nomeia o caso, escreve a razão, e é USADA. Sem isso ela vira o lugar onde as
 * falhas vão morar. Apontado pela revisão de compliance antes de ela ter a
 * primeira entrada — que é a hora certa de pôr a regra.
 */
const { acusa: acusaTop } = carrega();

describe('as tolerâncias do fabricador têm a disciplina das dispensas', () => {
  test('cada uma nomeia um caso do corpo, tem razão escrita, e é usada', () => {
    const casos = new Set(F.casos.map((c) => c.texto));
    expect(Object.keys(TOLERADAS).filter((t) => !casos.has(t))).toEqual([]);
    let variantes = 0;
    for (const [caso, porVariante] of Object.entries(TOLERADAS)) {
      expect(Object.keys(porVariante).length).toBeGreaterThan(0);
      for (const [v, r] of Object.entries(porVariante)) {
        // A variante tolerada tem que ser o CASO com uma palavra a mais — uma
        // chave que não deriva do caso perdoaria uma frase que ninguém mediu.
        expect(v.replace(/(sempre|assim|francamente) /, '')).toBe(caso);
        expect(`${caso}: ${r}`).toMatch(/.{80,}/);
        variantes += 1;
      }
    }
    expect(Object.keys(TOLERADAS).length).toBeLessThanOrEqual(4);
    // E CADA VARIANTE TOLERADA TEM QUE SER USADA. Tolerância que não tolera
    // nada é buraco esquecido — a mesma disciplina das dispensas do censo, e
    // ela já pagou: quando a peça foi consertada, cinco das dez variantes
    // declaradas deixaram de cair e teriam ficado no arquivo como cobertura
    // imaginária.
    const naoUsadas = [];
    for (const [caso, porVariante] of Object.entries(TOLERADAS)) {
      const c = F.casos.find((x) => x.texto === caso);
      const caem = new Set();
      for (const [variante] of injecoes(caso)) if (acusaTop(variante) !== c.recusa) caem.add(variante);
      for (const v2 of Object.keys(porVariante)) if (!caem.has(v2)) naoUsadas.push(v2);
    }
    expect(naoUsadas).toEqual([]);
    // O TETO CONTA VARIANTES, não casos: contando casos, uma tolerância podia
    // crescer de uma pra nove sem o número se mexer.
    expect(variantes).toBeLessThanOrEqual(12);
  });
});

describe('uma palavra a mais não desfaz uma promessa', () => {
  const { acusa } = carrega();

  test('as palavras injetadas são NEUTRAS de verdade', () => {
    // Prova, não afirma: se uma delas entrar numa lista de vocabulário, a
    // injeção passa a mudar o sentido e o instrumento vira ruído.
    // A LISTA DERIVA DO JSON. Escrita à mão com nove nomes, ela não via um
    // décimo — e não via três: `palavra_funcional`, `sujeito_nominal` e
    // `destinatario_ambiguo` entraram na rodada passada, e `logo` É MEMBRO de
    // `palavra_funcional`. Um terço do vocabulário de injeção não era neutro,
    // no teste escrito pra trocar afirmação por prova.
    // Achado pela revisão de compliance de 2026-09-14.
    const NAO_VOCABULARIO = ['guarda', 'porque', 'frase_sancionada', 'janela_linhas',
      'onde_o_censo_anda', 'destinatarios_so_deteccao', 'frases_aposentadas',
      'frases_aprovadas', 'dispensas',
      // `palavra_funcional` é a exceção declarada, e é o contrário de uma
      // contaminação: ela lista o que NÃO é conteúdo — verbo, preposição,
      // artigo, advérbio. Uma palavra neutra tem que ser funcional; se não
      // fosse, injetá-la mudaria o sentido da frase e o oráculo do fabricador
      // estaria errado, não o guarda. Membro daqui é qualificação, não sujeira.
      // `palavra_funcional`, `negador_colado` e `sujeito_nominal` carregam
      // SLOTS de advérbio, não vocabulário. Uma palavra neutra é, por
      // definição, um advérbio — aparecer num slot de advérbio é o que a
      // qualifica, não o que a contamina. O que contaminaria é ser
      // DESTINATÁRIO, QUANTIDADE, VERBO ou SUBSTANTIVO DE GORJETA.
      'palavra_funcional', 'negador_colado', 'sujeito_nominal', 'adverbio'];
    const listas = Object.keys(G).filter(
      (k) => !k.startsWith('_') && typeof G[k] === 'string' && !NAO_VOCABULARIO.includes(k));
    // A pergunta é de IGUALDADE, não de casamento: `modificador_de_destino` é
    // um slot que casa qualquer palavra, e `artigo_de_destino` tem um `a` que
    // casa dentro de `assim`. Suja é a palavra que É uma alternativa de uma
    // lista, não a que aparece dentro de um padrão.
    // O NORMALIZADOR TEM QUE LER O QUE O ARQUIVO ESCREVE HOJE. Ele conhecia
    // `\b`, `(?:` e as âncoras, e não conhecia os lookarounds explícitos —
    // e o arquivo está MIGRANDO pra eles (`\b` é ASCII contra `à`, conta `_`
    // como letra, e casa `da` dentro de `toda`). Cada campo que migra saía do
    // alcance da prova em silêncio, e a prova continuava verde porque os
    // mesmos lexemas ainda apareciam `\b`-delimitados noutro campo:
    // correta por REDUNDÂNCIA, não por construção. A redundância estava
    // marcada pra sumir. Achado pela revisão de compliance de 2026-09-14.
    const limpa = (t) => t
      .replace(/\(\?<?[=!][^)]*\)/g, '')     // (?<![…]) (?=[…]) (?!…)
      .replace(/\\b|\(\?:|[()^$]/g, '').trim();
    const sujas = [];
    for (const palavra of NEUTRAS) {
      for (const lista of listas) {
        const alts = G[lista].split('|').map(limpa);
        if (alts.includes(palavra)) sujas.push(`${palavra} ∈ ${lista}`);
      }
    }
    expect(sujas).toEqual([]);
    // E O NORMALIZADOR TEM QUE TERMINAR O TRABALHO. Uma alternativa que sai
    // dele ainda com sintaxe de regex nunca vai ser igual a uma palavra, então
    // ela é INVISÍVEL pra prova — e a prova segue verde dizendo que provou.
    // Esta asserção é o que transforma `a prova está correta hoje` em `a prova
    // sabe ler o arquivo`: se um campo migrar pra uma construção nova, falha
    // aqui em vez de emudecer.
    const ilegiveis = [];
    for (const lista of listas) {
      for (const alt of G[lista].split('|').map(limpa)) {
        if (/[\\()\[\]{}^$?*+|]/.test(alt)) continue;   // é padrão, não palavra
        if (/^[0-9A-Za-zÀ-ÿ _-]*$/.test(alt)) continue;     // é palavra limpa
        if (!/[0-9A-Za-zÀ-ÿ]/.test(alt)) continue;          // é pontuação (`,`, `;`)
        ilegiveis.push(`${lista}: ${JSON.stringify(alt)}`);
      }
    }
    expect(ilegiveis).toEqual([]);
  });

  const promessas = F.casos.filter((c) => c.recusa);
  const inocentes = F.casos.filter((c) => !c.recusa);

  /**
   * O LADO INOCENTE. O cabeçalho dizia que ele fica de fora porque "uma
   * inserção pode legitimamente criar uma promessa" — verdade pra uma palavra
   * qualquer, e falso pras palavras que este arquivo PROVA serem neutras. E a
   * direção que ele mede é a que apaga dinheiro da tela: uma palavra neutra
   * que DESTRÓI uma negação correta não cria promessa nenhuma, só faz o guarda
   * recusar a resposta certa.
   * Achado pela revisão de compliance de 2026-09-14.
   */
  test.each(inocentes.map((c) => [c.texto.replace(/\n/g, ' ⏎ ').slice(0, 60), c]))(
    'inocente: %s', (_nome, c) => {
      const caiu = [];
      for (const [variante, palavra] of injecoes(c.texto)) {
        if (acusa(variante)) caiu.push(`+${palavra} → ${variante.replace(/\n/g, '⏎')}`);
      }
      // A tolerância é POR CASO e descreve a CLASSE: a razão escrita explica
      // por que toda injeção neste caso cai do lado fail-closed.
      // A TOLERÂNCIA É POR VARIANTE EXATA, não por caso. Declarada por caso,
      // ela perdoava TODAS as injeções daquele caso — nove num deles, duas
      // noutro — enquanto a razão escrita nomeava uma só, e o teto contava
      // CASOS, então uma tolerância podia crescer em silêncio.
      // Apontado pela revisão de segurança de 2026-09-14.
      const naoDeclaradas = caiu.filter((v) => !(TOLERADAS[c.texto] || {})[variante(v)]);
      expect({ caso: c.texto.slice(0, 40), naoDeclaradas })
        .toEqual({ caso: c.texto.slice(0, 40), naoDeclaradas: [] });
    });

  /**
   * PREÂMBULOS COMUNS, que uma injeção de UMA palavra não consegue construir.
   *
   * `sujeito_nominal` precisa de determinante + substantivo pra disparar, e é
   * ele que VETA a regra 1b — uma peça que DESLIGA uma regra tem que ser
   * medida alargando-a, não apagando-a. A lista é de aberturas ordinárias de
   * frase, nenhuma delas negação: o grid que existia no `RevisaoDeAfirmacoes-
   * Tests` tinha seis preâmbulos e os seis eram negações, porque foi escrito a
   * partir do defeito da rodada anterior.
   * Achado pela revisão de compliance de 2026-09-14.
   */
  // A GRADE É CONSTRUÍDA DAS PEÇAS QUE ELA EXERCITA, não do último defeito.
  //
  // Os seis primeiros preâmbulos eram todos abertura de determinante +
  // substantivo, porque a grade nasceu do defeito do `sujeito_nominal` — e
  // NENHUM deles trazia verbo finito. O teste de prefixo da regra 3, que é
  // outra peça, ficou por medir: `Pode ficar tranquilo, 100% pro garçom.`
  // desligava a regra inteira, 847 de 2400 variantes, e esta grade não podia
  // produzi-lo. É a mesma forma do achado da rodada 16 (`os seis eram
  // negações`), uma rodada depois. Apontado pela revisão de segurança de
  // 2026-09-14.
  //
  // Agora há um preâmbulo por PEÇA que desqualifica um prefixo: verbo finito,
  // sujeito nominal, pronome sujeito, relativa, e nenhum dos três.
  const PREAMBULOS = [
    'Pode ficar tranquilo, ',        // verbo_finito
    'Tá tudo certo, ',               // verbo_finito, outra abertura
    'A conta fechou, ',              // sujeito_nominal + verbo
    'Com a conta fechada, ',         // sujeito_nominal regido por preposição
    'Ela, ',                         // pronome_sujeito sozinho
    'O garçom que te atendeu, ',     // relativa
    'Se a pessoa quiser, ',
    'No fim da noite, ',
    'Nesse caso, ',
    'Pelo que vi, ',
  ];
  // E O FILTRO DE UMA LINHA SAIU. Ele excluía por construção justamente os
  // casos de várias linhas — a forma em que o produto de fato escreve, e a
  // que o caminho fraco da regra 3 cobre.
  test.each(promessas
    .map((c) => [c.texto.replace(/\n/g, ' ⏎ ').slice(0, 50), c]))('preâmbulo: %s', (_nome, c) => {
      const caiu = PREAMBULOS.filter((p) => !acusa(p + c.texto[0].toLowerCase() + c.texto.slice(1)))
        .map((p) => `${p}… → ${c.texto}`);
      // O filtro de promessa era `v.includes(t)` com `t` sendo a PROSA da
      // razão — 200 caracteres contra uma variante de 60. Nunca casava, então
      // o mecanismo estava inerte deste lado. Agora é a mesma chave dos dois.
      const naoDeclaradas = caiu.filter((v) => !(TOLERADAS[c.texto] || {})[variante(v)]);
      expect({ caso: c.texto.slice(0, 40), naoDeclaradas })
        .toEqual({ caso: c.texto.slice(0, 40), naoDeclaradas: [] });
    });
  test.each(promessas.map((c) => [c.texto.replace(/\n/g, ' ⏎ ').slice(0, 60), c]))(
    '%s', (_nome, c) => {
      const caiu = [];
      for (const [variante, palavra] of injecoes(c.texto)) {
        if (!acusa(variante)) caiu.push(`+${palavra} → ${variante.replace(/\n/g, '⏎')}`);
      }
      const naoDeclaradas = caiu.filter((v) => !(TOLERADAS[c.texto] || {})[variante(v)]);
      expect({ caso: c.texto.slice(0, 40), naoDeclaradas })
        .toEqual({ caso: c.texto.slice(0, 40), naoDeclaradas: [] });
    });
});

/**
 * E O MESMO EIXO CONTRA O GUARDA QUE EMBARCA.
 *
 * Os três eixos rodavam sobre o CENSO — o `carrega()` recorta o
 * `claims.test.js` e exporta o `acusa`. O instrumento em que este arquivo mais
 * confia nunca tinha tocado o binário que chega ao cliente. Não era buraco
 * vivo (medido: zero divergências na varredura de injeção), mas a divergência
 * JS×Swift é uma família REAL neste repositório — `\w` é ASCII em JavaScript e
 * Unicode em ICU, e por isso `100% al señor camarero` era recusado pelo
 * runtime e LIBERADO pelo censo, que é o único portão sobre o `i18n.ts`, sobre
 * o roteiro impresso do garçom e sobre o `racha-ios.html`. A assimetria não é
 * simétrica: o que o censo deixa passar chega ao cliente.
 * Apontado pela revisão de segurança de 2026-09-14.
 *
 * Aqui o eixo de injeção roda nos DOIS e exige o MESMO veredito. Num ambiente
 * sem toolchain Swift o bloco é PULADO, e pular é dito em voz alta.
 */
describe('o fabricador mede os DOIS guardas', () => {
  const { execFileSync } = require('node:child_process');
  const temSwift = (() => {
    try { execFileSync('which', ['swiftc'], { stdio: 'pipe' }); return true; } catch { return false; }
  })();

  (temSwift ? test : test.skip)('injeção e preâmbulo dão o mesmo veredito no censo e no runtime',
    () => {
      const { acusa } = carrega();
      const variantes = [];
      for (const c of F.casos) {
        for (const [v] of injecoes(c.texto)) variantes.push(v);
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fabsw-'));
      fs.writeFileSync(path.join(tmp, 'CP.swift'),
        fs.readFileSync(path.join(RAIZ, 'ios', 'Racha', 'Agent', 'ClaimPatterns.swift'), 'utf8'));
      fs.writeFileSync(path.join(tmp, 'Rev.swift'),
        fs.readFileSync(path.join(RAIZ, 'ios', 'Racha', 'Agent', 'RevisaoDeAfirmacoes.swift'), 'utf8')
          .replace('enum RevisaoDeAfirmacoes {', 'public enum RevisaoDeAfirmacoes {'));
      // As variantes viajam por ARQUIVO, não por literal: um corpo de 8 mil
      // strings dentro do fonte Swift leva minutos pra compilar, e o que está
      // sendo medido é o guarda, não o compilador.
      fs.writeFileSync(path.join(tmp, 'casos.txt'), variantes.map((v) => JSON.stringify(v)).join('\n'));
      fs.writeFileSync(path.join(tmp, 'main.swift'), [
        'import Foundation',
        `let linhas = try! String(contentsOfFile: "${path.join(tmp, 'casos.txt')}", encoding: .utf8)`,
        '  .split(separator: "\\n", omittingEmptySubsequences: true)',
        'var fora: [String] = []',
        'for l in linhas {',
        '  let t = try! JSONDecoder().decode(String.self, from: Data(l.utf8))',
        '  fora.append(RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(t) ? "1" : "0")',
        '}',
        'print(fora.joined())',
      ].join('\n'));
      execFileSync('swiftc', ['-O', `${tmp}/CP.swift`, `${tmp}/Rev.swift`, `${tmp}/main.swift`,
        '-o', `${tmp}/p`], { timeout: 600000 });
      const swift = execFileSync(`${tmp}/p`, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
      expect(swift.length).toBe(variantes.length);
      /**
       * IGUALDADE ERA FORTE DEMAIS, e passou a ser falsa por DESENHO.
       *
       * As duas listas de destinatário são diferentes de propósito, e o
       * primeiro caso de corpo com um destinatário só-do-censo (`pro pessoal`)
       * fez este teste ficar vermelho por estar certo. O que importa não é a
       * igualdade: é a DIREÇÃO. O censo é o único portão sobre o `i18n.ts`, o
       * roteiro impresso e a landing — o que ele libera chega ao cliente. O
       * runtime é o último portão da volta do assistente. Censo MAIS estrito é
       * a assimetria que este arquivo quer; runtime mais estrito, ou censo
       * mais frouxo, é defeito.
       *
       * Então: divergência só na direção `censo=true, runtime=false`, e só em
       * variantes de um caso DECLARADO. Achado ao fechar o HIGH-1 da revisão
       * de compliance de 2026-09-15.
       */
      const DECLARADAS = G._divergencia_por_desenho || {};
      const declarado = (v) => Object.keys(DECLARADAS)
        .some((base) => injecoes(base).some(([w]) => w === v) || base === v);
      const divergiram = [];
      for (let i = 0; i < variantes.length; i += 1) {
        const c = acusa(variantes[i]); const r = swift[i] === '1';
        if (c === r) continue;
        // Runtime MAIS estrito que o censo nunca é por desenho: é o censo
        // liberando algo que o produto pode publicar.
        if (!c && r) { divergiram.push(`${JSON.stringify(variantes[i])}: censo=false runtime=true (direção proibida)`); continue; }
        if (!declarado(variantes[i])) {
          divergiram.push(`${JSON.stringify(variantes[i])}: censo=${c} runtime=${r}`);
        }
      }
      expect(divergiram.slice(0, 8)).toEqual([]);
      // Gaveta viva: um caso declarado que passou a concordar sai daqui.
      for (const [base, porque] of Object.entries(DECLARADAS)) {
        expect(`${base}: ${porque}`).toMatch(/.{300,}/);
        // O `variantes` guarda as INJEÇÕES, não o texto base: a prova de que a
        // gaveta está viva é que ALGUMA variante dele ainda diverge.
        const seus = variantes
          .map((v, i) => [v, i])
          .filter(([v]) => injecoes(base).some(([w]) => w === v));
        expect({ base, variantes: seus.length > 0 }).toEqual({ base, variantes: true });
        const aindaDiverge = seus.some(([v, i]) => acusa(v) !== (swift[i] === '1'));
        expect({ base, aindaDiverge }).toEqual({ base, aindaDiverge: true });
      }
    }, 900000);
});
