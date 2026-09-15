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

  test('um método que NINGUÉM listou também recusa — é o ponto do Proxy', async () => {
    /**
     * A lista sempre esteve completa PRA HOJE; o risco é o trilho de amanhã.
     * O `create-charge` despacha por NOME (`psp[creator](...)`, com `creator`
     * saindo do trilho), e um `boleto` → `createBoletoCharge` seria invisível
     * pro censo, ficaria fora da lista, e o adaptador nasceria ABERTO naquele
     * método — só não virando incidente porque OUTRA guarda o pega por acaso
     * (segurança LOW-1 de ec86b37). Com o Proxy não existe "fora da lista".
     */
    const psp = pspIndisponivel('produção sem RACHA_PSP=pagarme');
    for (const inventado of ['createBoletoCharge', 'createTedCharge', 'qualquerCoisaNova']) {
      expect(METODOS).not.toContain(inventado);
      expect(typeof psp[inventado]).toBe('function');   // o despacho dinâmico acha
      await expect(Promise.resolve().then(() => psp[inventado]()))
        .rejects.toMatchObject({ statusCode: 503, code: 'platform_misconfigured' });
    }
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


test('`RACHA_ENV` é o ambiente que o deploy exige — e o desconhecido é produção', () => {
  // O teste anterior aqui era `expect(bloco).toMatch(/process\.env\.VERCEL === '1'/)`:
  // uma REGEX no fonte, que afirmava a GRAFIA do guarda. É exatamente o que
  // sobrevive quando o guarda é inalcançável — e ele era (segurança HIGH-1 de
  // ec86b37). Quem prova o comportamento agora é o bloco de boots acima; o que
  // fica aqui é o contrato com o deploy.
  const R = fs.readFileSync(path.join(RAIZ, '_app', 'router.js'), 'utf8');
  expect(R).toMatch(/const AMBIENTE = \(process\.env\.VERCEL_ENV \|\| process\.env\.RACHA_ENV \|\| ''\)\.trim\(\)/);
  const deploy = fs.readFileSync(path.join(RAIZ, '..', 'scripts', 'deploy.mjs'), 'utf8');
  expect(deploy).toMatch(/RACHA_ENV/);
});

/**
 * O PORTÃO E O QUE ELE GUARDA TÊM DE CONCORDAR — medido, não lido.
 *
 * A rodada anterior trimou o portão (`RACHA_PSP` com `.trim()`) e deixou o
 * `buildPsp` comparando cru. Trimar de um lado só faz o portão ser mais
 * PERMISSIVO que o consumidor, e a fresta falha ABERTA: `"pagarme "` dava
 * portão verde e adaptador MOCK — casa de verdade servindo BR Code de mentira,
 * com o cron calado e o deploy aprovado (segurança CRITICAL-1 de ec86b37).
 *
 * O teste que faltava é este: para cada valor de env, "o portão diz configurado"
 * e "o adaptador é o de verdade" têm de ser o MESMO booleano.
 */
const http = require('node:http');

function bootar(env) {
  const guardados = {};
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service_de_mentira';
  for (const k of ['VERCEL_ENV', 'RACHA_ENV', 'VERCEL', 'RACHA_STORE', 'RACHA_PSP',
    'PAGARME_SECRET_KEY', 'JEST_WORKER_ID', 'NODE_ENV']) {
    guardados[k] = process.env[k];
    if (k in env) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    else delete process.env[k];
  }
  const criou = { pagarme: false, mock: false };
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../_lib/pay/pagarme-psp', () => ({
      createPagarmePsp: () => { criou.pagarme = true; return { provider: 'pagarme', currencies: ['brl'] }; },
    }));
    jest.doMock('../_lib/pay/mock-psp', () => ({
      MockPsp: class { constructor() { criou.mock = true; this.provider = 'mock'; this.currencies = ['brl', 'eur']; } },
      WebhookVerificationError: class extends Error {},
    }));
    mod = require('../_app/router');
  });
  jest.dontMock('../_lib/pay/pagarme-psp'); jest.dontMock('../_lib/pay/mock-psp');
  for (const [k, v] of Object.entries(guardados)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return { mod, criou };
}

async function pagarResponde(mod) {
  const srv = http.createServer(mod.route).listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/pay`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'qualquer', amountCents: 100, tipCents: 0 }),
    });
    return r.status;
  } finally { srv.close(); }
}

describe('o portão e o adaptador leem o MESMO valor', () => {
  const PRODUCAO = { VERCEL_ENV: 'production', RACHA_STORE: 'supabase', PAGARME_SECRET_KEY: 'sk_teste' };
  const casos = [
    ['ausente', undefined, false],
    ['vazio', '', false],
    ['exato', 'pagarme', true],
    ['com espaço no fim', 'pagarme ', true],
    ['com espaço no começo', ' pagarme', true],
    ['maiúscula', 'Pagarme', false],
  ];
  test.each(casos)('RACHA_PSP %s: portão e adaptador concordam', async (_nome, valor, deviaValer) => {
    const { mod } = bootar({ ...PRODUCAO, RACHA_PSP: valor });
    // O PORTÃO abriu? Quando ele acusa falta, `escolherPsp` devolve o adaptador
    // que recusa — então o `provider` do adaptador ESCOLHIDO responde as duas
    // perguntas de uma vez, sem HTTP e sem tocar no store. (`criou.mock` não
    // serve: o `demoPsp` constrói um MockPsp sempre, e ele é outra coisa.)
    const provider = mod.psp.provider;
    const portaoDizConfigurado = provider !== 'unconfigured';
    const adaptadorEhDeVerdade = provider === 'pagarme';
    // A INVARIANTE: um não pode ser mais permissivo que o outro. O caso que
    // matava era `'pagarme '` — portão aberto, MOCK construído.
    expect({ portao: portaoDizConfigurado, adaptador: adaptadorEhDeVerdade })
      .toEqual({ portao: deviaValer, adaptador: deviaValer });
    expect(provider).not.toBe('mock');   // em produção, mock NUNCA
  });

  test.each([
    ['vazio (nenhuma env)', undefined],
    ['prod', 'prod'],
    ['Production', 'Production'],
    ['PRODUCTION', 'PRODUCTION'],
    ['live', 'live'],
    ['producao', 'producao'],
    ['staging', 'staging'],
  ])('RACHA_ENV %s conta como produção — falha fechada', async (_nome, valor) => {
    /**
     * A regra é lista de RECUSA, não de permissão. A versão anterior só tratava
     * a string VAZIA como produção, e o comentário em cima dela prometia o
     * contrário — então `RACHA_ENV=prod` digitado no painel punha casa de
     * verdade no mock, com o cron verde (segurança HIGH-1 de d7f2683). O valor
     * vem de um campo que uma pessoa digita: o conjunto é aberto.
     */
    const { mod } = bootar({ NODE_ENV: 'production', ...(valor === undefined ? {} : { RACHA_ENV: valor }) });
    expect(await pagarResponde(mod)).toBe(503);
    expect(mod.psp.provider).toBe('unconfigured');
  });

  test('o desconhecido conta como produção — o portão dispara sem VERCEL_ENV nenhum', async () => {
    // A cláusula anterior (`VERCEL === '1'`) era inalcançável: as duas variáveis
    // saem da MESMA chave do projeto na Vercel, então com ela desligada não
    // existe nenhuma das duas (segurança HIGH-1 de ec86b37). Aqui o processo
    // não diz NADA — nem ambiente, nem que é teste.
    const { mod } = bootar({ NODE_ENV: 'production' });
    expect(await pagarResponde(mod)).toBe(503);
  });

  test('preview e development seguem fora do portão, e a suíte também', async () => {
    expect(await pagarResponde(bootar({ RACHA_ENV: 'preview' }).mod)).not.toBe(503);
    expect(await pagarResponde(bootar({ VERCEL_ENV: 'development' }).mod)).not.toBe(503);
    expect(await pagarResponde(bootar({ JEST_WORKER_ID: '1' }).mod)).not.toBe(503);
  });

  test('init QUEBRADO em produção bem configurada também fecha o dinheiro', async () => {
    // Lista de faltantes VAZIA e `buildPsp` estourando (a `pk_` no lugar da
    // `sk_`): o portão olhava a lista e não fechava nada — apagão de pagamento
    // sem uma página sequer (segurança MEDIUM-2 de ec86b37).
    const guardado = process.env.PAGARME_SECRET_KEY;
    const { mod } = bootarComInitQuebrado();
    expect(await pagarResponde(mod)).toBe(503);
    if (guardado === undefined) delete process.env.PAGARME_SECRET_KEY; else process.env.PAGARME_SECRET_KEY = guardado;
  });
});

function bootarComInitQuebrado() {
  const guardados = {};
  for (const k of ['VERCEL_ENV', 'RACHA_ENV', 'RACHA_STORE', 'RACHA_PSP', 'JEST_WORKER_ID', 'NODE_ENV']) guardados[k] = process.env[k];
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service_de_mentira';
  process.env.VERCEL_ENV = 'production'; process.env.RACHA_STORE = 'supabase'; process.env.RACHA_PSP = 'pagarme';
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../_lib/pay/pagarme-psp', () => ({
      createPagarmePsp: () => { throw new Error('PAGARME_SECRET_KEY ausente'); },
    }));
    mod = require('../_app/router');
  });
  jest.dontMock('../_lib/pay/pagarme-psp');
  for (const [k, v] of Object.entries(guardados)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return { mod };
}

test('UMA leitura de cada env de plataforma no `api/` inteiro', () => {
  // É o que impede a fresta de voltar: portão e consumidor não podem ler a env
  // por conta própria e divergir na normalização.
  const varrer = (dir, saida = []) => {
    for (const nome of fs.readdirSync(dir)) {
      const cheio = path.join(dir, nome);
      if (fs.statSync(cheio).isDirectory()) { if (nome !== '__tests__' && nome !== 'node_modules') varrer(cheio, saida); }
      else if (nome.endsWith('.js')) saida.push(cheio);
    }
    return saida;
  };
  const leituras = { RACHA_PSP: [], RACHA_STORE: [] };
  for (const f of varrer(RAIZ)) {
    const fonte = fs.readFileSync(f, 'utf8');
    for (const chave of Object.keys(leituras)) {
      const n = (fonte.match(new RegExp(`process\\.env\\.${chave}\\b`, 'g')) || []).length;
      for (let i = 0; i < n; i += 1) leituras[chave].push(path.relative(RAIZ, f));
    }
  }
  expect(leituras).toEqual({ RACHA_PSP: ['_app/router.js'], RACHA_STORE: ['_app/router.js'] });
});

describe('o cron de pendentes, em produção quebrada', () => {
  const ANTES = {};
  beforeAll(() => { ANTES.CRON_SECRET = process.env.CRON_SECRET; process.env.CRON_SECRET = 'segredo-de-teste'; });
  afterAll(() => { if (ANTES.CRON_SECRET === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = ANTES.CRON_SECRET; });

  async function chamarCron(mod, caminho) {
    const srv = http.createServer(mod.route).listen(0);
    await new Promise((r) => srv.once('listening', r));
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${caminho}`, {
        method: 'POST', headers: { authorization: 'Bearer segredo-de-teste' },
      });
      return { status: r.status, corpo: await r.json() };
    } finally { srv.close(); }
  }

  test('devolve 503 e NÃO varre — o painel da Vercel fica vermelho junto com o aviso', async () => {
    // Com o adaptador recusando, varrer só produz erro por cobrança; e um cron
    // verde é um canário que só registra (inegociável #8).
    const { mod } = bootar({ RACHA_ENV: 'production' });   // sem store nem PSP
    const { status, corpo } = await chamarCron(mod, '/api/cron/reconcile-pending');
    expect({ status, code: corpo.code }).toEqual({ status: 503, code: 'platform_misconfigured' });
  });

  test('o aviso sai UMA VEZ POR HORA: a segunda passada no mesmo relógio não repagina', async () => {
    const { mod } = bootar({ RACHA_ENV: 'production' });
    const vagas = [];
    const original = mod.store.claimSlots.bind(mod.store);
    mod.store.claimSlots = async (args) => { vagas.push(args.keys); return original(args); };
    await chamarCron(mod, '/api/cron/reconcile-pending');
    await chamarCron(mod, '/api/cron/reconcile-pending');
    const daConfig = vagas.filter((k) => k.includes('alerta:config-producao'));
    expect(daConfig.length).toBe(2);              // pergunta as duas vezes…
    expect(daConfig[0]).toEqual(['alerta:config-producao']);
  });

  test('uma casa VELHA sem recebedor não desliga o canário do KYC', async () => {
    /**
     * `getRecipient` devolve `null` SEM chamar ninguém quando o id não é `r*_`
     * (ver `pagarme-psp`), e a casa nem entrava no relatório. Contando FALHAS,
     * uma linha dessas na lista pendente fazia `falharam === pending.length`
     * ser falso pra sempre: adquirente inteiro fora do ar e cron 200 verde
     * (segurança MEDIUM-1 de d7f2683). O dublê do `psp-indisponivel` é mais
     * hostil que o adaptador real — estoura em tudo —, então aqui o PSP é
     * trocado por um que reproduz a semântica REAL.
     */
    const { mod } = bootar({ RACHA_ENV: 'production' });
    const velha = mod.store.seedVenue({ name: 'Sem recebedor', cnpj: '11222333000181' });
    const nova = mod.store.seedVenue({ name: 'Com recebedor', cnpj: '11222333000181' });
    await mod.store.setVenueRecipient(nova.id, 're_valido123', { status: 'registration' });
    await mod.store.setVenueRecipientStatus(velha.id, 'pending');
    await mod.store.setVenueRecipientStatus(nova.id, 'pending');
    mod.psp.getRecipient = async (id) => {
      if (!/^r[ep]_/.test(id || '')) return null;      // o real NÃO estoura aqui
      throw new Error('ECONNRESET: adquirente fora do ar');
    };
    const { status, corpo } = await chamarCron(mod, '/api/cron/recipient-status');
    expect({ status, code: corpo.code }).toEqual({ status: 503, code: 'psp_unavailable' });
  });

  test('o cron de KYC não devolve 200 quando TODAS as consultas ao adquirente falham', async () => {
    const { mod } = bootar({ RACHA_ENV: 'production' });   // psp = o que recusa
    const casa = mod.store.seedVenue({ name: 'Casa Pendente', cnpj: '11222333000181' });
    // RECEBEDOR DE VERDADE (`re_`): com o `rcpt_demo` da semente, a casa nem é
    // perguntada — e o teste passava por não haver consulta nenhuma, não por o
    // portão funcionar.
    await mod.store.setVenueRecipient(casa.id, 're_pendente123', { status: 'registration' });
    await mod.store.setVenueRecipientStatus(casa.id, 'pending');
    const pendentes = await mod.store.listVenuesPendingRecipient();
    expect(pendentes.length).toBeGreaterThan(0);
    const { status, corpo } = await chamarCron(mod, '/api/cron/recipient-status');
    expect({ status, code: corpo.code }).toEqual({ status: 503, code: 'psp_unavailable' });
    // E NADA foi gravado: o status da casa continua o que era.
    expect((await mod.store.getVenue(pendentes[0].id)).pspRecipientStatus).toBe('pending');
  });
});
