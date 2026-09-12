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
const SQL = fs.readFileSync(
  path.join(RAIZ, 'supabase', 'migrations', '0032_retention_runs.sql'), 'utf8');
const ROUTER = fs.readFileSync(path.join(RAIZ, 'api', '_app', 'router.js'), 'utf8');

const { createMemoryStore } = require('../_lib/store/memory');

describe('o expurgo deixa registro, e o registro é vigiado', () => {
  test('a gravação acontece DENTRO da função, na mesma transação', () => {
    // Registro que pode divergir do que aconteceu não é registro. Se o expurgo
    // reverter, a linha reverte junto — e é por isso que o insert mora no SQL
    // e não no chamador, que poderia falhar no meio.
    const corpo = SQL.slice(SQL.indexOf('purge_expired_personal_data('), SQL.indexOf('$$;'));
    expect(corpo).toMatch(/insert into public\.retention_runs/);
    // E o insert vem DEPOIS dos updates: ele grava o que foi contado.
    expect(corpo.indexOf('insert into public.retention_runs'))
      .toBeGreaterThan(corpo.indexOf('get diagnostics v_views'));
  });

  test('o pedido do titular grava até quando não acha linha', () => {
    // "Pediram e não havia" é uma resposta do art. 18 §4 tanto quanto
    // "pediram e apagamos" — e é a que mais precisa de registro, porque é a
    // que alguém contestaria depois.
    const corpo = SQL.slice(SQL.indexOf('erase_payment_label(p_txid text)'));
    const fim = corpo.indexOf('$$;');
    const fn = corpo.slice(0, fim);
    expect(fn).toMatch(/insert into public\.retention_runs[\s\S]*'erasure_request'/);
    // Sem `if (v_n > 0)` em volta: grava sempre.
    expect(fn).not.toMatch(/if v_n > 0/);
  });

  test('a tabela é fechada pra anon e authenticated', () => {
    expect(SQL).toMatch(/alter table public\.retention_runs enable row level security/);
    expect(SQL).toMatch(/revoke all on public\.retention_runs from anon, authenticated/);
  });

  test('o cron que já pagina confere a idade do último expurgo', () => {
    const rota = ROUTER.slice(
      ROUTER.indexOf("url.pathname === '/api/cron/reconcile'"),
      ROUTER.indexOf("url.pathname === '/api/cron/activation-radar'"),
    );
    expect(rota).toMatch(/lastRetentionRun/);
    expect(rota).toMatch(/48/);
    // Nunca rodou conta como atrasado — senão um banco novo fica verde pra
    // sempre, que é o modo de falha que o canário vermelho evita.
    //
    // Ancorado na CONDIÇÃO, não no arquivo: a primeira versão procurava
    // `horas === null` em qualquer lugar da rota, e a frase também aparece no
    // ternário da mensagem — tirar o termo do `if` passava verde. Mesma forma
    // que já apareceu em três censos desta série.
    const condicao = rota.slice(rota.indexOf('const retencaoAtrasada'));
    expect(condicao.slice(0, condicao.indexOf(';'))).toMatch(/horas === null/);
    // E a checagem NÃO pode derrubar a conciliação: higiene não cala dinheiro.
    const trecho = rota.slice(rota.indexOf('lastRetentionRun') - 400, rota.indexOf('lastRetentionRun') + 400);
    expect(trecho).toMatch(/try \{/);
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
