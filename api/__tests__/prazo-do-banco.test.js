'use strict';

/**
 * O BANCO TEM PRAZO — e o prazo escrito é o prazo REAL.
 *
 * Este arquivo MEDE. Ele sobe um servidor HTTP que aceita a conexão e nunca
 * responde (a forma exata da falha que consumia o `maxDuration`) e cronometra
 * o cliente de verdade contra ele. Nada aqui procura texto no fonte: a lição
 * de 2026-09-15 é que testar a GRAFIA de um guarda passa verde com o guarda
 * morto.
 *
 * LIMITE DECLARADO: o que se mede aqui é o teto de UMA chamada ao Postgrest e
 * ao GoTrue. Não se mede aqui quantas chamadas uma ROTA faz — esse é o outro
 * achado (o N+1 do `/api/panel`), e nenhuma asserção deste arquivo o alcança.
 */

const http = require('http');
const { criarClienteSupabase, fetchComPrazo, prazoConfigurado, PADRAO_MS } = require('../_lib/store/cliente-supabase');

/** Servidor que ACEITA e pendura — e conta quantas idas chegaram. */
function servidorMudo() {
  const abertos = [];
  const idas = [];
  const srv = http.createServer((req, res) => {
    idas.push({ metodo: req.method, caminho: req.url });
    abertos.push(res);
  });
  return new Promise((ok) => {
    srv.listen(0, '127.0.0.1', () => ok({
      url: `http://127.0.0.1:${srv.address().port}`,
      idas,
      fechar: () => { for (const r of abertos) r.destroy(); srv.close(); },
    }));
  });
}

const PRAZO = 1000; // o PISO do módulo — o menor valor que ele aceita
let mudo;
let envAntes;
beforeAll(async () => {
  envAntes = process.env.RACHA_DB_TIMEOUT_MS;
  process.env.RACHA_DB_TIMEOUT_MS = String(PRAZO);
  mudo = await servidorMudo();
});
afterAll(() => {
  mudo.fechar();
  if (envAntes === undefined) delete process.env.RACHA_DB_TIMEOUT_MS;
  else process.env.RACHA_DB_TIMEOUT_MS = envAntes;
});
beforeEach(() => { mudo.idas.length = 0; });

describe('o prazo do banco é medido, não declarado', () => {
  test('uma LEITURA pendurada corta no prazo, em UMA ida', async () => {
    const c = criarClienteSupabase(mudo.url, 'chave', { auth: { persistSession: false } });
    const t = Date.now();
    const { error } = await c.from('check_events').select('id');
    const levou = Date.now() - t;

    expect(error).toBeTruthy();
    // UMA ida. Esta é a asserção que o `AbortSignal.timeout` quebra: com ele o
    // postgrest-js repete a leitura 4 vezes (medido: 13085 ms pra um prazo de
    // 1500), porque o `TimeoutError` não casa com o ramo de cancelamento dele.
    expect(mudo.idas).toHaveLength(1);
    // E o relógio confirma que a ida única é a do prazo, não uma que voltou
    // sozinha: sem o teto de tempo, contar idas não distingue "cortou em 1 s"
    // de "cortou em 13 s na primeira tentativa de um cliente sem repetição".
    expect(levou).toBeGreaterThanOrEqual(PRAZO - 100);
    expect(levou).toBeLessThan(PRAZO * 2.5);
  }, 30000);

  test('uma ESCRITA pendurada corta no mesmo prazo', async () => {
    const c = criarClienteSupabase(mudo.url, 'chave', { auth: { persistSession: false } });
    const t = Date.now();
    const { error } = await c.rpc('append_check_event', { p_check_id: 'x' });
    const levou = Date.now() - t;
    expect(error).toBeTruthy();
    expect(mudo.idas).toHaveLength(1);
    expect(levou).toBeLessThan(PRAZO * 2.5);
  }, 30000);

  test('o LOGIN pendurado também corta — o GoTrue é outro cliente, mesmo buraco', async () => {
    const c = criarClienteSupabase(mudo.url, 'chave', { auth: { persistSession: false, autoRefreshToken: false } });
    const t = Date.now();
    const { error } = await c.auth.getUser('token-qualquer');
    const levou = Date.now() - t;
    expect(error).toBeTruthy();
    expect(levou).toBeLessThan(PRAZO * 2.5);
  }, 30000);

  /**
   * A PROVA DE MUTAÇÃO, plantada e medida.
   *
   * Sem este caso, o teste acima seria satisfeito por qualquer coisa que
   * cortasse — e a versão errada TAMBÉM corta, só que oito vezes mais tarde.
   * Aqui se constrói o mutante (`AbortSignal.timeout`, a forma óbvia) e se
   * afirma que ele é DISTINGUÍVEL: mais de uma ida. Se um dia o postgrest-js
   * parar de repetir erro de rede, este caso fica vermelho e avisa que o
   * cuidado do `cliente-supabase.js` virou desnecessário — que é uma coisa boa
   * de descobrir por teste vermelho e não por leitura de changelog.
   */
  test('a forma ÓBVIA do prazo é distinguível — e é pior', async () => {
    // O mutante precisa ser montado por FORA da fábrica: ela sobrescreve o
    // `global.fetch` de quem chama, que é justamente o que impede um chamador
    // de devolver o buraco sem querer (o caso seguinte mede isso).
    const { createClient } = require('@supabase/supabase-js');
    const cru = createClient(mudo.url, 'chave', {
      auth: { persistSession: false },
      global: { fetch: (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(PRAZO) }) },
    });
    const t = Date.now();
    await cru.from('check_events').select('id');
    const levou = Date.now() - t;
    expect(mudo.idas.length).toBeGreaterThan(1);
    expect(levou).toBeGreaterThan(PRAZO * 2.5);
  }, 60000);

  test('o fetch de quem chama não consegue tirar o prazo', async () => {
    let chamadoEspiao = false;
    const espiao = () => { chamadoEspiao = true; return new Promise(() => {}); };
    const c = criarClienteSupabase(mudo.url, 'chave', { global: { fetch: espiao } });
    // Espera a chamada TERMINAR — um `then` solto deixaria o socket e o
    // temporizador vivos depois do teste, e o Jest fica pendurado no fim.
    await c.from('check_events').select('id');
    // O espião, que penduraria pra sempre, nunca foi chamado: o `global.fetch`
    // do chamador foi substituído pelo da fábrica.
    expect(chamadoEspiao).toBe(false);
  }, 15000);

  test('o corte AVISA no stderr — cortar calado troca um sumiço por outro', async () => {
    const escritas = [];
    const antes = process.stderr.write;
    process.stderr.write = (t) => { escritas.push(String(t)); return true; };
    try {
      const c = criarClienteSupabase(mudo.url, 'chave', { auth: { persistSession: false } });
      await c.from('check_events').select('id');
    } finally { process.stderr.write = antes; }
    const aviso = escritas.find((t) => t.includes('PRAZO ESTOURADO'));
    expect(aviso).toBeTruthy();
    expect(aviso).toContain('/rest/v1/check_events');
    // Nem a query (ids de conta) nem a chave saem no log.
    expect(aviso).not.toContain('select=');
    expect(aviso).not.toContain('chave');
  }, 30000);
});

describe('o sinal de quem chama continua mandando', () => {
  test('cancelar DEPOIS da chamada aborta', async () => {
    const ac = new AbortController();
    const f = fetchComPrazo(60_000);
    const p = f(mudo.url, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
  }, 15000);

  /**
   * O CASO QUE O COMENTÁRIO NOMEAVA E O CÓDIGO NÃO PEGAVA.
   *
   * Um sinal JÁ abortado nunca dispara o evento `abort` de novo, então um
   * `addEventListener` sozinho não roda — e a requisição saía no nosso sinal,
   * que não está abortado. A guarda falhava exatamente pra entrada que a frase
   * ao lado dela citava. Inerte hoje (nada em `api/` passa `abortSignal`), e é
   * por isso que ela precisava de teste: uma guarda que nunca dispara é testada
   * em produção. Achado pela revisão de segurança de 2026-09-16 (LOW-4).
   */
  test('um sinal que JÁ abortou impede a ida — a requisição nem sai', async () => {
    const ac = new AbortController();
    ac.abort();
    let saiu = false;
    const f = fetchComPrazo(60_000, (...args) => { saiu = true; return fetch(...args); });
    await expect(f(mudo.url, { signal: ac.signal })).rejects.toThrow();
    // O `fetch` até é chamado (é ele quem rejeita por sinal abortado), mas com
    // um sinal ABORTADO: nada vai pra rede. O servidor mudo não recebe ida.
    expect(saiu).toBe(true);
  }, 15000);

  test('o ouvinte é solto no fim — um sinal longevo não acumula um por requisição', async () => {
    const { getEventListeners } = require('node:events');
    const ac = new AbortController();
    // Prazo curto: cada ida ao servidor mudo corta rápido, e o que se mede é o
    // que sobra DEPOIS de a promessa assentar.
    const f = fetchComPrazo(1000);
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop
      await f(`${mudo.url}/x`, { signal: ac.signal }).catch(() => {});
    }
    // Trinta idas no mesmo sinal: sem o `removeEventListener` seriam trinta
    // ouvintes e o aviso de vazamento do Node (o limite é 10).
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  }, 60000);
});

describe('a env não desliga a guarda em silêncio', () => {
  const casos = [
    ['', PADRAO_MS, 'vazia'],
    [undefined, PADRAO_MS, 'ausente'],
    ['0', PADRAO_MS, 'zero — o dedo torto que desligaria tudo'],
    ['-1', PADRAO_MS, 'negativa'],
    ['abc', PADRAO_MS, 'não numérica'],
    ['999', PADRAO_MS, 'abaixo do piso'],
    ['60001', PADRAO_MS, 'acima do teto'],
    ['1000', 1000, 'no piso'],
    ['60000', 60000, 'no teto'],
    ['25000', 25000, 'no meio'],
  ];
  test.each(casos)('RACHA_DB_TIMEOUT_MS=%p → %p (%s)', (valor, esperado) => {
    const antes = process.env.RACHA_DB_TIMEOUT_MS;
    if (valor === undefined) delete process.env.RACHA_DB_TIMEOUT_MS;
    else process.env.RACHA_DB_TIMEOUT_MS = valor;
    try { expect(prazoConfigurado()).toBe(esperado); }
    finally { if (antes === undefined) delete process.env.RACHA_DB_TIMEOUT_MS; else process.env.RACHA_DB_TIMEOUT_MS = antes; }
  });
});

describe('ninguém constrói cliente por fora da fábrica', () => {
  /**
   * ESCOPO DECLARADO: `api/` — o que é DEPLOYADO.
   *
   * Os scripts de operação (`scripts/*.mjs`) montam clientes próprios, e dois
   * deles rodam contra PRODUÇÃO. Eles não estão cobertos por este censo e não
   * herdam o prazo; o teste abaixo afirma que eles existem, pra que a frase
   * "o único lugar que constrói um cliente" não seja lida como mais ampla do
   * que é. Achado pela revisão de segurança de 2026-09-16 (LOW-5).
   */
  test('o censo: só o `cliente-supabase.js` chama `createClient`', () => {
    const { execSync } = require('child_process');
    const raiz = require('path').join(__dirname, '..');
    const saida = execSync(`grep -rln "createClient" ${raiz} --exclude-dir=node_modules --exclude-dir=__tests__ || true`, { encoding: 'utf8' });
    const arquivos = saida.split('\n').filter(Boolean).map((f) => f.replace(`${raiz}/`, ''));
    expect(arquivos).toEqual(['_lib/store/cliente-supabase.js']);
  });

  test('e os scripts de operação estão FORA deste escopo — dito, não suposto', () => {
    const { execSync } = require('child_process');
    const scripts = require('path').join(__dirname, '..', '..', 'scripts');
    const saida = execSync(`grep -rln "createClient" ${scripts} 2>/dev/null || true`, { encoding: 'utf8' });
    const achados = saida.split('\n').filter(Boolean);
    // Não é um defeito a consertar aqui: são ferramentas de mão, rodadas por uma
    // pessoa que vê o terminal pendurar. O que seria defeito é alguém ler a
    // afirmação de cima e concluir que o prazo vale pra elas também.
    expect(achados.length).toBeGreaterThan(0);
  });
});
