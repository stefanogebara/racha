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

  test('nenhuma rota de cron que escreve cai num limite de taxa como alternativa', () => {
    // `else if (!rateLimitCron(req))` era o caminho que deixava a rota pública.
    const comEscape = rotas
      .filter((r) => escreve(r.nome))
      .filter((r) => /else if \(!rateLimitCron\(req\)\)/.test(r.corpo))
      .map((r) => r.nome);
    expect(comEscape).toEqual([]);
  });
});
