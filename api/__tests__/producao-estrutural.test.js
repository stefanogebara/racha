'use strict';

/**
 * PRODUÇÃO MAL CONFIGURADA NÃO GANHA UM PSP DE MENTIRA.
 *
 * A guarda anterior era uma LISTA DE ROTAS, e listas esquecem. O cron de KYC
 * não estava nela: em produção sem `RACHA_PSP=pagarme`, ele perguntava ao mock
 * — que responde `active` pra qualquer id —, gravava "recebedor ativo" numa
 * casa de verdade e mandava WhatsApp ao dono dizendo que já dava pra cobrar
 * (segurança MEDIUM-1 e compliance LOW-5 de 3eea5f3).
 */

const fs = require('node:fs');
const path = require('node:path');
const { pspIndisponivel, escolherPsp, METODOS } = require('../_lib/pay/psp-indisponivel');

const RAIZ = path.join(__dirname, '..');

describe('o adaptador que recusa', () => {
  test('TODO método estoura 503 com código — inclusive a leitura', async () => {
    const psp = pspIndisponivel('produção sem RACHA_PSP=pagarme');
    for (const m of METODOS) {
      // `null` seria uma RESPOSTA: o cron leria "sem status" e seguiria.
      await expect(Promise.resolve().then(() => psp[m]()))
        .rejects.toMatchObject({ statusCode: 503, code: 'platform_misconfigured' });
    }
    expect(psp.provider).toBe('unconfigured');
  });

  test('sem `currencies`, o portão do create-charge já recusa a cobrança', () => {
    expect(Array.isArray(pspIndisponivel('x').currencies)).toBe(false);
    const guarda = fs.readFileSync(path.join(RAIZ, '_lib', 'pay', 'create-charge.js'), 'utf8');
    expect(guarda).toMatch(/!Array\.isArray\(psp\.currencies\)/);
  });

  test('a produção que FALTA config nem chega a construir o PSP de verdade', () => {
    let construiu = false;
    const psp = escolherPsp(['RACHA_PSP=pagarme'], () => { construiu = true; return { provider: 'pagarme' }; });
    expect(construiu).toBe(false);
    expect(psp.provider).toBe('unconfigured');
  });

  test('a produção COMPLETA recebe o PSP de verdade', () => {
    expect(escolherPsp([], () => ({ provider: 'pagarme' })).provider).toBe('pagarme');
  });

  test('init quebrado recusa o dinheiro e deixa a leitura de pé', () => {
    const avisos = [];
    const psp = escolherPsp([], () => { throw new Error('sem chave'); }, (e) => avisos.push(e.message));
    expect(psp.provider).toBe('unconfigured');
    expect(avisos).toEqual(['sem chave']);
  });
});

/**
 * O CENSO. É ele que faz a guarda ser estrutural: uma rota nova que chame um
 * método novo do PSP quebra este teste até o adaptador que recusa cobrir esse
 * método — em vez de nascer aberta porque ninguém lembrou de uma lista.
 */
test('todo método do PSP chamado no código está no adaptador que recusa', () => {
  const arquivos = [];
  const varrer = (dir) => {
    for (const nome of fs.readdirSync(dir)) {
      const cheio = path.join(dir, nome);
      if (fs.statSync(cheio).isDirectory()) { if (nome !== '__tests__' && nome !== 'node_modules') varrer(cheio); }
      else if (nome.endsWith('.js')) arquivos.push(cheio);
    }
  };
  varrer(path.join(RAIZ, '_lib'));
  varrer(path.join(RAIZ, '_app'));

  // Propriedades, não métodos: `provider` identifica o adaptador e `currencies`
  // é a lista que o portão exige (e cuja ausência é a recusa).
  const PROPRIEDADES = new Set(['provider', 'currencies']);
  const chamados = new Set();
  for (const f of arquivos) {
    const fonte = fs.readFileSync(f, 'utf8');
    for (const m of fonte.matchAll(/\bpsp\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/g)) chamados.add(m[1]);
  }
  const descobertos = [...chamados].filter((m) => !PROPRIEDADES.has(m)).sort();
  expect(descobertos.length).toBeGreaterThan(4);
  expect(descobertos.filter((m) => !METODOS.includes(m))).toEqual([]);
});

test('o router escolhe o PSP por `escolherPsp`, não por uma lista de rotas', () => {
  const R = fs.readFileSync(path.join(RAIZ, '_app', 'router.js'), 'utf8');
  expect(R).toMatch(/const psp = escolherPsp\(CONFIG_DE_PRODUCAO_FALTANDO, buildPsp/);
  // E o portão continua fechando as rotas de dinheiro por cima — cinto e
  // suspensório: o adaptador recusa a chamada, a lista recusa a rota.
  expect(R).toMatch(/caminho === '\/api\/dev\/confirm'/);
});

test('`VERCEL=1` sem `VERCEL_ENV` conta como produção — falha fechada', () => {
  const R = fs.readFileSync(path.join(RAIZ, '_app', 'router.js'), 'utf8');
  const bloco = R.slice(R.indexOf('const EM_PRODUCAO'), R.indexOf('CONFIG_DE_PRODUCAO_FALTANDO ='));
  expect(bloco).toMatch(/process\.env\.VERCEL === '1'/);
  expect(bloco).toMatch(/\['preview', 'development'\]/);
});

test('o cron de pendentes não VARRE em produção mal configurada — e pagina no máximo de hora em hora', () => {
  const R = fs.readFileSync(path.join(RAIZ, '_app', 'router.js'), 'utf8');
  const i = R.indexOf("url.pathname === '/api/cron/reconcile-pending'");
  const rota = R.slice(i, R.indexOf("url.pathname === '", i + 40));
  const bloco = rota.slice(rota.indexOf('if (CONFIG_DE_PRODUCAO_FALTANDO.length)'));
  // Uma vaga de uma hora antes de paginar: 96 páginas por dia ensinam a
  // silenciar o canal (segurança LOW-2 de 3eea5f3).
  expect(bloco).toMatch(/keys: \['alerta:config-producao'\], limits: \[1\], windowMs: 60 \* 60 \* 1000/);
  // Falhou a dedupe? Pagina assim mesmo.
  expect(bloco).toMatch(/catch \{ paginarConfig = true; \}/);
  // E a varredura não roda: com o PSP recusando, ela só produz erro.
  const ateORetorno = bloco.slice(0, bloco.indexOf("code: 'platform_misconfigured'"));
  expect(ateORetorno).not.toMatch(/reconciler\.reconcile/);
  expect(bloco).toMatch(/return json\(res, 503, \{ success: false, code: 'platform_misconfigured' \}\);/);
});
