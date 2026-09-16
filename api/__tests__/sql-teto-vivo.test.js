'use strict';

/**
 * O TETO DE COBRANÇAS, RODANDO NUM POSTGRES DE VERDADE.
 *
 * O `sql-contract.test.js` abre dizendo que nada neste repositório tocava SQL,
 * e que foi assim que três tipos de evento passaram por testes e revisões
 * enquanto o banco de produção os recusaria. A migração 0033 nasceu com o
 * mesmo risco: as duas revisões só podiam LÊ-la, e os testes do teto exercitam
 * o gêmeo em memória. Uma trava consultiva que não trava, uma janela que não
 * desliza, uma revogação que não revoga — nada disso aparece lendo.
 *
 * Então este teste sobe um Postgres descartável, aplica TODAS as migrações (com
 * um esqueleto do esquema `auth` da Supabase) e afirma o que
 * tem que ser verdade: contagem e reserva atômicas sob concorrência, ordem de
 * trava sem deadlock, janela deslizante com faxina, tudo-ou-nada com duas
 * chaves, argumentos inválidos recusados, `anon` e `authenticated` barrados.
 *
 * Sem `initdb`/`pg_ctl`/`psql` na máquina ele é PULADO — e pular é dito em voz
 * alta no nome do teste, como no portão de mutação Swift. Só TCP: o caminho de
 * socket Unix de um diretório temporário longo passa do limite de 103 bytes do
 * macOS, e foi o que derrubou a primeira tentativa deste harness.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');

// `MIGRACAO_0033` só existe pra prova de mutação: rodar este teste contra uma
// cópia MUTADA da migração e exigir que ele fique vermelho. Um teste que não
// consegue falhar é decoração.
const MIGRACAO = process.env.MIGRACAO_0033
  || path.join(__dirname, '..', '..', 'supabase', 'migrations', '0033_charge_slots.sql');
const temPg = ['initdb', 'pg_ctl', 'psql'].every((b) => {
  try { execFileSync('which', [b], { stdio: 'pipe' }); return true; } catch { return false; }
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// PULAR É A FORMA DEGRADA-ABERTA DE UM TESTE (revisão de segurança de
// 2026-09-15). Numa máquina de dev sem Postgres ele pula, e diz no nome; num
// ambiente que o EXIGE (`RACHA_EXIGE_PG=1`, o que um CI teria de setar) a
// ausência é falha, não silêncio.
if (!temPg && process.env.RACHA_EXIGE_PG === '1') {
  test('Postgres EXIGIDO (RACHA_EXIGE_PG=1) e ausente', () => {
    throw new Error('RACHA_EXIGE_PG=1 e não há initdb/pg_ctl/psql nesta máquina');
  });
}
const d = temPg ? describe : describe.skip;
d(temPg ? 'o teto no Postgres de verdade (migração 0033)' : 'o teto no Postgres de verdade — PULADO: sem initdb/pg_ctl/psql', () => {
  jest.setTimeout(120_000);
  let dir; let porta;
  const psqlArgs = (sql) => ['-X', '-q', '-t', '-A', '-h', '127.0.0.1', '-p', String(porta),
    '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql];
  const Q = (sql) => execFileSync('psql', psqlArgs(sql), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Uma sessão SEPARADA por chamada: é o que faz a concorrência ser de verdade.
  const Qa = (sql) => new Promise((ok) => {
    execFile('psql', psqlArgs(sql), { encoding: 'utf8' }, (err, out, errOut) => ok(err ? `ERRO ${errOut}` : out.trim()));
  });
  const QErr = (sql) => { try { Q(sql); return null; } catch (e) { return String(e.stderr || e.message); } };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg0033-'));
    execFileSync('initdb', ['-D', path.join(dir, 'data'), '-U', 'postgres', '-A', 'trust'], { stdio: 'pipe' });
    for (let tentativa = 0; tentativa < 3 && !porta; tentativa += 1) {
      const p = 55000 + Math.floor(Math.random() * 4000);
      try {
        execFileSync('pg_ctl', ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'),
          '-o', `-p ${p} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, 'start'], { stdio: 'pipe' });
        porta = p;
      } catch { /* porta ocupada: tenta outra */ }
    }
    if (!porta) throw new Error('não subiu o Postgres descartável');
    // Os papéis que a Supabase cria e que as migrações revogam.
    Q('create role anon; create role authenticated; create role service_role;');
    // E um ESQUELETO do esquema `auth`, que a Supabase provê e o Postgres puro
    // não tem — a 0003 já o referencia. Com ele, TODAS as migrações aplicam em
    // ordem, e este arquivo passa a exercitar a CADEIA de verdade — inclusive o
    // expurgo diário redefinido na 0033, que nenhum teste tinha rodado (as duas
    // revisões de 2026-09-15 apontaram: PL/pgSQL não resolve tabela na criação,
    // então um expurgo quebrado carregava sem erro).
    Q(`create schema auth;
       create table auth.users (id uuid primary key default gen_random_uuid(), email text);
       create function auth.uid() returns uuid language sql stable as 'select null::uuid';
       create function auth.role() returns text language sql stable as 'select ''service_role''::text';
       create function auth.jwt() returns jsonb language sql stable as 'select ''{}''::jsonb';`);
    const dirMig = path.join(__dirname, '..', '..', 'supabase', 'migrations');
    for (const f of fs.readdirSync(dirMig).filter((x) => x.endsWith('.sql')).sort()) {
      // A 0033 pode ser trocada por um MUTANTE (`MIGRACAO_0033`) — prova de mutação.
      const arq = f === '0033_charge_slots.sql' ? MIGRACAO : path.join(dirMig, f);
      execFileSync('psql', [...psqlArgs('select 1').slice(0, -2), '-f', arq], { stdio: 'pipe' });
    }
  });

  afterAll(() => {
    if (dir) {
      try { execFileSync('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', 'stop'], { stdio: 'pipe' }); } catch { /* já parado */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('conta, recusa no limite com a forma que o store lê, e devolve', () => {
    const claim = () => JSON.parse(Q("select claim_slots(array['check:c1'], array[2], 900)"));
    expect(claim().claim_id).toMatch(UUID);
    const segunda = claim();
    expect(segunda.claim_id).toMatch(UUID);
    expect(claim()).toEqual({ claim_id: null, full_index: 0, counts: [2] });
    expect(Number(Q(`select release_slots('${segunda.claim_id}')`))).toBe(1);
    expect(claim().claim_id).toMatch(UUID);
  });

  test.each([
    ["array['k'], array[1,2], 900", 'comprimentos diferentes'],
    ["array['k','k'], array[1,1], 900", 'chave repetida'],
    ["array['k'], array[1], 10", 'janela curta demais'],
    ['array[]::text[], array[]::int[], 900', 'sem chave'],
    ['null, array[1], 900', 'chaves nulas'],
    ["array['k'], array[null]::int[], 900", 'limite nulo — concedia sem fim'],
    ["array['k'], array[0], 900", 'limite zero'],
  ])('recusa argumento inválido: %s (%s)', (args) => {
    expect(QErr(`select claim_slots(${args})`)).toMatch(/argumentos inválidos/);
  });

  test('a janela DESLIZA e a faxina apaga as vencidas — lidas em statement PRÓPRIO', () => {
    // Ler a contagem no mesmo statement do claim devolve o instantâneo de
    // ANTES da função — foi o que enganou a primeira leitura deste harness.
    Q("insert into charge_slots(claim_id, slot_key, created_at) select gen_random_uuid(), 'check:w', now() - interval '20 minutes' from generate_series(1,5)");
    Q("insert into charge_slots(claim_id, slot_key, created_at) select gen_random_uuid(), 'check:w', now() - interval '5 minutes' from generate_series(1,2)");
    expect(JSON.parse(Q("select claim_slots(array['check:w'], array[3], 900)")).counts).toEqual([2]);
    expect(Q("select count(*) from charge_slots where slot_key='check:w' and created_at < now() - interval '15 minutes'")).toBe('0');
    expect(Q("select count(*) from charge_slots where slot_key='check:w'")).toBe('3');
    expect(JSON.parse(Q("select claim_slots(array['check:w'], array[3], 900)"))).toEqual({ claim_id: null, full_index: 0, counts: [3] });
  });

  test('faxina de mais de um dia alcança OUTRAS chaves — a tabela não cresce sem cron', () => {
    Q("insert into charge_slots(claim_id, slot_key, created_at) select gen_random_uuid(), 'check:velha', now() - interval '2 days' from generate_series(1,10)");
    Q("select claim_slots(array['check:outra'], array[5], 900)");
    expect(Q("select count(*) from charge_slots where slot_key='check:velha'")).toBe('0');
  });

  test('duas chaves: para na primeira cheia e não reserva NADA — tudo ou nada', () => {
    Q("select claim_slots(array['venue:v1'], array[1], 900)");
    expect(JSON.parse(Q("select claim_slots(array['account:a1','venue:v1'], array[10,1], 900)")))
      .toEqual({ claim_id: null, full_index: 1, counts: [0, 1] });
    expect(Q("select count(*) from charge_slots where slot_key='account:a1'")).toBe('0');
  });

  test('quarenta sessões simultâneas, limite vinte: exatamente vinte', async () => {
    /**
     * A PRIMEIRA VERSÃO DESTE TESTE NÃO PROVAVA A TRAVA. Com a trava consultiva
     * APAGADA da migração ela continuava dando exatamente vinte: cada `psql`
     * leva dezenas de milissegundos pra subir e conectar, o claim leva menos de
     * um, e as sessões ficavam em fila pelo arranque do processo. A janela de
     * corrida real vai da contagem até o COMMIT. Então cada sessão faz o claim
     * e segura a transação aberta um instante (`pg_sleep` no mesmo texto de
     * consulta, que roda numa transação só): com a trava, ela fica presa até o
     * commit e as sessões enfileiram; sem ela, os inserts ainda não commitados
     * não aparecem na contagem das outras, e o teto estoura. Pego pela prova de
     * mutação escrita junto com este arquivo.
     */
    const rs = (await Promise.all(Array.from({ length: 40 }, () =>
      Qa("select coalesce(claim_slots(array['check:corrida'], array[20], 900)->>'claim_id', 'CHEIO'); select pg_sleep(0.05);"))))
      .map((r) => r.split('\n')[0].trim());
    const vagas = rs.filter((r) => UUID.test(r)).length;
    const cheias = rs.filter((r) => r === 'CHEIO').length;
    expect({ vagas, cheias, erros: 40 - vagas - cheias }).toEqual({ vagas: 20, cheias: 20, erros: 0 });
    expect(Q("select count(*) from charge_slots where slot_key='check:corrida'")).toBe('20');
  });

  test('as mesmas duas chaves em ordens opostas, em paralelo: sem deadlock', async () => {
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => Qa(i % 2
      ? "select claim_slots(array['account:x','venue:y'], array[1000,1000], 900)->>'claim_id'"
      : "select claim_slots(array['venue:y','account:x'], array[1000,1000], 900)->>'claim_id'")));
    expect(rs.filter((r) => !UUID.test(r))).toEqual([]);
  });

  test('pilha de linhas velhas de MUITAS chaves e reivindicações concorrentes: nenhum deadlock', async () => {
    // A faxina cruzada sem `skip locked` fechava ciclo: A segura as linhas
    // velhas de X e espera pelas de Y; B segura as de Y e espera pelas de X.
    // Medido pela revisão de segurança de 2026-09-15: 364 deadlocks, cada um
    // um 500 numa recarga. As chaves que voltam de um dia pro outro são as de
    // CASA e de CONTA — as das recargas.
    Q("insert into charge_slots(claim_id, slot_key, created_at) select gen_random_uuid(), 'venue:v' || (g % 100), now() - interval '2 days' from generate_series(1, 6000) g");
    const rs = await Promise.all(Array.from({ length: 80 }, (_, i) =>
      Qa(`select coalesce(claim_slots(array['account:a${i}', 'venue:v${(i * 37) % 100}'], array[10, 1000], 900)->>'claim_id', 'CHEIO'); select pg_sleep(0.02);`)));
    const primeira = rs.map((r) => r.split('\n')[0].trim());
    expect(primeira.filter((r) => !UUID.test(r))).toEqual([]);
  });

  test('o gêmeo em memória recusa o que o SQL recusa, e decide igual no resto', async () => {
    // O mesmo quadro de entradas nos dois lados. O teste anterior "o gêmeo
    // decide como o SQL" rodava UMA entrada e nenhum SQL. (Segurança, LOW-1.)
    const { createMemoryStore } = require('../_lib/store/memory');
    const mem = createMemoryStore();
    const lit = (xs, tipo) => (xs.length ? `array[${xs.map((x) => (x === null ? 'null' : typeof x === 'string' ? `'${x}'` : x)).join(',')}]::${tipo}[]` : `array[]::${tipo}[]`);
    for (const c of [
      { keys: ['p1'], limits: [null], windowMs: 900000 },
      { keys: ['p1'], limits: [0], windowMs: 900000 },
      { keys: ['p1'], limits: [1], windowMs: 1000 },
      { keys: ['p1', 'p1'], limits: [1, 1], windowMs: 900000 },
      { keys: [], limits: [], windowMs: 900000 },
      { keys: ['p1'], limits: [1, 2], windowMs: 900000 },
    ]) {
      const sqlRecusa = /argumentos inválidos/.test(QErr(`select claim_slots(${lit(c.keys, 'text')}, ${lit(c.limits, 'int')}, ${Math.round(c.windowMs / 1000)})`) || '');
      const memRecusa = await mem.claimSlots(c).then(() => false, () => true);
      expect({ c, sqlRecusa, memRecusa }).toEqual({ c, sqlRecusa: true, memRecusa: true });
    }
    Q("select claim_slots(array['q1'], array[1], 900)");
    await mem.claimSlots({ keys: ['q1'], limits: [1], windowMs: 900000 });
    const sql = JSON.parse(Q("select claim_slots(array['q0','q1'], array[5,1], 900)"));
    const m = await mem.claimSlots({ keys: ['q0', 'q1'], limits: [5, 1], windowMs: 900000 });
    expect({ claimId: m.claimId, fullIndex: m.fullIndex, counts: m.counts })
      .toEqual({ claimId: sql.claim_id, fullIndex: sql.full_index, counts: sql.counts });
  });

  test('o EXPURGO DIÁRIO de verdade varre o livro pela JANELA, e grava o registro', () => {
    // O corte era "um dia" e o expurgo roda uma vez por dia: a linha vivia até
    // ~48 h enquanto o texto prometia "no máximo um dia". Pela janela, nada que
    // passou dos quinze minutos sobra. (Compliance, M5.)
    Q("insert into charge_slots(claim_id, slot_key, created_at) values (gen_random_uuid(), 'check:exp-velha', now() - interval '20 minutes'), (gen_random_uuid(), 'check:exp-nova', now())");
    const antes = Number(Q("select count(*) from retention_runs where kind = 'purge'"));
    Q('select purge_expired_personal_data(90, 90, 90)');
    expect(Q("select count(*) from charge_slots where slot_key = 'check:exp-velha'")).toBe('0');
    expect(Q("select count(*) from charge_slots where slot_key = 'check:exp-nova'")).toBe('1');
    // E o registro do art. 6º X sai na mesma transação.
    expect(Number(Q("select count(*) from retention_runs where kind = 'purge'"))).toBe(antes + 1);
  });

  test('a IMPRESSÃO DIGITAL no banco é a que o código espera — editar a 0033 sem atualizar o número fica VERMELHO', () => {
    // O portão de deploy e o cron comparam a impressão de produção com este
    // número. Se ele não fosse recalculado aqui, uma edição da 0033 deixaria o
    // portão recusando o banco CERTO — ou, pior, alguém copiaria o número de
    // produção pra cá. (Segurança M2 de 7a65e93.)
    const { IMPRESSAO_0033 } = require('../_lib/store/impressao-0033');
    expect(Q('select charge_slots_fingerprint()')).toBe(IMPRESSAO_0033);
  });

  test('o expurgo respeita a janela DE CADA LINHA — o contador diário de avisos sobrevive a ele', () => {
    // O corte fixo de quinze minutos zerava o contador diário todo dia no
    // expurgo: doze linhas de uma hora sumiam e o décimo terceiro aviso
    // passava. (Reproduzido pela segurança de 7a65e93, L1.)
    Q("insert into charge_slots(claim_id, slot_key, created_at, window_seconds) select gen_random_uuid(), 'alerta-dia:teste', now() - interval '1 hour', 86400 from generate_series(1, 12)");
    Q("insert into charge_slots(claim_id, slot_key, created_at, window_seconds) values (gen_random_uuid(), 'check:exp-janela', now() - interval '20 minutes', 900), (gen_random_uuid(), 'alerta:check:exp-6h', now() - interval '7 hours', 21600)");
    Q('select purge_expired_personal_data(90, 90, 90)');
    expect(Q("select count(*) from charge_slots where slot_key = 'alerta-dia:teste'")).toBe('12');
    expect(Q("select count(*) from charge_slots where slot_key in ('check:exp-janela', 'alerta:check:exp-6h')")).toBe('0');
    expect(JSON.parse(Q("select claim_slots(array['alerta-dia:teste'], array[12], 86400)")).claim_id).toBeNull();
  });

  test('a reivindicação grava a JANELA dela na linha — é o que o expurgo lê', () => {
    Q("select claim_slots(array['janela:x'], array[1], 3600)");
    expect(Q("select window_seconds from charge_slots where slot_key = 'janela:x'")).toBe('3600');
  });

  /**
   * O LANÇAMENTO CONDICIONAL DA 0034, no Postgres de verdade.
   *
   * O gêmeo em memória prova a regra; só aqui se prova que a TRAVA trava. Duas
   * sessões de verdade, cada uma autorizada pela mesma leitura do razão, é o
   * cenário exato que a revisão mediu: sem a conferência dentro da trava, as
   * duas gravam e a devolução sai pelo dobro do direito.
   */
  describe('0034 — compare-and-append', () => {
    let conta = null;
    beforeAll(() => {
      Q(`insert into venues (id, name, cnpj) values ('11111111-1111-4111-8111-111111111111', 'Casa 0034', '11222333000181')
         on conflict do nothing;
         insert into venue_tables (id, venue_id, label) values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Mesa 1')
         on conflict do nothing;`);
      conta = Q(`insert into checks (venue_id, table_id, total_cents) values
        ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 10000) returning id;`).trim();
      Q(`select append_check_event('${conta}'::uuid, 'OPENED', '{"totalCents":10000}'::jsonb);`);
    });

    test('grava quando o razão está no seq esperado, e RECUSA com 40001 quando andou', () => {
      const seq = Number(Q(`select append_check_event_if_unchanged('${conta}'::uuid, 'PAYMENT_CONFIRMED',
        '{"txid":"t1","amountCents":10000,"tipCents":0,"method":"pix"}'::jsonb, null, 1);`));
      expect(seq).toBe(2);
      // O MESMO seq esperado, de novo: o razão andou.
      const erro = QErr(`select append_check_event_if_unchanged('${conta}'::uuid, 'CLOSED', '{}'::jsonb, null, 1);`);
      expect(erro).toMatch(/o razão mudou/);
      // E nada foi gravado.
      expect(Number(Q(`select count(*) from check_events where check_id = '${conta}'::uuid;`))).toBe(2);
    });

    test('seq esperado AUSENTE é recusado — o portão não pode ser pulado por omissão', () => {
      expect(QErr(`select append_check_event_if_unchanged('${conta}'::uuid, 'CLOSED', '{}'::jsonb, null, null);`))
        .toMatch(/expected_seq obrigatório/);
    });

    test('DUAS sessões de verdade na mesma leitura: uma grava, a outra é recusada', async () => {
      const antes = Number(Q(`select coalesce(max(seq), 0) from check_events where check_id = '${conta}'::uuid;`));
      const payload = (ref) => `'{"txid":"t1","amountCents":100,"tipCents":0,"offRail":true,"reference":"${ref}"}'::jsonb`;
      const [a, b] = await Promise.all([
        Qa(`select append_check_event_if_unchanged('${conta}'::uuid, 'PAYMENT_REFUNDED', ${payload('E2E-A')}, null, ${antes});`),
        Qa(`select append_check_event_if_unchanged('${conta}'::uuid, 'PAYMENT_REFUNDED', ${payload('E2E-B')}, null, ${antes});`),
      ]);
      const falhas = [a, b].filter((r) => /ERRO/.test(r));
      expect(falhas.length).toBe(1);
      expect(falhas[0]).toMatch(/o razão mudou/);
      expect(Number(Q(`select count(*) from check_events where check_id = '${conta}'::uuid;`))).toBe(antes + 1);
    });

    test('a MESMA referência não entra duas vezes — caixa e espaço não criam outra', () => {
      const seq = Number(Q(`select coalesce(max(seq), 0) from check_events where check_id = '${conta}'::uuid;`));
      // A que venceu a corrida acima — seja qual for.
      const gravada = Q(`select payload->>'reference' from check_events
        where check_id = '${conta}'::uuid and type = 'PAYMENT_REFUNDED' order by seq limit 1;`).trim();
      expect(gravada).toMatch(/^E2E-[AB]$/);
      // O mesmo comprovante, como ele volta colado de outro lugar.
      const repetida = `  ${gravada.toLowerCase()} `;
      const erro = QErr(`select append_check_event_if_unchanged('${conta}'::uuid, 'PAYMENT_REFUNDED',
        '{"txid":"t1","amountCents":100,"tipCents":0,"offRail":true,"reference":"${repetida}"}'::jsonb, null, ${seq});`);
      expect(erro).toMatch(/check_events_offrail_refund_uidx|duplicate key/);
      // E a OUTRA referência, que é outro ato, entra.
      const outra = gravada === 'E2E-A' ? 'E2E-Z' : 'E2E-Y';
      expect(QErr(`select append_check_event_if_unchanged('${conta}'::uuid, 'PAYMENT_REFUNDED',
        '{"txid":"t1","amountCents":100,"tipCents":0,"offRail":true,"reference":"${outra}"}'::jsonb, null, ${seq});`))
        .toBeNull();
    });

    test('uma devolução NO TRILHO (sem offRail) não entra no índice — pode repetir referência', () => {
      const seq = Number(Q(`select coalesce(max(seq), 0) from check_events where check_id = '${conta}'::uuid;`));
      const erro = QErr(`select append_check_event_if_unchanged('${conta}'::uuid, 'PAYMENT_REFUNDED',
        '{"txid":"t1","amountCents":1,"tipCents":0,"reference":"E2E-A"}'::jsonb, null, ${seq});`);
      expect(erro).toBeNull();
    });

    test('anon e authenticated não executam o lançamento condicional', () => {
      for (const papel of ['anon', 'authenticated']) {
        Q(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${papel}') then create role ${papel}; end if; end $$;`);
        expect(QErr(`set role ${papel}; select append_check_event_if_unchanged('${conta}'::uuid, 'CLOSED', '{}'::jsonb, null, 1);`))
          .toMatch(/permission denied|permissão negada/i);
      }
    });
  });

  test('anon e authenticated não executam nem leem', () => {
    expect(QErr('set role anon; select charge_slots_fingerprint()')).toMatch(/permission denied/);
    expect(QErr("set role anon; select claim_slots(array['check:x'], array[1], 900)")).toMatch(/permission denied/);
    expect(QErr('set role authenticated; select release_slots(gen_random_uuid())')).toMatch(/permission denied/);
    expect(QErr('set role anon; select count(*) from charge_slots')).toMatch(/permission denied/);
  });
});
