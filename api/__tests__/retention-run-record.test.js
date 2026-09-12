'use strict';

/**
 * A retenção deixa RASTRO, e outro cron olha o rastro.
 *
 * A 0031 construiu o expurgo e ele funciona; a metade que DETECTA não existia.
 * O único sinal de execução era uma linha de stderr e uma mensagem numa ponte
 * que vira no-op silencioso sem `RACHA_NOTIFY_SECRET` — e "a ausência da batida
 * é o alarme" só vale se alguma coisa alertar sobre a ausência. Nada alertava,
 * e em regime a batida diz zero todo dia, que é a mensagem mais fácil de parar
 * de ler que existe.
 *
 * Os dois portões pediram isto no mesmo lugar: uma linha por execução no
 * Postgres e uma checagem de 48h no cron que já pagina. É também o registro das
 * operações de tratamento do art. 37 — e é onde uma resposta do art. 18 §4
 * finalmente tem onde apontar, em vez de um terminal.
 */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
/**
 * A MIGRAÇÃO EM VIGOR, não a que inventou a tabela.
 *
 * Isto fixava `0032_retention_runs.sql` pelo nome — o mesmo defeito que a
 * rodada anterior consertou no `retention.test.js` e que eu deixei passar aqui.
 * Uma 0033 que re-declare `erase_payment_label`, que tire o `insert`, ou que dê
 * `disable row level security` deixaria tudo isto verde sobre texto morto — e
 * entre "isto" está o instrumento do art. 18 §4.
 *
 * Ressalva honesta: DDL é cumulativo, não substitutivo. "Último arquivo que
 * menciona a tabela" pega um `disable row level security` posterior, e não pega
 * um `grant` emitido fora do diretório de migrações. É o limite do que um censo
 * de fonte pode afirmar.
 */
function ultimaQueMenciona(agulha) {
  const dir = path.join(RAIZ, 'supabase', 'migrations');
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let achado = null;
  for (const f of arquivos) {
    const texto = fs.readFileSync(path.join(dir, f), 'utf8');
    if (texto.includes(agulha)) achado = { arquivo: f, texto };
  }
  return achado;
}

/** O corpo de uma função, do `create or replace` até o `$$;` que o fecha. */
function corpoDaFuncao(sql, nome) {
  const i = sql.indexOf(`create or replace function public.${nome}`);
  if (i < 0) return '';
  const fim = sql.indexOf('$$;', i);
  return fim < 0 ? sql.slice(i) : sql.slice(i, fim);
}

const PURGE = ultimaQueMenciona('create or replace function public.purge_expired_personal_data');
const ERASE = ultimaQueMenciona('create or replace function public.erase_payment_label');
const TABELA = ultimaQueMenciona('public.retention_runs');
const SQL = PURGE.texto;
const ROUTER = fs.readFileSync(path.join(RAIZ, 'api', '_app', 'router.js'), 'utf8');

const { createMemoryStore } = require('../_lib/store/memory');
const { avaliarRetencao, vigiarRetencao } = require('../_lib/checks/retention-watch');

describe('o expurgo deixa registro, e o registro é vigiado', () => {
  test('a gravação acontece DENTRO da função, na mesma transação', () => {
    // Registro que pode divergir do que aconteceu não é registro. Se o expurgo
    // reverter, a linha reverte junto — e é por isso que o insert mora no SQL
    // e não no chamador, que poderia falhar no meio.
    const corpo = corpoDaFuncao(PURGE.texto, 'purge_expired_personal_data');
    expect(corpo).toMatch(/insert into public\.retention_runs/);
    // E o insert vem DEPOIS dos updates: ele grava o que foi contado.
    expect(corpo.indexOf('insert into public.retention_runs'))
      .toBeGreaterThan(corpo.indexOf('get diagnostics v_views'));
  });

  test('o pedido do titular grava até quando não acha linha', () => {
    // "Pediram e não havia" é uma resposta do art. 18 §4 tanto quanto
    // "pediram e apagamos" — e é a que mais precisa de registro, porque é a
    // que alguém contestaria depois.
    const fn = corpoDaFuncao(ERASE.texto, 'erase_payment_label');
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toMatch(/insert into public\.retention_runs[\s\S]*'erasure_request'/);
    // Sem `if (v_n > 0)` em volta: grava sempre.
    expect(fn).not.toMatch(/if v_n > 0/);
  });

  test('a tabela é fechada pra anon e authenticated — na migração EM VIGOR', () => {
    expect(TABELA.texto).toMatch(/alter table public\.retention_runs enable row level security/);
    expect(TABELA.texto).toMatch(/revoke all on public\.retention_runs from anon, authenticated/);
    // A SEQUÊNCIA também: RLS não cobre sequência, grant é o único controle.
    expect(TABELA.texto).toMatch(/revoke all on sequence public\.retention_runs_id_seq/);
    // E nada de uma migração posterior reabrir.
    expect(TABELA.texto).not.toMatch(/disable row level security/);
  });

  test('as migrações em vigor são mesmo as últimas', () => {
    const dir = path.join(RAIZ, 'supabase', 'migrations');
    const todas = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const [nome, achado, agulha] of [
      ['purge', PURGE, 'create or replace function public.purge_expired_personal_data'],
      ['erase', ERASE, 'create or replace function public.erase_payment_label'],
      ['tabela', TABELA, 'public.retention_runs'],
    ]) {
      const candidatas = todas.filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(agulha));
      expect([nome, achado.arquivo]).toEqual([nome, candidatas[candidatas.length - 1]]);
    }
  });

  test('só expurgo confirmado e recente conta como saudável — todo o resto é atraso', () => {
    // A VERSÃO ANTERIOR DESTE TESTE NÃO TINHA DENTE NENHUM. A decisão morava
    // dentro da rota, o `router` não exporta a rota, e o teste só sabia
    // procurar substring no arquivo. A revisão de segurança rodou cinco
    // mutações e todas passaram verdes — incluindo `const retencaoAtrasada =
    // false && retencao`, que é o guarda desligado. E `toMatch(/48/)` casava o
    // `48` da própria mensagem, então dava pra tirar o limite da condição sem
    // quebrar nada.
    //
    // Agora a decisão é pura e exercida por tabela. A regra está escrita na
    // direção que falha FECHADA: saudável exige prova de expurgo recente.
    const agoraMs = Date.parse('2026-09-12T12:00:00Z');
    const h = (n) => ({ at: new Date(agoraMs - n * 3_600_000).toISOString() });

    const casos = [
      ['acabou de rodar',            avaliarRetencao(h(1), { agoraMs }),                 false],
      ['ontem',                      avaliarRetencao(h(23), { agoraMs }),                false],
      ['quase no limite',            avaliarRetencao(h(47), { agoraMs }),                false],
      ['no limite',                  avaliarRetencao(h(48), { agoraMs }),                true],
      ['dois dias e meio',           avaliarRetencao(h(60), { agoraMs }),                true],
      ['nunca rodou',                avaliarRetencao(null, { agoraMs }),                 true],
      ['registro sem data',          avaliarRetencao({}, { agoraMs }),                   true],
      ['data ilegível',              avaliarRetencao({ at: 'ontem' }, { agoraMs }),      true],
      ['data no futuro',             avaliarRetencao(h(-10), { agoraMs }),               true],
      ['erro ao ler o registro',     avaliarRetencao(null, { agoraMs, erro: 'read_failed' }), true],
    ];
    for (const [nome, r, esperado] of casos) {
      expect([nome, r.atrasada]).toEqual([nome, esperado]);
      // Atrasada SEMPRE produz texto; saudável nunca produz.
      expect([nome, r.linha !== '']).toEqual([nome, esperado]);
    }

    // E os três motivos de atraso se DISTINGUEM na frase. "Não consegui ler o
    // registro" e "nunca rodou" levam a ações diferentes de quem for consertar,
    // e sem isto o ramo do erro é redundante: ele cai no mesmo `atrasada: true`
    // do caminho nulo, e uma mutação que o apaga passa verde.
    expect(avaliarRetencao(null, { agoraMs, erro: 'read_failed' }).linha).toMatch(/não foi possível ler/);
    expect(avaliarRetencao(null, { agoraMs }).linha).toMatch(/nunca rodou/);
    expect(avaliarRetencao(h(60), { agoraMs }).linha).toMatch(/há 60h/);
  });

  test('a rota usa a decisão e manda o atraso como aviso PRÓPRIO', () => {
    const rota = ROUTER.slice(
      ROUTER.indexOf("url.pathname === '/api/cron/reconcile')"),
      ROUTER.indexOf("url.pathname === '/api/cron/activation-radar'"),
    );
    expect(rota.length).toBeGreaterThan(0);
    // Ler, decidir e AVISAR vêm juntos do módulo: a rota não tem mais uma linha
    // própria pra desligar. `if (false && ...)` passava com 677 verdes.
    expect(rota).toMatch(/vigiarRetencao\(store, notifyFounderMoneyEvent/);
    expect(rota).not.toMatch(/typeof store\.lastRetentionRun/);
    // E NÃO entra no `mensagem` da conciliação: retenção atrasada apagava a
    // batida noturna, e do outro lado a ausência da batida quer dizer "a
    // conciliação morreu" — higiene fabricando alarme de dinheiro.
    expect(rota).toMatch(/const mensagem = formatReconcileAlert\(report\);/);
    expect(rota).not.toMatch(/linhaRetencao/);
  });

  test('vigiar AVISA quando está atrasada, e cala quando está fresca', async () => {
    // A cobertura que faltava: a decisão estava exaustivamente testada e a linha
    // que AGE sobre ela não. `if (false && retencao.atrasada)` passava com 677
    // verdes — o guarda saiu da rota e o buraco andou uma linha.
    const chamadas = [];
    const notificar = async (e) => { chamadas.push(e); };

    const storeFresco = { lastRetentionRun: async () => ({ at: new Date().toISOString() }) };
    const r1 = await vigiarRetencao(storeFresco, notificar);
    expect(r1.atrasada).toBe(false);
    expect(chamadas).toEqual([]);

    const storeVelho = {
      lastRetentionRun: async () => ({ at: new Date(Date.now() - 72 * 3_600_000).toISOString() }),
    };
    const r2 = await vigiarRetencao(storeVelho, notificar);
    expect(r2.atrasada).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].kind).toBe('retention_late');
    expect(chamadas[0].detail).toMatch(/72h/);

    // Store que estoura conta como ATRASO — e só o token estável atravessa.
    const storeQuebrado = { lastRetentionRun: async () => { throw new Error('PGRST205 tabela sumiu'); } };
    const r3 = await vigiarRetencao(storeQuebrado, notificar);
    expect(r3.atrasada).toBe(true);
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1].detail).not.toMatch(/PGRST205/);

    // Store SEM o método: defeito de deploy, não configuração. Estoura pro
    // catch e vira atraso, em vez de sumir.
    const r4 = await vigiarRetencao({}, notificar);
    expect(r4.atrasada).toBe(true);
    expect(chamadas).toHaveLength(3);

    // `?dry=1` não avisa — mas também não mente sobre o estado.
    const r5 = await vigiarRetencao(storeVelho, notificar, { seco: true });
    expect(r5.atrasada).toBe(true);
    expect(chamadas).toHaveLength(3);
  });

  test('o store grava a execução e sabe ler a última', async () => {
    const store = createMemoryStore();
    expect(await store.lastRetentionRun()).toBeNull();

    const r = await store.purgeExpiredPersonalData();
    expect(r).toHaveProperty('payerLabels');

    const ultima = await store.lastRetentionRun();
    expect(ultima).not.toBeNull();
    expect(Date.parse(ultima.at)).toBeLessThanOrEqual(Date.now());

    // O pedido do titular NÃO conta como execução do expurgo — senão um pedido
    // manual mascararia um cron parado, que é precisamente o que este registro
    // existe pra impedir.
    const antes = (await store.lastRetentionRun()).at;
    await store.erasePaymentLabel('txid_que_nao_existe');
    expect((await store.lastRetentionRun()).at).toBe(antes);
  });
});
