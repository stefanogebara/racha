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

describe('as projeções SQL conhecem os mesmos eventos que o redutor', () => {
  /**
   * O lado SQL do razão fica pra trás quando o lado JS ganha tipo de evento —
   * aconteceu duas vezes na mesma série. O CHECK de `check_events.type`
   * (migração 0017) e a guarda da carteira (0019).
   *
   * A guarda calculava "quanto já foi pago" somando `PAYMENT_CONFIRMED` e
   * subtraindo `PAYMENT_REFUNDED`, e nunca soube de `PAYMENT_REFUND_REVERSED`
   * — o estorno que falhou, com o dinheiro voltando pro restaurante. Ela
   * subtraía um estorno desfeito, via a conta como mais em aberto do que
   * estava, e AUTORIZAVA gastar saldo da casa que não cabia. Duas contagens do
   * mesmo dinheiro discordando, e a que discorda é a que autoriza gastar.
   *
   * O store de memória sempre esteve certo, porque usa o redutor. Só o espelho
   * SQL divergia — e nenhum teste lia SQL.
   */
  test('a guarda de resgate da carteira conta o estorno REVERTIDO', () => {
    const sql = sqlNaOrdem();
    // A última definição da função é a que vale.
    const defs = [...sql.matchAll(/create or replace function public\.append_house_payment_guarded[\s\S]*?\$\$;/g)];
    expect(defs.length).toBeGreaterThanOrEqual(1);
    const ultima = defs[defs.length - 1][0];
    for (const tipo of ['PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'PAYMENT_REFUND_REVERSED']) {
      expect(ultima).toContain(tipo);
    }
  });

  test('nenhuma função SQL redefinida trocou de assinatura sem querer', () => {
    // `create or replace` só substitui quando a assinatura bate EXATAMENTE. Um
    // parâmetro a mais cria uma SOBRECARGA, as duas versões convivem, e o
    // chamador acerta a antiga — que é a errada. Quase aconteceu ao escrever a
    // 0019.
    const sql = sqlNaOrdem();
    const porNome = new Map();
    for (const m of sql.matchAll(/create or replace function public\.(\w+)\s*\(([^)]*)\)/g)) {
      const tipos = m[2].split(',').map((a) => a.trim().split(/\s+/).slice(1).join(' ').replace(/\s+default[\s\S]*/i, '').trim()).filter(Boolean);
      if (!porNome.has(m[1])) porNome.set(m[1], new Set());
      porNome.get(m[1]).add(tipos.join(','));
    }
    const divergentes = [...porNome.entries()]
      .filter(([, assinaturas]) => assinaturas.size > 1)
      .map(([nome, a]) => `${nome}: ${[...a].join(' | ')}`);
    // Assinatura nova é PERMITIDA, mas só se a migração derrubar a antiga.
    //
    // A primeira versão deste teste dispensava `append_check_event` porque o
    // parâmetro novo tem `default null` e "a chamada antiga continua
    // resolvendo". ERRADO, e caro: `create or replace` com assinatura
    // diferente cria uma SOBRECARGA, as duas convivem, e uma chamada com três
    // argumentos nomeados casa com as duas — `42725: function is not unique`.
    //
    // Aconteceu em produção em 2026-09-08 ao aplicar a 0018. A dispensa que eu
    // escrevi à mão foi exatamente o que o teste existia pra impedir.
    //
    // E o `drop` tem que ser o CERTO, na ORDEM certa. A primeira versão desta
    // guarda só procurava `drop function if exists public.<nome>(` em qualquer
    // lugar do SQL concatenado, com qualquer lista de argumentos — então ela
    // passava verde nos dois erros de digitação que reproduzem o incidente:
    // derrubar a assinatura NOVA (a sobrecarga fica, `42725` em produção), ou
    // pôr o `drop` DEPOIS do `create` (a migração derruba a função que acabou
    // de criar, e o RPC some). Achado pela revisão de segurança de 2026-09-08.
    const problemas = [];
    for (const d of divergentes) {
      const nome = d.split(':')[0];
      const assinaturas = [...porNome.get(nome)];
      const anteriores = assinaturas.slice(0, -1);   // a última é a que fica
      const drops = [...sql.matchAll(new RegExp(`drop function if exists public\\.${nome}\\(([^)]*)\\)`, 'g'))];
      if (drops.length === 0) { problemas.push(`${nome}: nenhum drop`); continue; }
      const criacaoNova = sql.lastIndexOf(`create or replace function public.${nome}`);
      const dropped = drops.map((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean).join(','));
      // Alguma das assinaturas ANTIGAS foi derrubada, e antes da criação nova.
      const bom = drops.some((m, i) => anteriores.includes(dropped[i]) && m.index < criacaoNova);
      if (!bom) {
        problemas.push(`${nome}: drop não casa a assinatura antiga (${anteriores.join(' | ')}) ou vem depois do create — derrubados: ${dropped.join(' | ')}`);
      }
    }
    expect(problemas).toEqual([]);
  });

  test('toda função nova nasce com o acesso REVOGADO de anon/authenticated', () => {
    // As RPCs rodam `security definer` com a service-role: uma função exposta
    // ao PostgREST anônimo é o banco inteiro pela porta da frente. A 0020
    // (`expire_payment_if_pending`) mexe em `payments`.
    const sql = sqlNaOrdem();
    const semRevoke = [];
    for (const m of sql.matchAll(/create or replace function public\.(\w+)([\s\S]{0,400}?)\slanguage /g)) {
      const [, nome, cabeca] = m;
      // Função de GATILHO não é chamável pelo PostgREST: ela roda por dentro
      // do banco, no INSERT/UPDATE da tabela. O que precisa de revoke é a RPC.
      if (/returns trigger/i.test(cabeca)) continue;
      if (!new RegExp(`revoke all on function public\\.${nome}\\(`).test(sql)) semRevoke.push(nome);
    }
    expect(semRevoke).toEqual([]);
  });
});

describe('redefinir uma função não pode APAGAR o que outra migração acrescentou', () => {
  /**
   * `create or replace function` substitui o corpo INTEIRO. Reescrever uma
   * função a partir de uma versão antiga apaga em silêncio tudo que migrações
   * do meio acrescentaram.
   *
   * Aconteceu em produção em 2026-09-08. Reescrevi `append_check_event` a
   * partir da versão da 0001 pra acrescentar idempotência, e apaguei o bloco
   * que a 0004 tinha posto:
   *
   *     if p_type = 'CLOSED' then
   *       update checks set status = 'fechada' ...
   *
   * Em trinta segundos a mesa da demonstração travou: o evento CLOSED entrou,
   * o cache ficou 'aberta', e a mesa passou a ser ao mesmo tempo impossível de
   * ler (404, estado derivado diz fechada) e impossível de reabrir (409, cache
   * diz aberta). E o índice único "no máximo uma conta não fechada por mesa"
   * depende desse cache, então TODA mesa que fechasse uma conta ficaria presa.
   *
   * Este teste é sobre INVARIANTES DE CORPO, não sobre assinatura: certas
   * responsabilidades, uma vez acrescentadas a uma função, não podem sumir da
   * última definição dela.
   */
  const INVARIANTES = [
    {
      funcao: 'append_check_event',
      precisa: [
        // da 0004: o cache de status que o índice único usa
        /if\s+p_type\s*=\s*'CLOSED'\s+then/i,
        /update\s+checks\s+set\s+status\s*=\s*'fechada'/i,
        // da 0001: o lock por conta que serializa o seq
        /pg_advisory_xact_lock/i,
      ],
    },
    {
      funcao: 'append_house_payment_guarded',
      precisa: [
        /pg_advisory_xact_lock/i,
        /PAYMENT_REFUND_REVERSED/,   // da 0019
        /excede o que falta pagar/,  // da 0006
      ],
    },
  ];

  test('a ÚLTIMA definição de cada função guarda tudo que ela já teve', () => {
    const sql = sqlNaOrdem();
    const faltando = [];
    for (const { funcao, precisa } of INVARIANTES) {
      const defs = [...sql.matchAll(
        new RegExp(`create or replace function public\\.${funcao}[\\s\\S]*?\\$\\$;`, 'g'),
      )];
      if (!defs.length) { faltando.push(`${funcao}: nenhuma definição`); continue; }
      const ultima = defs[defs.length - 1][0];
      for (const re of precisa) {
        if (!re.test(ultima)) faltando.push(`${funcao}: perdeu ${re}`);
      }
    }
    expect(faltando).toEqual([]);
  });
});

/**
 * O CENSO da leitura: todo campo que o reparo LÊ tem que estar no SELECT.
 *
 * `repairRowFromLedger` monta a guarda de versão da migração 0023 com campos
 * de `getPayment`. Dois deles não estavam no SELECT do Supabase, então
 * `linha.refundedAmountCents` era `undefined` e o `|| 0` mandava zero — a
 * guarda passava só na linha virgem e ficava INERTE em toda linha que já teve
 * estorno, que é a família que ela protege.
 *
 * O store de memória escondeu isso porque o duplo devolve a LINHA INTEIRA: ele
 * relata MAIS do que a produção, que é a armadilha do dublê ao contrário.
 * Achado pela revisão de segurança de 2026-09-08.
 */
describe('censo do SELECT: a leitura tem que trazer o que o código usa', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..');

  const camelParaSnake = (n) => n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  test('todo campo que a reparação lê de `getPayment` está no SELECT', () => {
    const handler = fs.readFileSync(path.join(raiz, '_lib', 'pay', 'webhook-handler.js'), 'utf8');
    const sup = fs.readFileSync(path.join(raiz, '_lib', 'store', 'supabase.js'), 'utf8');

    // O corpo do `repairRowFromLedger`, e os campos que ele tira de `linha`.
    const corpo = handler.match(/async function repairRowFromLedger[\s\S]*?\n\}/);
    expect(corpo).not.toBeNull();
    const lidos = new Set([...corpo[0].matchAll(/\blinha\.(\w+)/g)].map((m) => m[1]));
    expect(lidos.size).toBeGreaterThanOrEqual(3);

    // O SELECT do `getPayment`.
    const sel = sup.match(/async getPayment\(txid\)[\s\S]{0,1200}?\.select\('([^']+)'\)/);
    expect(sel).not.toBeNull();
    const colunas = new Set(sel[1].split(',').map((c) => c.trim()));

    const faltando = [...lidos].filter((n) => !colunas.has(camelParaSnake(n))).sort();
    expect(faltando).toEqual([]);
  });

  test('o mapeamento é conferido por VALOR — troca de coluna não passa', () => {
    /**
     * O censo de NOME não pega transposição: `refundedAmountCents:
     * data.refunded_tip_cents` satisfaz "a coluna está no select" e "o campo
     * está no objeto", e re-inertiza a guarda de versão da 0023 pra toda linha
     * com estorno — em silêncio, porque perder a corrida é registrado como
     * normal. Então: um cliente falso devolve uma linha com valores
     * distinguíveis, e o objeto mapeado tem que trazer cada um no seu lugar.
     * Achado pela revisão de segurança de 2026-09-08.
     */
    const { createSupabaseStore } = require('../_lib/store/supabase');
    const linha = {
      txid: 'ch_1', check_id: 'c1', amount_cents: 111, tip_cents: 222,
      payer_label: 'Ana', status: 'confirmado', method: 'pix',
      psp_payload_masked: { a: 1 }, confirmed_at: '2026-09-08T00:00:00Z',
      refunded_amount_cents: 333, refunded_tip_cents: 444,
    };
    // Cliente mínimo: só o encadeamento que o `getPayment` usa.
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linha, error: null }) }) }),
      }),
    };
    const store = createSupabaseStore({ client });
    return store.getPayment('ch_1').then((p) => {
      expect(p.amountCents).toBe(111);
      expect(p.tipCents).toBe(222);
      expect(p.refundedAmountCents).toBe(333);
      expect(p.refundedTipCents).toBe(444);
      expect(p.status).toBe('confirmado');
      expect(p.confirmedAt).toBe('2026-09-08T00:00:00Z');
    });
  });

  test('e o objeto devolvido MAPEIA essas colunas — a coluna sozinha não basta', () => {
    const sup = fs.readFileSync(path.join(raiz, '_lib', 'store', 'supabase.js'), 'utf8');
    const fn = sup.match(/async getPayment\(txid\)[\s\S]*?\n    \},/);
    expect(fn).not.toBeNull();
    for (const campo of ['refundedAmountCents', 'refundedTipCents', 'status', 'confirmedAt']) {
      expect(fn[0]).toContain(campo);
    }
  });
});

/**
 * O CENSO DA ORDEM: nada referencia o que ainda não existe.
 *
 * A 0021 inseria numa tabela criada pela 0022. Em produção passou porque foi
 * aplicada à mão, na ordem que eu escolhi. Aplicada na ordem NUMÉRICA — que é
 * a de um banco novo, do staging e de uma restauração de desastre — ela morria
 * com `42P01`. E o canário sintético do staging depende de conseguir construir
 * o esquema a partir destes arquivos.
 * Achado pela revisão de segurança de 2026-09-08.
 */
describe('censo da ordem das migrações', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'supabase', 'migrations');

  test('toda tabela referenciada já foi criada por uma migração anterior', () => {
    const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(arquivos.length).toBeGreaterThan(20);
    const criadas = new Set();
    const problemas = [];
    for (const f of arquivos) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      // O que este arquivo CRIA conta como disponível a partir dele mesmo.
      for (const m of sql.matchAll(/create table (?:if not exists )?public\.(\w+)/g)) {
        criadas.add(m[1]);
      }
      // E o que ele USA tem que já estar disponível.
      const usos = [
        ...sql.matchAll(/insert into public\.(\w+)/g),
        ...sql.matchAll(/references public\.(\w+)/g),
        ...sql.matchAll(/alter table public\.(\w+)/g),
      ];
      for (const m of usos) {
        // `checks`, `payments` e cia. vêm da 0001; o censo só precisa saber
        // que ALGUMA migração anterior (ou esta) as criou.
        if (!criadas.has(m[1])) problemas.push(`${f}: usa public.${m[1]} antes de existir`);
      }
    }
    expect(problemas).toEqual([]);
  });

  test('o censo não passa por regex quebrado — ele vê as tabelas de verdade', () => {
    const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
    const sql = arquivos.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const criadas = [...sql.matchAll(/create table (?:if not exists )?public\.(\w+)/g)].map((m) => m[1]);
    for (const t of ['checks', 'payments', 'check_events', 'payment_repair_log', 'orphan_money_events']) {
      expect(criadas).toContain(t);
    }
  });
});
