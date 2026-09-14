'use strict';

/**
 * Toda rota de cron que ESCREVE falha fechada sem `CRON_SECRET`.
 *
 * A rota da retenção nasceu copiando a forma errada. Há duas neste arquivo:
 * o `activation-radar` só LÊ, então sem segredo ele cai num limite de taxa e
 * responde; o `reconcile` ESCREVE, e o commit `4930caa` já o tinha reescrito
 * pra devolver 503 e paginar, porque "degradar aberta era divulgação
 * cross-tenant sem auth". Eu copiei a primeira e a retenção virou um `curl`
 * anônimo disparando UPDATE de tabela inteira sem índice e devolvendo a
 * contagem de sessões de cliente da plataforma toda.
 *
 * O teste que existia era `expect(rota).toMatch(/segredoConfere\(…\)/)` — um
 * censo de substring que passa numa rota onde essa chamada mora DENTRO de
 * `if (process.env.CRON_SECRET)`. Ele prova que o portão existe, não que
 * alguma entrada faça o portão RODAR.
 *
 * Isto enumera as rotas de cron, classifica cada uma por escrever ou não, e
 * exige a forma certa de cada classe. Achado da revisão de segurança de
 * 2026-09-12.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

/** Os corpos das rotas `/api/cron/*`, na ordem em que aparecem. */
function rotasDeCron() {
  const marcas = [...SRC.matchAll(/url\.pathname === '(\/api\/cron\/[a-z-]+)'/g)]
    .map((m) => ({ nome: m[1], inicio: m.index }));
  return marcas.map((m, i) => ({
    nome: m.nome,
    corpo: SRC.slice(m.inicio, i + 1 < marcas.length ? marcas[i + 1].inicio : SRC.length),
  }));
}

/**
 * ESCREVE por padrão. A lista é de LEITORES, e é nominal.
 *
 * A primeira versão perguntava "esta rota chama algum `store.<verbo>`?" — uma
 * lista de negação sobre uma convenção de chamada. E o cron que mais escreve do
 * arquivo escreve através de `reconciler.reconcile(...)` e de `writeBackToPos`,
 * nenhum dos dois casando: o censo escrito pra pegar rota aberta classificou a
 * mais aberta como leitura. Censo que afirma cobertura que não tem é pior que
 * censo nenhum, e isso já está escrito no registro de decisões deste repo.
 *
 * Então a pergunta inverteu: rota de cron ESCREVE, a menos que alguém a tenha
 * declarado leitora aqui, por nome, com o motivo. Uma rota nova reprova o teste
 * até ser classificada — que é o único jeito de falhar fechado contra um padrão
 * de chamada que ninguém previu.
 */
const SO_LEEM = new Map([
  ['/api/cron/activation-radar', 'monta o radar a partir de `listVenueActivation` e responde; não grava'],
]);

function escreve(nome) {
  return !SO_LEEM.has(nome);
}

/**
 * Rotas SEM portão que mandam coisa pra fora, com o motivo escrito. Cada uma é
 * uma decisão, não um resto.
 */
const SAIDA_SEM_PORTAO = {
  '/api/demo/beacon': (
    'TELEMETRIA DE PROSPECÇÃO, e ela TEM que ser pública: quem a dispara é o '
    + '`sendBeacon` do navegador de um prospecto abrindo o link da Olímpia, que por '
    + 'definição não tem sessão. O que está bounded e escrito: (a) limite de taxa da '
    + 'demo, 30 por janela por IP; (b) o corpo aceito é DOIS campos — um `event` de '
    + 'lista fechada (`opened`/`paid`) e um `pl` de 40 a 400 caracteres —, e nada '
    + 'disso é lido como instrução nem escrito no nosso banco; (c) a rota NÃO devolve '
    + 'nada do outro lado, então não vira oráculo de token válido. O que ela não '
    + 'impede, e está dito: quem já tem um link de prospecção válido pode forjar '
    + 'evento PARA AQUELE LINK, e isso suja o radar de vendas — não o dinheiro, não '
    + 'o cliente na mesa, não dado pessoal. A validação do `pl` é da ponte, que é '
    + 'quem o emitiu; aqui ele é repassado, nunca confiado. Achado pelo censo de '
    + 'saída ao varrer o router inteiro, 2026-09-14.'
  ),
};

describe('cron: quem escreve não degrada aberta', () => {
  const rotas = rotasDeCron();

  test('há rotas de cron pra examinar', () => {
    expect(rotas.length).toBeGreaterThanOrEqual(4);
  });

  test('todo cron AGENDADO é classificado — a enumeração vem do vercel.json', () => {
    // A enumeração era por prefixo `/api/cron/`, e `/api/demo/reset` está
    // agendado como cron, escreve (fecha e abre conta na mesa de demo) e não
    // segue a convenção de nome — então era invisível pro censo. Ser público é
    // decisão tomada; ser INCLASSIFICÁVEL não é.
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
    const agendados = (vercel.crons || []).map((c) => c.path);
    expect(agendados.length).toBeGreaterThan(0);

    // Exceção NOMEADA, com o motivo — não um buraco na regex.
    const EXCECOES = new Map([
      ['/api/demo/reset', 'mesa pública de demonstração: dinheiro do MockPsp, '
        + 'protegida por rateLimitDemo e por resolveDemoTable; nunca toca casa real'],
    ]);

    const semClassificacao = agendados.filter(
      (p) => !EXCECOES.has(p) && !rotas.some((r) => r.nome === p),
    );
    expect(semClassificacao).toEqual([]);
  });

  test('toda rota de cron que escreve exige CRON_SECRET e devolve 503 sem ele', () => {
    const frouxas = [];
    for (const r of rotas) {
      if (!escreve(r.nome)) continue;
      // A forma que importa: a AUSÊNCIA do segredo é tratada explicitamente e
      // fecha. `if (process.env.CRON_SECRET) { … }` sem `else` que feche não
      // conta — era exatamente essa a forma frouxa.
      // Janela larga: entre o `if` e o 503 cabem o log, o aviso ao fundador e
      // o comentário que explica por que a rota fecha. O que importa é que o
      // ramo da AUSÊNCIA do segredo termine em 503, não a distância.
      const fechaSemSegredo = /if \(!process\.env\.CRON_SECRET\)[\s\S]{0,1600}?json\(res, 503/.test(r.corpo);
      if (!fechaSemSegredo) frouxas.push(r.nome);
    }
    expect(frouxas).toEqual([]);
  });

  test('nenhum ramo SEM autenticação manda nada pra fora', () => {
    /**
     * O CENSO QUE FALTAVA, e ele fecha a CLASSE em vez do caso.
     *
     * Este arquivo provava que a rota FECHA sem o segredo; não provava que ela
     * não produz EFEITO EXTERNO antes de fechar. A `/api/cron/reconcile`
     * paginava o fundador de dentro do ramo `!process.env.CRON_SECRET` — que é,
     * por definição, o ramo sem autenticação: é o ramo do segredo ausente. O
     * throttle era `let` de módulo numa função serverless, então todo cold
     * start o zerava, e N requisições concorrentes rendiam N avisos e N
     * `fetch` de 8 segundos. Amplificação de function-seconds e telefone do
     * fundador, por `curl` anônimo.
     * Achado pela revisão de segurança de 2026-09-14.
     *
     * A regra: entre o `if (!process.env.CRON_SECRET)` e o `return` dele não
     * pode haver chamada de saída. Log em stderr pode — é local, é grátis, e é
     * o que as outras duas rotas de cron sempre fizeram.
     */
    const sujas = [];
    // ROTA QUE O CENSO NÃO SABE LER NÃO PODE SER PULADA. A primeira versão
    // exigia a chave de fechamento com SEIS espaços exatos e fazia `continue`
    // quando não achava: uma rota aninhada um nível a mais, ou escrita sem
    // chaves, saía do censo em silêncio — a forma "guarda que nunca dispara"
    // dentro do censo escrito pra fechar essa forma. Apontado pela revisão de
    // segurança de 2026-09-14.
    const naoParseadas = [];
    for (const r of rotas) {
      if (!/if \(!process\.env\.CRON_SECRET\)/.test(r.corpo)) continue;
      const m = /if \(!process\.env\.CRON_SECRET\)\s*\{([\s\S]*?)\n\s*\}/.exec(r.corpo);
      if (!m) { naoParseadas.push(r.nome); continue; }
      if (/notify[A-Za-z]*\(|await fetch\(|sendMail|webhook/.test(m[1])) sujas.push(r.nome);
    }
    expect(naoParseadas).toEqual([]);
    expect(sujas).toEqual([]);
  });

  /**
   * E O CENSO DE SAÍDA VALE PRO ROUTER INTEIRO, não só pros crons.
   *
   * A versão anterior só olhava dentro do ramo `if (!process.env.CRON_SECRET)`,
   * porque foi escrita a partir do achado que a criou — a mesma forma que a
   * revisão de compliance nomeou três rodadas seguidas. Uma rota que não é
   * cron e manda coisa pra fora sem autenticação nenhuma era invisível por
   * construção, e havia uma: `/api/demo/beacon`.
   *
   * A regra: toda chamada de saída (`notify*`, `fetch`) mora numa rota que tem
   * portão de autenticação, ou está declarada aqui com o motivo escrito.
   */
  test('toda chamada de SAÍDA está atrás de um portão, ou declarada', () => {
    const fonte = SRC.split('\n');
    const ROTA = /url\.pathname === '([^']+)'/;
    const SAIDA = /notify[A-Za-z]*\(|await fetch\(/;
    const PORTAO = /segredoConfere\(|requireOwner|exigeDono|sessaoDoDono|assinatura|verifySignature/;
    const comentario = (l) => /^\s*(\*|\/\/)/.test(l);
    let rota = null; let temPortao = false;
    const soltas = [];
    for (const l of fonte) {
      const m = ROTA.exec(l);
      if (m) { rota = m[1]; temPortao = false; }
      if (rota && PORTAO.test(l) && !comentario(l)) temPortao = true;
      if (rota && SAIDA.test(l) && !comentario(l) && !temPortao) soltas.push(rota);
    }
    const declaradas = SAIDA_SEM_PORTAO;
    expect([...new Set(soltas)].filter((r) => !declaradas[r])).toEqual([]);
    // A gaveta tem a disciplina das dispensas: motivo escrito, e entrada que
    // deixou de ser necessária cai aqui em vez de envelhecer calada.
    for (const [r, porque] of Object.entries(declaradas)) {
      expect(`${r}: ${porque}`).toMatch(/.{200,}/);
      expect(soltas).toContain(r);
    }
  });

  test('nenhuma rota de cron que escreve cai num limite de taxa como alternativa', () => {
    // `else if (!rateLimitCron(req))` era o caminho que deixava a rota pública.
    const comEscape = rotas
      .filter((r) => escreve(r.nome))
      .filter((r) => /else if \(!rateLimitCron\(req\)\)/.test(r.corpo))
      .map((r) => r.nome);
    expect(comEscape).toEqual([]);
  });
});
