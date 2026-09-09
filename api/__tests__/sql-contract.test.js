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
    {
      /**
       * `repair_payment_row` estava FORA desta lista — e é justamente ela que
       * sofreu a regressão que esta lista existe pra impedir.
       *
       * A 0029, escrita pra FORTALECER o registro, reconstruiu o
       * `jsonb_build_object` com cinco campos em vez de seis e perdeu o
       * `confirmed_at` do `before_row`. Uma regressão em duas reescritas,
       * pega por gente, não pelo censo. A 0030 consertou a instância.
       *
       * E agora o log virou PROCEDIMENTO: o runbook
       * `linha-de-pagamento-atrasada.md` diz "existe linha no log se e somente
       * se a escrita foi commitada", e manda o operador resolver por ali um
       * `high` sobre a base da folha. Se um `create or replace` futuro derrubar
       * o `insert`, "sem linha" deixa de significar "não escreveu" e passa a
       * significar "não sei" — e o operador distribui pelo número antigo, que é
       * o maior. CLT art. 462 não deixa descontar isso depois. LGPD art. 37 e
       * CLT art. 11 (cinco anos) pro registro em si.
       *
       * Achado pela revisão de compliance de 2026-09-09 (HIGH-E).
       */
      funcao: 'repair_payment_row',
      precisa: [
        // UM regex só: separados, eles não provam que o `insert` está DENTRO
        // do condicional — e o "se e somente se" do runbook depende disso.
        /if v_id is not null then[\s\S]{0,200}insert into payment_repair_log/i,
        /'confirmed_at', confirmed_at/,      // before_row inteiro (a regressão da 0029)
        /when 'reconciler_sweep'/,           // a procedência da 0029
        // a lista branca: nunca a linha toda (LGPD art. 6º III)
        /'refunded_tip_cents', refunded_tip_cents/,
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

  test('todo campo que a VARREDURA lê de `listChecksForReconcile` está no SELECT', () => {
    /**
     * O SEGUNDO leitor, que não tinha censo.
     *
     * O de cima cobre `getPayment` ← `repairRowFromLedger`, escrito depois do
     * incidente em que o SELECT perdeu as colunas de estorno e a guarda de
     * versão da 0023 recebia zero pra toda linha — inerte, em silêncio.
     * `repararLinhasAtrasadas` lê de OUTRO caminho
     * (`listChecksForReconcile`) e ficou de fora.
     *
     * O que ele lê agora decide se ESCREVE: sem `confirmed_amount_cents` /
     * `confirmed_tip_cents` no SELECT, a comparação
     * `row.confirmedAmountCents !== pay.amountCents` compara `undefined` e a
     * guarda recusa TUDO — o reparo morre calado. Nas duas direções o defeito
     * é invisível, que é a assinatura desta classe.
     * Achado pela revisão de segurança de 2026-09-09 (MEDIUM-4).
     */
    const recon = fs.readFileSync(path.join(raiz, '_lib', 'checks', 'reconcile.js'), 'utf8');
    const sup = fs.readFileSync(path.join(raiz, '_lib', 'store', 'supabase.js'), 'utf8');

    const corpo = recon.match(/async function repararLinhasAtrasadas[\s\S]*?\n\}/);
    expect(corpo).not.toBeNull();
    const lidos = new Set([...corpo[0].matchAll(/\brow\.(\w+)/g)].map((m) => m[1]));
    expect(lidos.size).toBeGreaterThanOrEqual(4);

    // O SELECT das LINHAS de pagamento dentro do `listChecksForReconcile`.
    const bloco = sup.match(/async listChecksForReconcile\(venueId\)[\s\S]*?\n {4}\}/);
    expect(bloco).not.toBeNull();
    const selects = [...bloco[0].matchAll(/\.select\('([^']+)'\)/g)].map((m) => m[1]);
    const colunas = new Set(selects.join(',').split(',').map((c) => c.trim()));

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

/**
 * O CENSO DA VENUE: todo campo que a varredura LÊ chega dos dois stores.
 *
 * `reconcilePayablesLeg` lê `venue.pspRecipientId`, e nenhum dos dois stores
 * devolvia — a RPC `venue_activation_stats` nem tinha a coluna no `returns
 * table`. A perna de custódia rodava contra `undefined`: uma chamada de API por
 * cobrança, paga pra devolver `payables_no_recipient` ALTO, e o achado que
 * responde a pergunta do inegociável #4 inalcançável.
 *
 * Os dois censos que eu tinha escrito conferiam que a perna estava LIGADA —
 * nenhum viu que a entrada estava vazia. E os testes de integração montavam a
 * venue à mão com o campo, um dublê que relata MAIS que a produção.
 * Achado pelas duas revisões de 2026-09-08.
 */
describe('censo da venue: a varredura recebe o que lê', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..');
  const camelParaSnake = (n) => n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  /** Os campos que o job diário tira de uma `venue`. */
  function camposLidos() {
    const src = fs.readFileSync(path.join(raiz, '_lib', 'checks', 'reconcile-daily.js'), 'utf8');
    return new Set([...src.matchAll(/\bvenue\.(\w+)/g)].map((m) => m[1]));
  }

  test('a RPC devolve toda coluna que o mapeador do Supabase promete', () => {
    const mig = fs.readdirSync(path.join(raiz, '..', 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql')).sort()
      .map((f) => fs.readFileSync(path.join(raiz, '..', 'supabase', 'migrations', f), 'utf8'))
      .join('\n');
    // A ÚLTIMA definição da função é a que vale.
    const defs = [...mig.matchAll(/create or replace function public\.venue_activation_stats[\s\S]*?\$\$;/g)];
    expect(defs.length).toBeGreaterThanOrEqual(1);
    const ultima = defs[defs.length - 1][0];

    const sup = fs.readFileSync(path.join(raiz, '_lib', 'store', 'supabase.js'), 'utf8');
    const fn = sup.match(/async listVenueActivation\(\)[\s\S]*?\n    \},/);
    expect(fn).not.toBeNull();
    // Toda coluna que o mapeador lê de `r.` tem que estar no `returns table`.
    const lidas = [...fn[0].matchAll(/\br\.(\w+)/g)].map((m) => m[1]);
    expect(lidas.length).toBeGreaterThanOrEqual(8);
    const faltando = [...new Set(lidas)].filter((c) => !new RegExp(`\\b${c}\\b`).test(ultima)).sort();
    expect(faltando).toEqual([]);
  });

  test('o que a varredura lê da venue existe nos DOIS stores', () => {
    const lidos = camposLidos();
    expect(lidos.has('pspRecipientId')).toBe(true);   // o que faltava
    expect(lidos.has('id')).toBe(true);

    const sup = fs.readFileSync(path.join(raiz, '_lib', 'store', 'supabase.js'), 'utf8');
    const mem = fs.readFileSync(path.join(raiz, '_lib', 'store', 'memory.js'), 'utf8');
    const bloco = (src) => {
      const m = src.match(/async listVenueActivation\(\)[\s\S]*?\n    \},/);
      expect(m).not.toBeNull();
      return m[0];
    };
    for (const [nome, src] of [['supabase', bloco(sup)], ['memory', bloco(mem)]]) {
      for (const campo of lidos) {
        expect(src).toContain(`${campo}:`);
        if (nome === 'supabase') {
          // E do lado do Supabase, a coluna correspondente.
          expect(bloco(sup)).toMatch(new RegExp(`r\\.${camelParaSnake(campo)}\\b`));
        }
      }
    }
  });

  test('o store de MEMÓRIA devolve o campo de verdade, não só o texto', async () => {
    // O censo acima é textual; este roda. Um dublê que não devolve o campo é a
    // armadilha que deixou este defeito passar.
    const { createMemoryStore } = require('../_lib/store/memory');
    const store = createMemoryStore();
    await store.seedVenue({ name: 'Boteco', servicoBp: 1000, pspRecipientId: 're_abc' });
    const [v] = await store.listVenueActivation();
    expect(v.pspRecipientId).toBe('re_abc');
    expect(v.id).toBeTruthy();
  });
});

/**
 * O CLAIM CONDICIONAL COMPARA O QUE ESCREVE.
 *
 * `repair_payment_row` escreve CINCO colunas e o `where` cobre TRÊS
 * (`status`, `refunded_amount_cents`, `refunded_tip_cents`). As duas de
 * confirmação são escritas sem serem comparadas — hoje sem consequência, porque
 * o único chamador que as toca escreve de volta o que leu e nenhum outro
 * escritor mexe nelas isoladamente. Mas isso é INVARIANTE NÃO DITA: um sexto
 * escritor que mova `confirmed_*` deixando `status` e `refunded_*` parados seria
 * sobrescrito em silêncio, e o inegociável #7 é exatamente sobre claim cuja
 * condição não cobre o que ele faz.
 *
 * `confirmed_at` é a exceção deliberada: ele entra por `coalesce(confirmed_at,
 * p_confirmed_at)`, que só preenche o nulo e nunca sobrescreve — então não há o
 * que comparar. A exceção fica escrita aqui pra que seja uma decisão, e não um
 * esquecimento que alguém repete.
 *
 * Achado pela revisão de segurança de 2026-09-09 (LOW-1).
 */
test('toda coluna que a RPC de reparo ESCREVE também é COMPARADA', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'supabase', 'migrations');
  // A versão VIGENTE é a do arquivo de maior número que redefine a função.
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const vigente = arquivos.filter((f) => fs.readFileSync(path.join(dir, f), 'utf8')
    .includes('function public.repair_payment_row(')).pop();
  expect(vigente).toBeTruthy();
  const sql = fs.readFileSync(path.join(dir, vigente), 'utf8');

  const corpo = sql.slice(sql.indexOf('update payments'), sql.indexOf('returning txid'));
  const setBloco = corpo.slice(0, corpo.indexOf('where'));
  const whereBloco = corpo.slice(corpo.indexOf('where'));

  const escritas = [...setBloco.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1])
    .filter((c) => c !== 'set');
  // A coluna comparada pode estar dentro de um `coalesce(col, 0) = ...`, então
  // o que vale é APARECER no `where` — não estar colada num `=`.
  const comparadas = new Set([...whereBloco.matchAll(/\b(\w+)\b/g)].map((m) => m[1]));

  // `confirmed_at` é a exceção documentada acima: `coalesce` só preenche nulo.
  const EXCECOES = new Set(['confirmed_at']);
  const semComparacao = escritas.filter((c) => !EXCECOES.has(c) && !comparadas.has(c));
  expect(semComparacao).toEqual(['confirmed_amount_cents', 'confirmed_tip_cents']);
  // Fixado como DÍVIDA CONHECIDA, não como aprovação: mudar esta lista exige
  // mexer aqui e dizer por quê. A saída definitiva é uma RPC irmã que escreva
  // só as duas colunas de estorno, e aí esta lista fica vazia.
});

/**
 * O RAZÃO É ESCRITO ANTES DA LINHA — a defesa estrutural, não a guarda.
 *
 * Os outros dois chamadores de `repairPaymentRow` (a reentrega do webhook e a
 * devolução fora do trilho) escrevem `confirmed_*`/`refunded_*` a partir do
 * razão sem conferência de direção. Isso é SEGURO por um motivo que não estava
 * em teste nenhum: os dois APENDAM no razão primeiro e projetam depois, então o
 * razão sempre lidera a linha e "linha à frente" exigiria que uma tabela
 * append-only perdesse um evento já commitado.
 *
 * A ordenação é a defesa; uma guarda de direção seria a mais fraca das duas. O
 * que faltava era travar a ordenação. Achado pela revisão de segurança de
 * 2026-09-09 (M-3, rebaixado pelo próprio revisor a esta forma).
 */
test('nos dois chamadores, o append no razão vem ANTES da projeção', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..');

  /**
   * SEM COMENTÁRIO, e no BLOCO certo — a versão anterior era vazia.
   *
   * Ela procurava o append em QUALQUER lugar do arquivo antes da projeção. No
   * `webhook-handler.js` isso casava com uma linha de JSDoc do topo (`The store
   * is injected ({ loadEvents, appendEvent, recordPayment })`), então a
   * afirmação passava mesmo apagando TODO append do arquivo. No `router.js`
   * casava com um `appendValidated` de outra rota, milhares de linhas antes.
   *
   * E a regra não é a mesma nos dois. No `router.js` a rota apenda e projeta no
   * mesmo trecho. No `webhook-handler.js` quem projeta é `repairRowFromLedger`,
   * que NÃO apenda — ela deriva do razão (`loadEvents`) e escreve só a linha. A
   * ordenação ali é da CADEIA: cada chamador apenda e só depois chama. Então
   * são duas afirmações diferentes, e a antiga não fazia nenhuma das duas.
   * (LOW-2 da revisão de segurança de 2026-09-09.)
   */
  const semComentario = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // --- a ROTA: apenda e projeta no mesmo trecho ---------------------------
  {
    const fonte = semComentario(fs.readFileSync(path.join(raiz, '_app', 'router.js'), 'utf8'));
    const iProj = fonte.indexOf('repairPaymentRow({');
    expect(iProj).toBeGreaterThan(0);
    const antes = fonte.slice(0, iProj);
    let inicio = 0;
    for (const m of antes.matchAll(/url\.pathname ===/g)) inicio = m.index;
    expect(inicio).toBeGreaterThan(0);
    expect(/appendValidated/.test(antes.slice(inicio))).toBe(true);
  }

  // --- o WEBHOOK: a projeção não apenda, e todo chamador apenda antes ------
  {
    const fonte = semComentario(fs.readFileSync(path.join(raiz, '_lib', 'pay', 'webhook-handler.js'), 'utf8'));

    // 1. `repairRowFromLedger` é PROJEÇÃO: lê o razão e não escreve nele.
    const corpo = fonte.match(/async function repairRowFromLedger[\s\S]*?\n\}/);
    expect(corpo).not.toBeNull();
    expect(/loadEvents\(/.test(corpo[0])).toBe(true);
    expect(/appendEvent\(|appendValidated\(/.test(corpo[0])).toBe(false);

    /**
     * 2. Ela só é chamada em caminho de REENTREGA — CHEIRO, não prova.
     *
     * Dito na cara: esta segunda metade procura o NOME do teste de reentrega
     * perto da chamada, não o fluxo de controle. Medido: trocando
     * `if (jaEncerrada)` por `if (true)`, ela continua verde, porque a palavra
     * segue no texto acima. Provar de verdade pediria analisar controle de
     * fluxo, e um teste que promete mais do que entrega é o pino com cabeçalho
     * de censo outra vez — então fica dito o que ele é.
     *
     * A afirmação FORTE é a (1): `repairRowFromLedger` nunca apenda. Essa é
     * mutation-provada (pôr um `appendEvent` no corpo derruba o teste), e é ela
     * que sustenta "a linha nunca lidera o razão".
     *
     * A revisão sugeriu afirmar "o append precede a chamada na mesma função".
     * Medindo, não é assim que o handler funciona: as oito chamadas estão todas
     * em caminho de DUPLICATA — `seenPspEvent`, `seq < 0` (seq negativo é
     * duplicata), `delta <= 0`, `existing.*Cents === parsed.*Cents`. O append
     * aconteceu numa entrega ANTERIOR, que é a premissa inteira de
     * `repairRowFromLedger`: o razão já tem o evento e só a linha ficou atrás.
     *
     * Então a ordenação não é intra-função, é entre entregas — e o que a
     * sustenta é (1) acima mais o fato de que todo chamador está atrás de um
     * teste de duplicata. É isso que dá pra afirmar, e é isso que se afirma.
     */
    // `check.id` e não `checkId`: exclui a própria DEFINIÇÃO da função.
    const chamadas = [...fonte.matchAll(/repairRowFromLedger\(check\.id/g)].map((m) => m.index);
    // `toBe`, não `>=`: um censo com folga na direção da DELEÇÃO não é censo.
    expect(chamadas.length).toBe(7);
    /**
     * Os testes de reentrega que guardam cada chamada. `jaEncerrada` é uma
     * disputa já fechada — reentrega também, só que dita por outro nome.
     */
    const DUPLICATA = /seenPspEvent|seq < 0|delta <= 0|=== parsed\.|refundDeltaCents === 0|jaEncerrada/;
    const semGuarda = [];
    for (const idx of chamadas) {
      // O trecho antes da chamada, até o `if` que a guarda.
      const contexto = fonte.slice(Math.max(0, idx - 800), idx);
      if (!DUPLICATA.test(contexto)) semGuarda.push(fonte.slice(idx - 60, idx + 40).replace(/\s+/g, ' '));
    }
    expect(semGuarda).toEqual([]);
  }
});


/**
 * A IMAGEM ANTERIOR não pode encolher em silêncio.
 *
 * A 0026 gravava seis campos. A 0029 — a migração de PROCEDÊNCIA, escrita pra
 * FORTALECER esse registro — reconstruiu o `jsonb_build_object` com cinco e
 * perdeu `confirmed_at`, no mesmo arquivo, sem uma linha dizendo por quê.
 * Conserto pela metade: melhorou o "quem pediu" e piorou o "o que era antes".
 *
 * A imagem anterior é o único registro durável do estado pré-reparo — LGPD art.
 * 37, e CLT art. 11 (cinco anos) numa discussão sobre a gorjeta de um período.
 * Ela pode ganhar campos; encolher exige mexer aqui.
 *
 * Achado pela revisão de segurança de 2026-09-09 (LOW-4).
 */
test('a imagem ANTERIOR do reparo nunca perde um campo', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'supabase', 'migrations');
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  // Todo arquivo que redefine a função, na ordem: o conjunto de campos da
  // imagem anterior só pode crescer.
  const versoes = [];
  for (const f of arquivos) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!sql.includes('function public.repair_payment_row(')) continue;
    const antes = sql.match(/into\s+v_antes/);
    if (!antes) continue;
    // O `jsonb_build_object` que alimenta `v_antes`.
    const bloco = sql.slice(0, antes.index);
    const ultimo = bloco.lastIndexOf('jsonb_build_object');
    const campos = [...bloco.slice(ultimo).matchAll(/'(\w+)',/g)].map((m) => m[1]);
    versoes.push({ arquivo: f, campos: new Set(campos) });
  }
  expect(versoes.length).toBeGreaterThanOrEqual(2);

  /**
   * A regra é sobre o ESTADO ATUAL, não sobre a história.
   *
   * Migração é append-only: a 0029 de fato encolheu, e a 0030 devolveu. Fixar
   * "nenhuma versão jamais encolheu" faria este teste falhar pra sempre por um
   * fato já corrigido — e um teste que não dá pra deixar verde é um teste que
   * alguém apaga. A invariante que importa é que nada que já foi registrado
   * esteja PERMANENTEMENTE fora: a união de tudo que qualquer versão gravou tem
   * que caber na versão vigente.
   */
  const jaGravados = new Set(versoes.flatMap((v) => [...v.campos]));
  const atual = versoes[versoes.length - 1].campos;
  const perdidosDeVez = [...jaGravados].filter((c) => !atual.has(c)).sort();
  expect(perdidosDeVez).toEqual([]);

  // E a versão vigente guarda as colunas de dinheiro MAIS a data.
  const vigente = versoes[versoes.length - 1].campos;
  for (const c of ['status', 'confirmed_amount_cents', 'confirmed_tip_cents',
    'refunded_amount_cents', 'refunded_tip_cents', 'confirmed_at']) {
    expect([...vigente]).toContain(c);
  }
  // E NUNCA o que o cliente digitou: a tabela é permanente (LGPD art. 6º III).
  expect([...vigente]).not.toContain('payer_label');
  expect([...vigente]).not.toContain('payer_document');
});

/**
 * QUEM PODE LER `pgCode` — um só, e dentro do `recusaProvada`.
 *
 * O `throwOn` agora anexa `pgCode` nos 26 call sites do store, e o nome LÊ como
 * "o código de erro do Postgres" — mas ele pode ser `PGRST116`, que não é
 * SQLSTATE e viaja numa resposta 2xx, depois de um commit bem sucedido. Um
 * `if (err.pgCode) return 'o banco recusou'` em qualquer lugar novo estaria
 * errado, e errado na direção que custa dinheiro que não volta.
 *
 * Então o campo tem UM leitor, e ele é a função cujo trabalho é decidir o que o
 * código prova. Achado pela revisão de segurança de 2026-09-09 (LOW-4).
 */
test('`pgCode` tem exatamente um leitor, e ele é o classificador', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..');

  const arquivos = [];
  (function varrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith('.js')) arquivos.push(p);
    }
  })(raiz);

  /**
   * A regra é sobre DECISÃO, não sobre menção.
   *
   * Ler o código pra escrever no stderr é diagnóstico e é bom — quem for
   * investigar quer o código na linha. O que não pode é DECIDIR a partir dele
   * fora do classificador: é aí que `PGRST116` (que viaja num 2xx, depois de um
   * commit) viraria "o banco recusou".
   */
  const decisoes = [];
  for (const p of arquivos) {
    const fonte = fs.readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of fonte.matchAll(/\.pgCode\b/g)) {
      const antes = fonte.slice(Math.max(0, m.index - 60), m.index);
      const linha = fonte.slice(Math.max(0, m.index - 120), m.index + 60).replace(/\s+/g, ' ').trim();
      if (/\.pgCode\s*=[^=]/.test(fonte.slice(m.index, m.index + 12))) continue;  // escrita
      // Dentro de uma interpolação (`${e.pgCode}`) é texto, não decisão.
      if (/\$\{[^}]*$/.test(antes)) continue;
      decisoes.push({ arquivo: path.relative(raiz, p), linha });
    }
  }

  // Toda DECISÃO passa pelo classificador, e só há uma.
  expect(decisoes.length).toBe(1);
  expect(decisoes[0].arquivo).toBe('_lib/checks/reconcile.js');
  expect(decisoes[0].linha).toMatch(/recusaProvada\(/);
});
