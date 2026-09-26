'use strict';

/**
 * A `adjust_check` (0038) NUM POSTGRES DE VERDADE — com TODAS as migrações em
 * ordem, num cluster descartável (a forma do `sql-teto-vivo.test.js`).
 *
 * A revisão de segurança do PR #29 mediu no Postgres o que o teste de texto e
 * o dublê em memória não viam: elemento `{}`/`null`/`"lixo"` passava pelo
 * filtro (NULL dos dois lados do `or`) e ia parar no `pos_ref` do QR público.
 * Paridade "verde" com o dublê não prova a SQL — só rodar a SQL prova.
 *
 * Sem initdb/pg_ctl/psql na máquina, PULA dizendo que pulou; com
 * `RACHA_EXIGE_PG=1`, falha.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');

const temPg = ['initdb', 'pg_ctl', 'psql'].every((b) => {
  try { execFileSync('which', [b], { stdio: 'pipe' }); return true; } catch { return false; }
});
if (!temPg && process.env.RACHA_EXIGE_PG === '1') {
  test('Postgres EXIGIDO (RACHA_EXIGE_PG=1) e ausente', () => {
    throw new Error('RACHA_EXIGE_PG=1 e não há initdb/pg_ctl/psql nesta máquina');
  });
}
const d = temPg ? describe : describe.skip;
d(temPg ? 'adjust_check no Postgres de verdade (0038)' : 'adjust_check no Postgres de verdade — PULADO: sem initdb/pg_ctl/psql', () => {
  jest.setTimeout(120_000);
  let dir; let porta; let conta;
  const psqlArgs = (sql) => ['-X', '-q', '-t', '-A', '-h', '127.0.0.1', '-p', String(porta),
    '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql];
  const Q = (sql) => execFileSync('psql', psqlArgs(sql), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const Qa = (sql) => new Promise((ok) => {
    execFile('psql', psqlArgs(sql), { encoding: 'utf8' }, (err, out, errOut) => ok(err ? `ERRO ${errOut}` : out.trim()));
  });
  const QErr = (sql) => { try { Q(sql); return null; } catch (e) { return String(e.stderr || e.message); } };
  const lit = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  const ajustar = (seq, total, itens) => `select public.adjust_check('${conta}', ${seq}, ${total}, ${lit(itens)}::jsonb)`;
  const seqAtual = () => Number(Q(`select coalesce(max(seq), 0) from check_events where check_id = '${conta}'`));
  const foto = () => Q(`select total_cents || '|' || pos_ref || '|' || (select count(*) from check_events where check_id = '${conta}') from checks where id = '${conta}'`);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg0038-'));
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
    Q('create role anon; create role authenticated; create role service_role;');
    Q(`create schema auth;
       create table auth.users (id uuid primary key default gen_random_uuid(), email text);
       create function auth.uid() returns uuid language sql stable as 'select null::uuid';
       create function auth.role() returns text language sql stable as 'select ''service_role''::text';
       create function auth.jwt() returns jsonb language sql stable as 'select ''{}''::jsonb';`);
    const dirMig = path.join(__dirname, '..', '..', 'supabase', 'migrations');
    for (const f of fs.readdirSync(dirMig).filter((x) => x.endsWith('.sql')).sort()) {
      execFileSync('psql', [...psqlArgs('select 1').slice(0, -2), '-f', path.join(dirMig, f)], { stdio: 'pipe' });
    }
    Q(`insert into venues (id, name) values ('00000000-0000-0000-0000-00000000000a', 'Casa');
       insert into venue_tables (id, venue_id, label) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000a', 'Mesa 1');`);
    conta = Q(`select public.open_check('00000000-0000-0000-0000-0000000000b1', 1000, ${lit([{ id: 'i1', name: 'A', priceCents: 1000 }])})`);
  });

  afterAll(() => {
    if (dir) {
      try { execFileSync('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', 'stop'], { stdio: 'pipe' }); } catch { /* já parado */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('feliz: evento com os itens, pos_ref e total_cents juntos', () => {
    const itens = [{ id: 'i1', name: 'A', priceCents: 1000 }, { id: 'i2', name: 'B', priceCents: 500 }];
    expect(Number(Q(ajustar(1, 1500, itens)))).toBe(2);
    const ev = JSON.parse(Q(`select payload::text from check_events where check_id = '${conta}' and seq = 2`));
    expect(ev).toEqual({ totalCents: 1500, items: itens });
    expect(Q(`select total_cents from checks where id = '${conta}'`)).toBe('1500');
    expect(JSON.parse(Q(`select pos_ref from checks where id = '${conta}'`))).toEqual(itens);
  });

  test('recusas com 22023 ou 40001, e NADA muda', () => {
    const antes = foto();
    const seq = seqAtual();
    const casos = [
      [seq - 1, 2000, [{ name: 'X', priceCents: 2000 }], '40001'],                    // seq velho
      [seq, 2000, [{ name: 'X', priceCents: 1999 }], '22023'],                         // soma errada
      [seq, 1000, [{ name: 'X', priceCents: 1000 }, {}], '22023'],                     // M-1: objeto vazio
      [seq, 1000, [{ name: 'X', priceCents: 1000 }, null], '22023'],                   // M-1: null
      [seq, 1000, [{ name: 'X', priceCents: 1000 }, 'lixo'], '22023'],                 // M-1: texto
      [seq, 1000, [{ name: 'X', priceCents: 1000 }, 42, [1]], '22023'],                // M-1: número, array
      [seq, 1000, [{ priceCents: 1000 }], '22023'],                                   // sem nome
      [seq, 100, [{ name: 'X', priceCents: '100' }], '22023'],                         // valor texto
      [seq, 100, [{ name: 'X', priceCents: 10.5 }, { name: 'Y', priceCents: 89.5 }], '22023'],
      [seq, 100, Array.from({ length: 201 }, () => ({ name: 'X', priceCents: 0 })).concat([{ name: 'Y', priceCents: 100 }]), '22023'], // > 200
      [seq, 0, [{ name: 'X', priceCents: 0 }], '22023'],                               // total zero
    ];
    for (const [s, total, itens, codigo] of casos) {
      const err = QErr(`do $$ begin perform public.adjust_check('${conta}', ${s}, ${total}, ${lit(itens)}::jsonb);
        exception when others then raise exception 'CODIGO=%', sqlstate; end $$`);
      expect([JSON.stringify(itens).slice(0, 40), err && err.match(/CODIGO=(\w+)/)[1]]).toEqual([JSON.stringify(itens).slice(0, 40), codigo]);
    }
    expect(foto()).toBe(antes);
  });

  test('corrida de verdade entre duas sessões: uma vence, a outra leva 40001, a conta fica coerente', async () => {
    const seq = seqAtual();
    const a = Qa(`begin; ${ajustar(seq, 3000, [{ id: 'a', name: 'A', priceCents: 3000 }])}; select pg_sleep(1); commit;`);
    await new Promise((r) => setTimeout(r, 300));
    const b = await Qa(ajustar(seq, 4000, [{ id: 'b', name: 'B', priceCents: 4000 }]));
    const ra = await a;
    expect(ra).toMatch(/^\d+/);
    expect(b).toMatch(/ERRO[\s\S]*o razão mudou/);
    const [total, posRef] = [Q(`select total_cents from checks where id = '${conta}'`), JSON.parse(Q(`select pos_ref from checks where id = '${conta}'`))];
    const ultimo = JSON.parse(Q(`select payload::text from check_events where check_id = '${conta}' order by seq desc limit 1`));
    expect([total, posRef, ultimo]).toEqual(['3000', [{ id: 'a', name: 'A', priceCents: 3000 }], { totalCents: 3000, items: [{ id: 'a', name: 'A', priceCents: 3000 }] }]);
  });

  test('conta fechada não se ajusta, nem direto na função', () => {
    Q(`select public.append_check_event('${conta}', 'CLOSED', '{}'::jsonb, null)`);
    const antes = foto();
    const err = QErr(ajustar(seqAtual(), 500, [{ name: 'X', priceCents: 500 }]));
    expect(err).toMatch(/conta fechada/);
    expect(foto()).toBe(antes);
  });

  test('só o service_role executa', () => {
    expect(Q(`select has_function_privilege('anon', 'public.adjust_check(uuid, integer, bigint, jsonb)', 'execute')
      || '|' || has_function_privilege('authenticated', 'public.adjust_check(uuid, integer, bigint, jsonb)', 'execute')`)).toBe('false|false');
  });

  test('0039: open_check põe os itens no OPENED só quando o pos_ref é lista de itens que soma o total', () => {
    const abrir = (mesa, total, posRef) => {
      Q(`insert into venue_tables (id, venue_id, label) values ('${mesa}', '00000000-0000-0000-0000-00000000000a', 'Mesa ${mesa.slice(-2)}')`);
      const id = Q(`select public.open_check('${mesa}', ${total}, ${posRef === null ? 'null' : `'${posRef.replace(/'/g, "''")}'`})`);
      return JSON.parse(Q(`select payload::text from check_events where check_id = '${id}' and seq = 1`));
    };
    const itens = [{ id: 'a', name: 'A', priceCents: 700 }, { id: 'b', name: 'B', priceCents: 300 }];
    expect(abrir('00000000-0000-0000-0000-0000000000c1', 1000, JSON.stringify(itens))).toEqual({ totalCents: 1000, items: itens });
    // Um id de comanda de POS não é lista de itens: abre como antes.
    expect(abrir('00000000-0000-0000-0000-0000000000c2', 1000, 'COLIBRI-4471')).toEqual({ totalCents: 1000 });
    expect(abrir('00000000-0000-0000-0000-0000000000c3', 1000, null)).toEqual({ totalCents: 1000 });
    // Lista que NÃO soma o total, ou com elemento ruim: sem itens no evento.
    expect(abrir('00000000-0000-0000-0000-0000000000c4', 1000, JSON.stringify([{ name: 'A', priceCents: 999 }]))).toEqual({ totalCents: 1000 });
    expect(abrir('00000000-0000-0000-0000-0000000000c5', 1000, JSON.stringify([{ name: 'A', priceCents: 1000 }, null]))).toEqual({ totalCents: 1000 });
    // Acima de 64 KB: abre, mas sem itens no evento (o teto da 0038).
    expect(abrir('00000000-0000-0000-0000-0000000000c6', 1000, JSON.stringify([{ name: 'A'.repeat(70000), priceCents: 1000 }]))).toEqual({ totalCents: 1000 });
  });

  test('0040: as funções da carteira recusam com CÓDIGO (a frase não decide mais)', () => {
    const codigo = (sql) => {
      const err = QErr(`do $$ begin perform ${sql}; exception when others then raise exception 'CODIGO=%', sqlstate; end $$`);
      return err && err.match(/CODIGO=(\w+)/)[1];
    };
    expect(codigo("public.house_redeem(gen_random_uuid(), gen_random_uuid(), 't1', 0, now()::text)")).toBe('22023');
    expect(codigo("public.house_redeem(gen_random_uuid(), gen_random_uuid(), 't1', 100, now()::text)")).toBe('RH005');
    expect(codigo("public.house_refund_principal(gen_random_uuid(), 100, now()::text)")).toBe('RH005');
    expect(codigo("public.append_house_payment_guarded(gen_random_uuid(), 't1', 100)")).toBe('RH004');
    // Conta FECHADA: a conta do começo do arquivo foi fechada no teste acima.
    expect(codigo(`public.append_house_payment_guarded('${conta}', 't2', 100)`)).toBe('RH002');
  });

  test('0041: house_redeem recusa (RH006) o retry de um débito já estornado', () => {
    // IDs e telefone ÚNICOS por execução: com fixos, o teste dependia da ordem
    // e falhava rodando sozinho ou duas vezes no mesmo banco (segurança, PR #35).
    const conta = require('node:crypto').randomUUID();
    const fone = `119${String(Date.now()).slice(-8)}`;
    Q(`insert into house_accounts (id, venue_id, phone, name, account_token, principal_cents)
       values ('${conta}', '00000000-0000-0000-0000-00000000000a', '${fone}', 'B', 'tok-${conta}', 5000)`);
    const agora = new Date().toISOString();
    Q(`select public.house_redeem('${conta}', gen_random_uuid(), 'ha_${conta.slice(0, 8)}', 1000, '${agora}')`);
    Q(`select public.house_redeem_reverse('${conta}', 'ha_${conta.slice(0, 8)}', '${agora}')`);
    const err = QErr(`do $$ begin perform public.house_redeem('${conta}', gen_random_uuid(), 'ha_${conta.slice(0, 8)}', 1000, '${agora}');
      exception when others then raise exception 'CODIGO=%', sqlstate; end $$`);
    expect(err && err.match(/CODIGO=(\w+)/)[1]).toBe('RH006');
    expect(Q(`select principal_cents from house_accounts where id = '${conta}'`)).toBe('5000');
  });

  test('0042: o estorno recusa (RH007) quando o pagamento daquele txid já entrou na conta', () => {
    const conta = require('node:crypto').randomUUID();
    const fone = `118${String(Date.now()).slice(-8)}`;
    Q(`insert into house_accounts (id, venue_id, phone, name, account_token, principal_cents)
       values ('${conta}', '00000000-0000-0000-0000-00000000000a', '${fone}', 'B', 'tok-${conta}', 5000)`);
    Q(`insert into venue_tables (id, venue_id, label) values ('${conta}', '00000000-0000-0000-0000-00000000000a', 'M ${fone}')`);
    const check = Q(`select public.open_check('${conta}', 3000, null)`);
    const txid = `ha_${conta.slice(0, 8)}`;
    const agora = new Date().toISOString();
    Q(`select public.house_redeem('${conta}', '${check}', '${txid}', 1000, '${agora}')`);
    Q(`select public.append_house_payment_guarded('${check}', '${txid}', 1000)`);
    const err = QErr(`do $$ begin perform public.house_redeem_reverse('${conta}', '${txid}', '${agora}');
      exception when others then raise exception 'CODIGO=%', sqlstate; end $$`);
    expect(err && err.match(/CODIGO=(\w+)/)[1]).toBe('RH007');
    expect(Q(`select principal_cents from house_accounts where id = '${conta}'`)).toBe('4000');   // o débito ficou
    expect(Q(`select count(*) from house_account_events where account_id = '${conta}' and type = 'REDEEM_REVERSED'`)).toBe('0');
  });

  test('0042, a OUTRA ordem: débito estornado ANTES do lançamento → o append recusa (RH006) e a conta não fica paga', () => {
    const conta = require('node:crypto').randomUUID();
    const fone = `117${String(Date.now()).slice(-8)}`;
    Q(`insert into house_accounts (id, venue_id, phone, name, account_token, principal_cents)
       values ('${conta}', '00000000-0000-0000-0000-00000000000a', '${fone}', 'B', 'tok-${conta}', 5000)`);
    Q(`insert into venue_tables (id, venue_id, label) values ('${conta}', '00000000-0000-0000-0000-00000000000a', 'M ${fone}')`);
    const check = Q(`select public.open_check('${conta}', 3000, null)`);
    const txid = `ha_${conta.slice(0, 8)}`;
    const agora = new Date().toISOString();
    Q(`select public.house_redeem('${conta}', '${check}', '${txid}', 1000, '${agora}')`);
    Q(`select public.house_redeem_reverse('${conta}', '${txid}', '${agora}')`);
    const err = QErr(`do $$ begin perform public.append_house_payment_guarded('${check}', '${txid}', 1000);
      exception when others then raise exception 'CODIGO=%', sqlstate; end $$`);
    expect(err && err.match(/CODIGO=(\w+)/)[1]).toBe('RH006');
    expect(Q(`select count(*) from check_events where check_id = '${check}' and type = 'PAYMENT_CONFIRMED'`)).toBe('0');
    expect(Q(`select principal_cents from house_accounts where id = '${conta}'`)).toBe('5000');
  });

  test('0043: o append da carteira só lança com DÉBITO que pague — sem débito, outro valor ou outra conta: RH009, nada gravado', () => {
    const conta = require('node:crypto').randomUUID();
    const fone = `115${String(Date.now()).slice(-8)}`;
    Q(`insert into house_accounts (id, venue_id, phone, name, account_token, principal_cents)
       values ('${conta}', '00000000-0000-0000-0000-00000000000a', '${fone}', 'B', 'tok-${conta}', 5000)`);
    Q(`insert into venue_tables (id, venue_id, label) values ('${conta}', '00000000-0000-0000-0000-00000000000a', 'M ${fone}')`);
    const outraMesa = require('node:crypto').randomUUID();
    Q(`insert into venue_tables (id, venue_id, label) values ('${outraMesa}', '00000000-0000-0000-0000-00000000000a', 'N ${fone}')`);
    const check = Q(`select public.open_check('${conta}', 3000, null)`);
    const outra = Q(`select public.open_check('${outraMesa}', 3000, null)`);
    const agora = new Date().toISOString();
    const codigoDe = (sql) => {
      const err = QErr(`do $$ begin perform ${sql}; exception when others then raise exception 'CODIGO=%', sqlstate; end $$`);
      return err && err.match(/CODIGO=(\w+)/)[1];
    };
    // 1. txid sem débito nenhum
    expect(codigoDe(`public.append_house_payment_guarded('${check}', 'ha_semdebito', 1000)`)).toBe('RH009');
    // 2. débito de 1000, lançamento de 2000 — e lançamento de 1000 em OUTRA conta
    const txid = `ha_${conta.slice(0, 8)}`;
    Q(`select public.house_redeem('${conta}', '${check}', '${txid}', 1000, '${agora}')`);
    expect(codigoDe(`public.append_house_payment_guarded('${check}', '${txid}', 2000)`)).toBe('RH009');
    expect(codigoDe(`public.append_house_payment_guarded('${outra}', '${txid}', 1000)`)).toBe('RH009');
    expect(Q(`select count(*) from check_events where check_id in ('${check}', '${outra}') and type = 'PAYMENT_CONFIRMED'`)).toBe('0');
    // 3. o certo entra — e o replay devolve o mesmo seq
    const seq = Q(`select public.append_house_payment_guarded('${check}', '${txid}', 1000)`);
    expect(Q(`select public.append_house_payment_guarded('${check}', '${txid}', 1000)`)).toBe(seq);
    // 4. sem débito E excedendo: RH009, não RH003 (o 409 mandaria estornar um débito que não existe)
    expect(codigoDe(`public.append_house_payment_guarded('${check}', 'ha_excede', 9999)`)).toBe('RH009');
    // 5. débito ESTORNADO: RH006 vence o RH009 — "tente de novo" (409), não 500
    //    (segurança, PR #42, LOW-2: a ordem dos blocos é o contrato).
    const txid2 = `hb_${conta.slice(0, 8)}`;
    Q(`select public.house_redeem('${conta}', '${check}', '${txid2}', 500, '${agora}')`);
    Q(`select public.house_redeem_reverse('${conta}', '${txid2}', '${agora}')`);
    expect(codigoDe(`public.append_house_payment_guarded('${check}', '${txid2}', 500)`)).toBe('RH006');
    // 6. estornar um débito que NÃO existe: RH010 (antes, P0001 só com a frase)
    expect(codigoDe(`public.house_redeem_reverse('${conta}', 'ha_nunca_existiu', '${agora}')`)).toBe('RH010');
  });

  test('0042 (CRÍTICO): house_redeem recusa (RH008) um "duplicado" de outra conta ou outro valor', () => {
    const conta = require('node:crypto').randomUUID();
    const fone = `116${String(Date.now()).slice(-8)}`;
    Q(`insert into house_accounts (id, venue_id, phone, name, account_token, principal_cents)
       values ('${conta}', '00000000-0000-0000-0000-00000000000a', '${fone}', 'B', 'tok-${conta}', 5000)`);
    const agora = new Date().toISOString();
    const x = require('node:crypto').randomUUID();
    Q(`select public.house_redeem('${conta}', '${x}', 'ha_k', 100, '${agora}')`);
    const codigo = (sql) => { const e = QErr(`do $$ begin perform ${sql}; exception when others then raise exception 'CODIGO=%', sqlstate; end $$`); return e && e.match(/CODIGO=(\w+)/)[1]; };
    expect(codigo(`public.house_redeem('${conta}', gen_random_uuid(), 'ha_k', 100, '${agora}')`)).toBe('RH008');   // outra conta
    expect(codigo(`public.house_redeem('${conta}', '${x}', 'ha_k', 3000, '${agora}')`)).toBe('RH008');            // outro valor
    expect(Q(`select (public.house_redeem('${conta}', '${x}', 'ha_k', 100, '${agora}'))->>'duplicate'`)).toBe('true');   // o MESMO segue duplicate
    expect(Q(`select principal_cents from house_accounts where id = '${conta}'`)).toBe('4900');
  });
});
