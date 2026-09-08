'use strict';

/**
 * O CENSO que atravessa a fronteira JS/SQL.
 *
 * O achado mais caro da série, e o que menos parecia um achado: toda a suíte
 * usa o store de MEMÓRIA, cujo `appendEvent` aceita qualquer string. Nada no
 * repositório tocava SQL. Então três tipos de evento foram escritos, testados,
 * revisados e comitados enquanto o banco de produção os recusaria com 23514.
 *
 * E o sintoma seria pior que a falha: o `charge.dispute.created` chega, o
 * append estoura, a rota escreve uma linha em stderr e devolve 200. A Stripe é
 * informada de que tratamos o chargeback. A disputa nunca entra no log, os 40
 * dias de prova vencem em silêncio. Doze dias de uma afirmação quebrada, de
 * novo (inegociável #7).
 *
 * Um mock que aceita mais que a produção não é um mock, é uma armadilha. Este
 * teste é a única coisa no repositório que lê o esquema.
 *
 * Achado pela revisão de segurança de 2026-09-08.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EVENT_TYPES } = require('../_lib/checks/check-state');

const MIGRATIONS = path.join(__dirname, '..', '..', 'supabase', 'migrations');

/** Todo o SQL, na ordem em que roda. A ÚLTIMA definição de uma restrição vence. */
function sqlNaOrdem() {
  return fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

/**
 * Os valores da ÚLTIMA restrição `check (<coluna> in (…))` DAQUELA TABELA.
 *
 * Duas sutilezas, e as duas já morderam ao escrever este teste:
 *
 *  - "a última vence" é necessário, porque uma migração posterior derruba e
 *    recria a restrição (foi assim com `payments_method_check`);
 *  - "daquela tabela" é necessário porque o mesmo NOME DE COLUNA aparece em
 *    várias tabelas. `status` existe em `checks`, em `payments` e em
 *    `house_loads`, e sem escopo o teste lia a restrição da tabela errada e
 *    acusava um problema que não existia.
 */
function valoresDaRestricao(sql, tabela, coluna) {
  const re = new RegExp(
    `check\\s*\\(\\s*${coluna}\\s+in\\s*\\(([^)]*)\\)`,
    'gi',
  );
  let ultimo = null;
  for (const m of sql.matchAll(re)) {
    // De qual tabela é este `check`? A menção de tabela mais próxima ANTES
    // dele — `create table public.x` ou `alter table public.x`.
    const antes = sql.slice(0, m.index);
    const tabelas = [...antes.matchAll(/(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi)];
    const dona = tabelas.length ? tabelas[tabelas.length - 1][1] : null;
    if (dona === tabela) ultimo = m[1];
  }
  if (!ultimo) return null;
  return new Set([...ultimo.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

describe('o esquema aceita exatamente o que o código escreve', () => {
  test('check_events.type conhece TODOS os EVENT_TYPES', () => {
    const sql = sqlNaOrdem();
    const permitidos = valoresDaRestricao(sql, 'check_events', 'type');
    expect(permitidos).not.toBeNull();
    const faltando = [...EVENT_TYPES].filter((t) => !permitidos.has(t)).sort();
    // Isto é o que estava quebrado: PAYMENT_DISPUTED, PAYMENT_REFUND_REVERSED
    // e PAYMENT_DISPUTE_CLOSED escritos pelo código e recusados pelo banco.
    expect(faltando).toEqual([]);
    // E o contrário também: um tipo que o banco aceita e o código não conhece
    // é um evento que ninguém sabe reduzir.
    const orfaos = [...permitidos].filter((t) => !EVENT_TYPES.includes(t)).sort();
    expect(orfaos).toEqual([]);
  });

  test('payments.method conhece todo trilho que o código grava', () => {
    const sql = sqlNaOrdem();
    const permitidos = valoresDaRestricao(sql, 'payments', 'method');
    expect(permitidos).not.toBeNull();
    // Os trilhos vêm dos MERCADOS, mais o saldo da casa, que não é trilho de
    // PSP e por isso não está lá.
    const { MARKETS } = require('../_lib/markets');
    const trilhos = new Set(['house_account']);
    for (const m of Object.values(MARKETS)) for (const r of m.rails) trilhos.add(r);
    const faltando = [...trilhos].filter((t) => !permitidos.has(t)).sort();
    // `bizum` era o que faltava: toda cobrança espanhola falharia na inserção.
    expect(faltando).toEqual([]);
  });

  test('payments.status conhece todo status que o módulo de dinheiro resolve', () => {
    const sql = sqlNaOrdem();
    const permitidos = valoresDaRestricao(sql, 'payments', 'status');
    expect(permitidos).not.toBeNull();
    const { ROW_STATUS_FOR_KIND } = require('../_lib/pay/webhook-handler');
    const usados = new Set(Object.values(ROW_STATUS_FOR_KIND));
    usados.add('pendente'); // o padrão na criação da cobrança
    const faltando = [...usados].filter((s) => !permitidos.has(s)).sort();
    expect(faltando).toEqual([]);
  });

  test('a leitura do esquema não está vazia — um regex quebrado passaria calado', () => {
    // A armadilha deste tipo de teste: o regex para de casar, tudo vira
    // conjunto vazio, e o teste passa sem olhar nada.
    const sql = sqlNaOrdem();
    expect(sql.length).toBeGreaterThan(5000);
    expect(valoresDaRestricao(sql, 'check_events', 'type').size).toBeGreaterThanOrEqual(8);
    expect(valoresDaRestricao(sql, 'payments', 'method').size).toBeGreaterThanOrEqual(4);
  });
});
