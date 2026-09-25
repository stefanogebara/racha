'use strict';

const { nomeDaRestricao } = require('./pg-erro');

const { DEFAULT_MARKET, isMarket, publicMarketView, market, showsVenueTaxId } = require('../markets');
const { documentoPublicavelDaCasa } = require('../br/documento.js');
const { confirmedMoney } = require('./confirmed-money');
/**
 * Erro 400 local — os dois stores precisam do mesmo, e o `http-error.js` só
 * exporta o mapa de status. Mesma forma do `create-charge.js:25`.
 */
function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

const { disputeCounts } = require('../checks/disputes');
const { PAPEL_DE_DONO } = require('./papeis');
const { rotuloDoPagador } = require('../texto-da-casa');

/**
 * Supabase store — the production implementation of the store contract
 * defined by store/memory.js (same method surface, same shapes; the contract
 * suite in __tests__/store-contract.test.js runs against BOTH).
 *
 * Rules carried from hard lessons:
 * - Event appends go through the append_check_event RPC (advisory-locked,
 *   serialized per check). NEVER PostgREST update+or filters (2026-07-14:
 *   this PostgREST construct 42703s deterministically).
 * - EVERY PostgREST error is checked and thrown — no silent {data:null}
 *   swallows. Money paths fail loud.
 * - State is derived by reduce(events) on read. The checks-table cache
 *   columns are NOT maintained in v0 (a half-maintained cache caused a
 *   review finding; we derive until a transactional cache lands).
 * - psp_payload_masked receives ONLY the masked subset built upstream.
 */

const { criarClienteSupabase } = require('./cliente-supabase');
const { reduce, paidAfterClose, itensDoRazao } = require('../checks/check-state');
const { recusaDaCarteira, unicidadeViolada } = require('../checks/reconcile');
const { idadeSemOpened, linhaDeAlarme } = require('../checks/conta-sem-opened');
const { linhasDeSobra, acumularSobra } = require('../checks/sobra-do-painel');
const { buildAtivacao, spDay } = require('../checks/ativacao');
const { RECIPIENT_TERMINAL } = require('../recipient-status');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`supabase store: missing env ${name}`);
  return v;
}

/**
 * O CÓDIGO DO POSTGRES SOBREVIVE AO `throw`.
 *
 * O erro do postgrest-js carrega um discriminador que estava sendo jogado fora:
 * uma falha de TRANSPORTE vira `{ code: '' | 'UND_ERR_*' }`, enquanto um erro
 * do SERVIDOR carrega um SQLSTATE. E SQLSTATE quer dizer que o servidor
 * produziu uma resposta completa — ou seja, a transação deu ROLLBACK e nada foi
 * escrito. Provável de esperar: `42883` (assinatura mudou — a 0030 acabou de
 * fazer um `create or replace`), `42703` (o código do incidente do Seatable),
 * `42501` (grant revogado), `23514`.
 *
 * Sem isso, o reparo tratava todo lance como "pode ter escrito" e reportava um
 * movimento na base da folha que provadamente não aconteceu — com valor em
 * centavos e mês, até 200 linhas por casa por noite, sob uma causa sistemática.
 * Achado pela revisão de segurança de 2026-09-09 (MEDIUM-1).
 */
/** SQLSTATE tem exatamente cinco caracteres; o PostgREST usa `PGRSTnnn`. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const PGRST_RE = /^PGRST\d+$/;

/**
 * A RECUSA DA CARTEIRA com status e CÓDIGO (0040): o banco diz o quê pelo
 * SQLSTATE, o classificador (`recusaDaCarteira`) decide, e a mensagem é o
 * código — a tela traduz; o servidor não manda frase. Recusa desconhecida segue
 * o `throwOn` de sempre.
 */
function throwDaCarteira(error, op) {
  if (!error) return;
  try { throwOn(error, op); } catch (e) {
    const r = recusaDaCarteira(e);
    if (!r) throw e;
    const err = new Error(r.code);
    err.statusCode = r.statusCode; err.code = r.code;
    throw err;
  }
}

function throwOn(error, op) {
  if (!error) return;
  const e = new Error(`supabase store ${op}: ${error.message}`);
  /**
   * SÓ FORMA DE CÓDIGO — quem decide o que ele PROVA é quem lê.
   *
   * Medido no `@supabase/postgrest-js` 2.110.7 (o que está no lock): na rejeição
   * de fetch o `code` nasce `''` e nunca é atribuído — os ramos de `AbortError`
   * e `UND_ERR_HEADERS_OVERFLOW` até o reatribuem pra `''` de propósito. Então
   * o teste `/^UND_ERR/` que eu tinha escrito era CÓDIGO MORTO, e pior: a
   * condição real era "qualquer `code` verdadeiro", o que deixava passar um
   * corpo JSON de gateway com `code: 504` — número, que vira `'504'` na
   * coerção do regex e escapa. Um 504 de gateway é justamente o caso em que a
   * escrita PODE ter acontecido.
   *
   * Aqui só se afirma a FORMA. Quem decide se aquilo prova rollback é
   * `reconcile.js`, com lista de permissão — porque a resposta depende da
   * CLASSE do SQLSTATE, e classe é assunto de quem está julgando dinheiro.
   */
  if (typeof error.code === 'string' && (SQLSTATE_RE.test(error.code) || PGRST_RE.test(error.code))) {
    e.pgCode = error.code;
  }
  // O NOME da restrição violada, quando o Postgres o diz. Só forma, como o
  // código: quem decide o que ele prova é o classificador. Sem isto, QUALQUER
  // unicidade virava "já registrado" — inclusive a `(check_id, seq)` do razão,
  // que significaria o oposto (compliance LOW-1 de d7f2683).
  const nome = nomeDaRestricao(`${error.message || ''} ${error.details || ''}`);
  if (nome) e.pgConstraint = nome;
  throw e;
}

// Postgres errors on a non-uuid string in a uuid column; a malformed id from
// the app just means "not found", not a 500. Guard the id-taking reads.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// One venue shape everywhere (house-account config rides along).
const VENUE_COLS = 'id, name, city, cnpj, servico_basis_points, psp_recipient_id, pos_provider, active, '
  + 'psp_recipient_status, notify_email, notify_whatsapp, stripe_account_id, '
  + 'house_enabled, house_bonus_bp, house_validity_days, house_min_load_cents, house_max_load_cents, is_test, '
  + 'market';
function mapVenue(v) {
  if (!v) return null;
  return {
    id: v.id, name: v.name, city: v.city, cnpj: v.cnpj,
    servicoBp: v.servico_basis_points, pspRecipientId: v.psp_recipient_id,
    market: v.market ?? DEFAULT_MARKET,
    pspRecipientStatus: v.psp_recipient_status ?? null,
    stripeAccountId: v.stripe_account_id ?? null,
    notifyEmail: v.notify_email ?? null, notifyWhatsapp: v.notify_whatsapp ?? null,
    posProvider: v.pos_provider, active: v.active,
    houseEnabled: v.house_enabled, houseBonusBp: v.house_bonus_bp,
    houseValidityDays: v.house_validity_days,
    houseMinLoadCents: v.house_min_load_cents == null ? undefined : Number(v.house_min_load_cents),
    houseMaxLoadCents: v.house_max_load_cents == null ? undefined : Number(v.house_max_load_cents),
    // Marcador durável de venue de teste/demo: o `demo.js` exige isto antes de
    // fechar ou abrir qualquer conta, e o varredor de conciliação a exclui.
    isTest: v.is_test === true,
  };
}
function mapHouseAccount(a) {
  if (!a) return null;
  return {
    id: a.id, venueId: a.venue_id, phone: a.phone, name: a.name,
    accountToken: a.account_token, active: a.active !== false, createdAt: a.created_at,
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.client] cliente pronto — a costura pra teste de
 *   CONTRATO. Sem ela, o mapeamento coluna→campo não era verificável de fato:
 *   dava pra conferir que o nome aparece no `select` e que o campo aparece no
 *   objeto, e uma TROCA entre duas colunas satisfazia as duas conferências.
 *   Foi assim que a guarda de versão do reparo (0023) ficou inerte sem ninguém
 *   ver. Achado pela revisão de segurança de 2026-09-08.
 */
function createSupabaseStore({ url, serviceRoleKey, client: injected } = {}) {
  const client = injected || criarClienteSupabase(
    url || required('SUPABASE_URL'),
    serviceRoleKey || required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );

  /**
   * As contas FECHADAS entre estas, em leituras por lote de 200 — o evento
   * CLOSED é o que faz o redutor dizer `fechada` (é o único caminho até ela).
   *
   * A versão anterior repassava o razão INTEIRO de cada conta que a casa já
   * teve, uma leitura por conta, em série: a cada carga do /admin, do /qrs e
   * depois de cada ação numa mesa. Mil contas a ~120 ms por ida são os 120 s do
   * `maxDuration`, e o admin parava de carregar semanas depois de a casa
   * começar (auditoria de onboarding C2, auditoria de backend H3).
   */
  async function idsDeContasFechadas(ids) {
    const fechadas = new Set();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await client
        .from('check_events').select('check_id')
        .eq('type', 'CLOSED').in('check_id', ids.slice(i, i + 200));
      throwOn(error, 'idsDeContasFechadas');
      for (const r of data || []) fechadas.add(r.check_id);
    }
    return fechadas;
  }

  /**
   * O RAZÃO DE MUITAS CONTAS, EM LEITURAS POR LOTE.
   *
   * `idsDeContasFechadas` já tinha tirado UM laço de leitura-por-conta, e
   * sobraram quatro — `getPanelView`, `getCheckByQrToken`,
   * `listChecksForReconcile` e `listHouseAccountsForReconcile`. É o mesmo
   * conserto pontual que esta casa já viu três vezes pegar um sítio de dois:
   * a régua certa escrita uma vez não chega sozinha aos outros chamadores.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * POR QUE ISTO PAGINA, E O LOTE DE `idsDeContasFechadas` NÃO PRECISAVA
   *
   * O PostgREST corta a resposta num número máximo de linhas (`db-max-rows`;
   * 1000 no padrão do Supabase) e NÃO avisa — devolve menos linhas com um 200.
   * `idsDeContasFechadas` seleciona só o evento CLOSED, que é no máximo um por
   * conta, então um lote de 200 ids traz no máximo 200 linhas e nunca encosta
   * no corte. Um razão INTEIRO não: 200 contas com 20 eventos cada são 4000
   * linhas, e o corte devolveria as primeiras 1000 com cara de razão completo.
   *
   * Um razão truncado não é um erro de leitura, é um erro de DINHEIRO: o
   * redutor veria uma conta sem o pagamento que ela recebeu. Então aqui se
   * pagina por `range` até vir uma página curta, com ordem TOTAL
   * (`check_id, seq`) — sem ordem total, duas páginas podem repetir e omitir a
   * mesma linha.
   * ──────────────────────────────────────────────────────────────────────────
   *
   * @param {string[]} ids
   * @returns {Promise<Map<string, object[]>>} id → eventos em ordem de `seq`.
   *   Toda conta pedida sai no mapa, mesmo sem eventos — quem chama faz
   *   `reduce(mapa.get(id))` e um `undefined` viraria um erro em vez de uma
   *   conta vazia.
   */
  const IDS_POR_LOTE = 200;
  /**
   * A PÁGINA É MENOR QUE O CORTE DO SERVIDOR, DE PROPÓSITO.
   *
   * O laço pára quando uma página vem CURTA. Se a página pedida for do mesmo
   * tamanho do `db-max-rows` do projeto, "curta" e "cortada" viram a mesma
   * coisa: baixar o "Max rows" do painel do Supabase pra 500 faria toda página
   * voltar com 500, o laço leria isso como "acabou", e a conciliação diária
   * passaria a comparar um razão truncado contra os pagamentos inteiros — e a
   * dizer que bate. Uma configuração de painel não pode ter esse poder sobre o
   * inegociável #8.
   *
   * Com 500 contra um corte de 1000, uma página cheia (500) prova que há mais,
   * e uma curta prova que acabou. Se alguém baixar o corte pra menos de 500, o
   * teto volta a ser ambíguo — por isso o número está aqui, nomeado, e não
   * embutido no `range`. Achado pela revisão de compliance de 2026-09-16
   * (MEDIUM-3).
   */
  const LINHAS_POR_PAGINA = 500;

  /**
   * UMA LEITURA PAGINADA. É o único lugar que fala `range` neste arquivo.
   *
   * @param {object} p
   * @param {(de: number, ate: number) => any} p.consulta  monta a query da página.
   * @param {string} p.op  nome pro erro.
   * @returns {Promise<object[]>} todas as linhas, em ordem.
   */
  /**
   * O TETO DE PÁGINAS existe porque o laço depende de um CABEÇALHO chegar.
   *
   * `range` viaja como `Range: 0-499` + `Range-Unit: items`, e um proxy que
   * descarte uma unidade de Range que não seja `bytes` faz toda página voltar
   * inteira: o laço nunca vê uma página curta e gira pra sempre. Medido — tirar
   * o `.range()` como controle positivo não deixou o teste vermelho, PENDUROU o
   * runner, sem nem o timeout do jest conseguir matá-lo (o laço mata o event
   * loop). Em produção a forma é "função morta no `maxDuration`, sem resposta e
   * sem o `catch`", que é exatamente a falha que o prazo do banco foi escrito
   * pra apagar. Um laço de rede sem teto é a mesma classe de defeito que uma
   * chamada sem prazo. Achado pela revisão de segurança de 2026-09-16 (LOW-3).
   *
   * 2000 páginas × 500 linhas é um milhão de linhas numa leitura só: muito
   * acima de qualquer caso real, e finito.
   */
  const TETO_DE_PAGINAS = 2000;
  async function lerPaginado({ consulta, op }) {
    const tudo = [];
    for (let pagina = 0; ; pagina += 1) {
      if (pagina >= TETO_DE_PAGINAS) {
        throw new Error(`supabase store ${op}: teto de ${TETO_DE_PAGINAS} páginas atingido `
          + '— o servidor não está honrando o Range, ou a leitura não tem filtro');
      }
      const { data, error } = await consulta(pagina * LINHAS_POR_PAGINA, (pagina + 1) * LINHAS_POR_PAGINA - 1);
      throwOn(error, op);
      const linhas = data || [];
      tudo.push(...linhas);
      if (linhas.length < LINHAS_POR_PAGINA) return tudo;
    }
  }

  /**
   * A leitura por lote, UMA vez. Todo `.in()` que pode trazer muitas linhas por
   * id passa por aqui — se cada chamador escrevesse a sua, a paginação seria
   * lembrada em uns e esquecida em outros, que é exatamente como esta casa
   * ganhou três cópias divergentes do predicado de estorno.
   *
   * @param {object} p
   * @param {string} p.tabela
   * @param {string} p.colunas  `select` — PRECISA conter `p.coluna`.
   * @param {string} p.coluna   a coluna do `in` e a chave do mapa.
   * @param {string[]} p.ids
   * @param {string[]} p.ordem  ordem TOTAL (a primeira é sempre `p.coluna`).
   * @param {string} p.op       nome pro erro.
   */
  async function lerPorLote({ tabela, colunas, coluna, ids, ordem, op }) {
    // O CONTRATO VIRA ASSERÇÃO. Era uma frase de JSDoc ("PRECISA conter
    // `p.coluna`"), e o custo de quebrá-la era mudo: sem a coluna-chave no
    // `select`, TODA linha cai em `mapa.get(undefined)`, o `if (balde)` abaixo
    // descarta cada uma, e a função devolve um mapa de listas vazias — sem erro.
    // Medido: tirar `check_id` do select do razão deixava a suíte INTEIRA verde
    // (2268 passando), porque todo dublê devolve o objeto completo
    // independentemente do `select` — só o PostgREST de verdade projeta.
    // Achado pela revisão de segurança de 2026-09-16 (LOW-2).
    if (!colunas.split(',').map((c) => c.trim()).includes(coluna)) {
      throw new Error(`lerPorLote(${tabela}): o select precisa trazer '${coluna}' — é a chave do mapa`);
    }
    /**
     * MINÚSCULA — mas SÓ pra uuid.
     *
     * O `isUuid` aceita hexadecimal maiúsculo (a regex tem `i`) e o Postgres
     * devolve `uuid` sempre em minúscula: um id maiúsculo na entrada indexaria o
     * mapa por uma chave que nenhuma linha casaria, e o `throw` do balde ausente
     * derrubaria uma leitura legítima.
     *
     * Dobrar a caixa INCONDICIONALMENTE, porém, quebra o caso oposto e pior: o
     * ajudante é genérico, e numa coluna de texto sensível à caixa — `txid`, que
     * na Stripe é `pi_3Ab…` — o `.in()` não casaria NADA, todo balde ficaria
     * vazio, e o `throw` do balde ausente nunca dispararia porque linha nenhuma
     * volta. Sairia um mapa de listas vazias sem erro: exatamente o sumiço
     * silencioso que aquele `throw` existe pra impedir, contornado por fora.
     * Apontado pelas segunda e terceira revisões de segurança de 2026-09-16.
     */
    const todosUuid = ids.every(isUuid);
    const chave = (v) => (todosUuid ? String(v).toLowerCase() : v);
    const emMinuscula = ids.map(chave);
    const mapa = new Map();
    for (const id of emMinuscula) mapa.set(id, []);
    for (let i = 0; i < emMinuscula.length; i += IDS_POR_LOTE) {
      const lote = emMinuscula.slice(i, i + IDS_POR_LOTE);
      const linhas = await lerPaginado({
        op,
        consulta: (de, ate) => {
          let q = client.from(tabela).select(colunas).in(coluna, lote);
          for (const col of ordem) q = q.order(col, { ascending: true });
          return q.range(de, ate);
        },
      });
      for (const r of linhas) {
        const balde = mapa.get(chave(r[coluna]));
        // GRITA em vez de descartar. O filtro é do banco, então uma linha de um
        // id que ninguém pediu não deveria existir — e se existir, ela é o
        // sintoma de alguma coisa errada na leitura, não ruído pra varrer. Um
        // descarte silencioso numa leitura de DINHEIRO é como a função devolvia
        // um mapa vazio sem avisar.
        if (!balde) {
          throw new Error(`lerPorLote(${tabela}): linha com ${coluna}=${JSON.stringify(r[coluna])} `
            + 'que não estava no lote — leitura inconsistente');
        }
        balde.push(r);
      }
    }
    return mapa;
  }

  function loadEventsPorLote(ids) {
    return lerPorLote({
      tabela: 'check_events',
      colunas: 'check_id, seq, type, payload, created_at',
      coluna: 'check_id',
      ids: [...new Set((ids || []).filter(isUuid))],
      ordem: ['check_id', 'seq'],
      op: 'loadEventsPorLote',
    });
  }

  async function loadEvents(checkId) {
    if (!isUuid(checkId)) return []; // malformed id → empty log → "not found"
    // PAGINA. Um razão cortado não é erro de leitura, é estado derivado ERRADO:
    // some o `CLOSED` e a conta volta a parecer aberta, some o
    // `PAYMENT_CONFIRMED` e ela parece não paga. E esta é a leitura dos
    // caminhos de ESCRITA (ajustar, fechar, devolver), não só de tela.
    const data = await lerPaginado({
      op: 'loadEvents',
      consulta: (de, ate) => client
      .from('check_events')
      // `created_at`: a DATA do evento, que é o que decide se o trilho de
      // devolução daquele pagamento ainda está aberto. Sem ela, a única fonte da
      // data era a linha de `payments` — a projeção que a rota da devolução
      // trata como melhor-esforço —, e um `railImpossible: 'pix_90d'` gravado no
      // razão não podia ser re-derivado dele por uma auditoria (compliance
      // MEDIUM-4 de d7f2683).
      .select('seq, type, payload, created_at')
      .eq('check_id', checkId)
      .order('seq', { ascending: true })
      .range(de, ate),
    });
    return data;
  }

  return {
    client, // exposed for tests/cleanup only

    // --- seeding / onboarding ---------------------------------------------
    // cnpj default NULL de propósito: a migração 0002 tornou a coluna nulável
    // justamente porque CNPJ falso em recibo real é inaceitável — e o default
    // antigo ('00000000000191') é o CNPJ REAL do Banco do Brasil, que ia parar
    // no `tax_id` da conta conectada do Stripe (achado da revisão de compliance).
    async createVenue({ name, cnpj = null, city = null, servicoBp = 1000, pspRecipientId = null, isTest = false, market = DEFAULT_MARKET }) {
      if (!name || !String(name).trim()) throw new Error('venue name required');
      if (!Number.isInteger(servicoBp) || servicoBp < 0 || servicoBp > 3000) {
        throw new Error('servicoBp out of range [0,3000]');
      }
      // Escrita recusa mercado desconhecido (o CHECK do banco também recusaria,
      // mas com uma mensagem de Postgres em vez de uma nossa).
      if (!isMarket(market)) throw new Error(`unknown market: ${market}`);
      const { data, error } = await client
        .from('venues')
        .insert({
          name: String(name).trim(), cnpj, city,
          servico_basis_points: servicoBp,
          psp_recipient_id: pspRecipientId ?? null,
          is_test: isTest === true,
          market,
        })
        .select('id, name, city, servico_basis_points, psp_recipient_id, market')
        .single();
      throwOn(error, 'createVenue');
      return {
        id: data.id, name: data.name, city: data.city,
        servicoBp: data.servico_basis_points,
        pspRecipientId: data.psp_recipient_id,
        market: data.market ?? DEFAULT_MARKET,
      };
    },
    seedVenue(args) {
      return this.createVenue({ pspRecipientId: 'rcpt_demo', ...args });
    },
    async getVenue(venueId) {
      if (!isUuid(venueId)) return null;
      const { data, error } = await client
        .from('venues')
        .select(VENUE_COLS)
        .eq('id', venueId)
        .maybeSingle();
      throwOn(error, 'getVenue');
      return mapVenue(data);
    },
    async getTable(tableId) {
      if (!isUuid(tableId)) return null;
      const { data, error } = await client
        .from('venue_tables')
        .select('id, venue_id, label, qr_token, qr_rotated_at, active')
        .eq('id', tableId)
        .maybeSingle();
      throwOn(error, 'getTable');
      if (!data) return null;
      return {
        id: data.id, venueId: data.venue_id, label: data.label,
        qrToken: data.qr_token, qrRotatedAt: data.qr_rotated_at, active: data.active,
      };
    },
    /**
     * O ajuste ATÔMICO: `ADJUSTED` + itens na mesma transação, com a soma
     * conferida no banco (migração 0038). 40001 quando o razão mudou, 22023 em
     * entrada ruim — chegam no `pgCode` pelo `throwOn` e o serviço decide pelo
     * código (inegociável #7).
     */
    async adjustCheck(checkId, expectedSeq, totalCents, items) {
      const { data, error } = await client.rpc('adjust_check', {
        p_check_id: checkId, p_expected_seq: expectedSeq,
        p_total_cents: totalCents, p_items: items,
      });
      throwOn(error, 'adjustCheck');
      return data;
    },

    // --- ownership / membership ---------------------------------------------
    async addVenueMember(venueId, userId, role = PAPEL_DE_DONO) {
      if (!userId) throw new Error('userId required');
      // ignoreDuplicates: an existing (venue,user) row is left UNTOUCHED — a
      // re-add never silently changes a member's role (matches the memory
      // store's short-circuit; review finding). Role changes are an explicit
      // future operation, not a side effect of re-adding.
      const { error } = await client
        .from('venue_members')
        .upsert({ venue_id: venueId, user_id: userId, role }, { onConflict: 'venue_id,user_id', ignoreDuplicates: true });
      throwOn(error, 'addVenueMember');
      return { venueId, userId, role };
    },
    /**
     * DONO É QUEM TEM O PAPEL DE DONO.
     *
     * A tabela nasceu (0003) com `role in ('owner','staff')` e as duas leituras
     * — esta e `listVenuesForOwner` — nunca olharam a coluna: QUALQUER linha em
     * `venue_members` abria o painel inteiro, o `/api/refund`, os repasses e o
     * documento da casa. Hoje isso não vaza porque o único escritor é o
     * `POST /api/venues`, que grava `'owner'` fixo: medido em produção em
     * 2026-09-16, dez linhas, todas `owner`, zero `staff`. Então este conserto
     * não muda o comportamento de ninguém HOJE.
     *
     * É justamente por isso que ele entra agora. O dia em que alguém inserir um
     * `staff` — um convite de garçom, um INSERT à mão pra dar acesso "só de
     * leitura" — essa pessoa vira dono em silêncio, e o defeito nasce com cara
     * de feature nova funcionando. Uma coluna de papel que ninguém confere é um
     * portão destrancado esperando alguém encostar.
     *
     * O que NÃO se faz aqui: um sistema de permissões. `staff` não tem tela, e
     * o portão de adoção manda não construir v1 antes da hora. Ele fica de
     * fora, e quando existir alguém terá que decidir o que ele pode ver — com o
     * teste abaixo vermelho pra forçar a decisão.
     */
    async userOwnsVenue(userId, venueId) {
      if (!isUuid(userId) || !isUuid(venueId)) return false; // malformed → not an owner
      const { data, error } = await client
        .from('venue_members')
        .select('id')
        .eq('user_id', userId)
        .eq('venue_id', venueId)
        .eq('role', PAPEL_DE_DONO)
        .maybeSingle();
      throwOn(error, 'userOwnsVenue');
      return !!data;
    },
    async listVenuesForOwner(userId) {
      const data = await lerPaginado({
        op: 'listVenuesForOwner',
        consulta: (de, ate) => client.from('venue_members')
          .select('venues(id, name, city, servico_basis_points, psp_recipient_id, market)')
          .eq('user_id', userId).eq('role', PAPEL_DE_DONO)
          .order('venue_id', { ascending: true }).range(de, ate),
      });
      return data.map((r) => r.venues).filter(Boolean).map((v) => ({
        id: v.id, name: v.name, city: v.city,
        servicoBp: v.servico_basis_points, pspRecipientId: v.psp_recipient_id,
        market: v.market ?? DEFAULT_MARKET,
      }));
    },
    async venueIdForTable(tableId) {
      if (!isUuid(tableId)) return null;
      const { data, error } = await client
        .from('venue_tables').select('venue_id').eq('id', tableId).maybeSingle();
      throwOn(error, 'venueIdForTable');
      return data ? data.venue_id : null;
    },

    async createTable(venueId, label) {
      if (!label || !String(label).trim()) throw new Error('table label required');
      const { data, error } = await client
        .from('venue_tables')
        .insert({ venue_id: venueId, label: String(label).trim() })
        .select('id, venue_id, label, qr_token, qr_rotated_at, active')
        .single();
      // unique_violation on (venue_id, label) surfaces as a clear message.
      //
      // E sai com CÓDIGO, não só com a frase. A rota decidia por
      // `/duplicate/.test(e.message)` — uma decisão tomada sobre uma SUBSTRING
      // que atravessa dois módulos, que é a forma que o inegociável #7 manda
      // desconfiar. Basta uma mensagem futura conter a palavra ("duplicate key
      // in cache", um texto de proxy) pra o dono ler "já existe uma mesa com
      // esse nome" sobre uma falha que não é essa. Segunda revisão de segurança
      // de 2026-09-16 (LOW-E).
      if (error) {
        // PELO CÓDIGO (23505), não pela substring: a frase podia conter
        // "duplicate" por outro motivo (ver acima).
        try { throwOn(error, 'createTable'); } catch (e) {
          if (!unicidadeViolada(e)) throw e;
          const dup = new Error('duplicate table label'); dup.code = 'table_label_duplicate'; throw dup;
        }
      }
      return {
        id: data.id, venueId: data.venue_id, label: data.label,
        qrToken: data.qr_token, qrRotatedAt: data.qr_rotated_at, active: data.active,
      };
    },
    async seedTable(venueId, label, fixedToken) {
      if (!fixedToken) return this.createTable(venueId, label);
      // Token fixo é affordance SÓ de seed (a mesa pública da demo). Mesas de
      // produção sempre nascem com token aleatório do default da coluna.
      const { data, error } = await client
        .from('venue_tables')
        .insert({ venue_id: venueId, label: String(label).trim(), qr_token: fixedToken })
        .select('id, venue_id, label, qr_token, qr_rotated_at, active')
        .single();
      throwOn(error, 'seedTable');
      return {
        id: data.id, venueId: data.venue_id, label: data.label,
        qrToken: data.qr_token, qrRotatedAt: data.qr_rotated_at, active: data.active,
      };
    },
    async listTables(venueId) {
      // `label` não é ordem total, então o `id` desempata: sem ordem total,
      // duas páginas repetem e omitem a mesma mesa.
      const tabs = await lerPaginado({
        op: 'listTables',
        consulta: (de, ate) => client.from('venue_tables')
          .select('id, label, qr_token, qr_rotated_at, active, training')
          .eq('venue_id', venueId)
          .order('label', { ascending: true }).order('id', { ascending: true })
          .range(de, ate),
      });
      // hasOpenCheck by DERIVED state (the checks.status cache is unmaintained
      // in v0 — reading it left the badge stuck TRUE forever; review finding).
      const allChecks = await lerPaginado({
        op: 'listTables.checks',
        consulta: (de, ate) => client.from('checks').select('id, table_id')
          .eq('venue_id', venueId).order('id', { ascending: true }).range(de, ate),
      });
      // As FECHADAS numa leitura por lote, não o razão de cada conta: ver
      // `idsDeContasFechadas`.
      const fechadas = await idsDeContasFechadas((allChecks || []).map((c) => c.id));
      const openByTable = new Set();
      for (const c of allChecks || []) {
        if (!fechadas.has(c.id)) openByTable.add(c.table_id);
      }
      return (tabs || [])
        .map((t) => ({
          id: t.id, label: t.label, qrToken: t.qr_token,
          qrRotatedAt: t.qr_rotated_at, active: t.active, training: t.training === true,
          hasOpenCheck: openByTable.has(t.id),
        }))
        // Same locale-numeric sort as the memory store (Mesa 2 < Mesa 10).
        .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true }));
    },
    /**
     * Rotate a table's QR token — the OLD token stops resolving immediately
     * (security property). Plain UPDATE by id (no or= filter → no PostgREST
     * 42703). Token generated app-side to mirror the column default.
     */
    async rotateTableQr(tableId, nowIso) {
      const newToken = require('crypto').randomUUID().replace(/-/g, '');
      const { data, error } = await client
        .from('venue_tables')
        .update({ qr_token: newToken, qr_rotated_at: nowIso || new Date().toISOString() })
        .eq('id', tableId)
        .select('id, qr_token, qr_rotated_at')
        .single();
      throwOn(error, 'rotateTableQr');
      return { id: data.id, qrToken: data.qr_token, qrRotatedAt: data.qr_rotated_at };
    },
    /** Mesa de treino: não cobra (`mesa-de-treino.js`); o painel não a esconde. */
    async setTableTraining(tableId, training) {
      // MARCAR com conta aberta é recusado, pela regra do `setTableActive`: o
      // próximo poll trocaria os botões de pagar pelo aviso de treino no
      // telefone de quem está pagando (segurança, PR #18, L1). Tirar do treino
      // não precisa: volta a cobrar, que é o normal.
      if (training) {
        const checkRows = await lerPaginado({
          op: 'setTableTraining.checks',
          consulta: (de, ate) => client.from('checks').select('id')
            .eq('table_id', tableId).order('id', { ascending: true }).range(de, ate),
        });
        const fechadas = await idsDeContasFechadas((checkRows || []).map((c) => c.id));
        if ((checkRows || []).some((c) => !fechadas.has(c.id))) {
          const e = new Error('table has an open check — close it before marking it as training');
          e.statusCode = 409; e.code = 'table_has_open_check'; throw e;
        }
      }
      const { data, error } = await client
        .from('venue_tables')
        .update({ training: !!training })
        .eq('id', tableId)
        .select('id, training')
        .single();
      throwOn(error, 'setTableTraining');
      return { id: data.id, training: data.training };
    },
    async setTableActive(tableId, active) {
      // Refuse to deactivate a table with an open check — no new token to fall
      // back to, so a mid-payment diner would be stranded (review finding).
      if (!active) {
        // Truncada, esta leitura faz o guarda FALHAR ABERTO: a conta aberta
        // fica fora das primeiras mil e a mesa é desativada com gente sentada.
        const checkRows = await lerPaginado({
          op: 'setTableActive.checks',
          consulta: (de, ate) => client.from('checks').select('id')
            .eq('table_id', tableId).order('id', { ascending: true }).range(de, ate),
        });
        // As fechadas numa leitura por lote — ver `idsDeContasFechadas`.
        const fechadas = await idsDeContasFechadas((checkRows || []).map((c) => c.id));
        if ((checkRows || []).some((c) => !fechadas.has(c.id))) {
          throw new Error('table has an open check — close it before deactivating');
        }
      }
      const { data, error } = await client
        .from('venue_tables')
        .update({ active: !!active })
        .eq('id', tableId)
        .select('id, active')
        .single();
      throwOn(error, 'setTableActive');
      return { id: data.id, active: data.active };
    },

    async openCheck(tableQrToken, items) {
      const { data: table, error: tErr } = await client
        .from('venue_tables')
        .select('id, venue_id')
        .eq('qr_token', tableQrToken)
        .maybeSingle();
      throwOn(tErr, 'openCheck.table');
      if (!table) throw new Error('unknown table');

      const totalCents = items.reduce((s, i) => s + i.priceCents, 0);
      /**
       * UMA TRANSAÇÃO SÓ — a linha e o `OPENED` (migração 0037, `open_check`).
       *
       * Eram duas idas: o `insert` e depois o `appendEvent`. Se a segunda
       * morresse, a linha ficava órfã pra sempre e o índice de uma aberta por
       * mesa trancava a mesa. Agora, ou entram as duas, ou nenhuma.
       *
       * O 409 da mesa já aberta sai pelo CÓDIGO do índice (23505), não por regex
       * na mensagem (compliance, PR #16, L-3). Qualquer outro erro sobe: nunca
       * se trata um erro de claim como "já existia".
       */
      // A casa sai da mesa DENTRO da função (0037) — não vai como parâmetro.
      const { data: checkId, error: cErr } = await client.rpc('open_check', {
        p_table_id: table.id,
        p_total_cents: totalCents,
        // Full JSON — item count is bounded upstream (normalizeItems), so the
        // old 2000-char slice (which sliced mid-JSON → parse fail → the diner
        // saw an EMPTY item list on big checks) is gone (review finding).
        p_pos_ref: JSON.stringify(items),
      });
      if (cErr && cErr.code === '23505') {
        const e = new Error('mesa já tem uma conta aberta'); e.statusCode = 409; e.code = 'check_already_open'; throw e;
      }
      throwOn(cErr, 'openCheck.open_check');
      if (typeof checkId !== 'string') throw new Error('openCheck: open_check não devolveu o id da conta');
      return { id: checkId, venueId: table.venue_id, tableId: table.id, items };
    },

    // --- reads -------------------------------------------------------------
    async getCheckByQrToken(qrToken) {
      const { data: table, error: tErr } = await client
        .from('venue_tables')
        // `market` no SELECT: sem ele a coluna chega undefined e a conta cai no
        // default brasileiro — uma mesa de Madrid cobrando em real, em silêncio.
        // `training`: a mesa de treino não cobra (`mesa-de-treino.js`), e quem
        // recusa é o caminho do dinheiro — ele lê a marca DAQUI.
        .select('id, label, venue_id, training, venues(name, cnpj, servico_basis_points, market)')
        .eq('qr_token', qrToken)
        .eq('active', true) // inactive/rotated token is dead (security property)
        .maybeSingle();
      throwOn(tErr, 'getCheckByQrToken.table');
      if (!table) return null;

      // Since migration 0004 the ONE cache transition that matters
      // (status → 'fechada' on CLOSED) is maintained inside the locked append
      // RPC and was backfilled, so filtering closed checks out HERE is safe —
      // and necessary: the old unfiltered `.limit(10)` oldest-first scan went
      // blind once a table accumulated 10 closed checks, killing the whole
      // pay flow for that table (review finding, HIGH). The derived-state
      // skip below stays as the authority (belt and suspenders).
      const { data: cands, error: cErr } = await client
        .from('checks')
        .select('id, pos_ref, opened_at')
        .eq('table_id', table.id)
        .neq('status', 'fechada')
        .order('opened_at', { ascending: true })
        .limit(10);
      throwOn(cErr, 'getCheckByQrToken.check');

      // POR LOTE, e num salto só: são até dez candidatas, e esta é a rota que
      // TODO QR lido atravessa — dez idas em série no caminho do cliente que
      // está com o telefone na mão em cima da mesa. Ver `loadEventsPorLote`.
      const razoes = await loadEventsPorLote((cands || []).map((c) => c.id));
      for (const cand of cands || []) {
        const state = reduce(razoes.get(cand.id) || []);
        /**
         * SEM `OPENED`, A CONTA AINDA NÃO ESTÁ ABERTA.
         *
         * Até a 0037, `openCheck` gravava a linha e o `OPENED` em duas idas ao
         * banco: entre elas o razão estava vazio e `reduce([])` é `null`, o que
         * fazia `state.status` lançar (500 em `/api/check`). Hoje a `open_check`
         * grava os dois numa transação e a janela não existe mais; o que resta
         * são as linhas órfãs de ANTES — e, durante o rollout, uma instância
         * com o código velho. A leitura diz a verdade: não há conta aberta.
         *
         * E PULAR NÃO É CALAR. A primeira versão deste `continue` trocou o 500
         * por um 404 idêntico a "o garçom ainda não abriu", sem log: a mesa
         * órfã ficava trancada e ninguém sabia (revisão da quarta rodada).
         * Passada a janela normal, cada leitura escreve o alarme. Ver
         * `conta-sem-opened.js`.
         */
        if (!state) {
          const { idadeMs, orfa } = idadeSemOpened(cand.opened_at, Date.now());
          if (orfa) process.stderr.write(linhaDeAlarme(cand.id, idadeMs, 'getCheckByQrToken'));
          continue;
        }
        if (state.status === 'fechada') continue;
        // Os itens do RAZÃO (a mesma leitura do total); o `pos_ref` só pra conta
        // de antes da 0038/0039. Ver `itensDoRazao`.
        let items = itensDoRazao(razoes.get(cand.id));
        if (!items) { try { items = JSON.parse(cand.pos_ref) || []; } catch { items = []; } }
        return {
          venue: {
            name: table.venues.name,
            // O VALOR também decide, não só o mercado: onze dígitos nesta coluna
            // numa casa brasileira é CPF de alguém, e `/api/check` não tem
            // autenticação. Linhas antigas foram escritas antes do portão do
            // `createVenue` existir. Ver `documentoPublicavelDaCasa`.
            taxId: documentoPublicavelDaCasa(table.venues.market, table.venues.cnpj, showsVenueTaxId(table.venues.market)),
            // `cnpj` vai junto: sem documento de empresa provado a casa não pode
            // cobrar serviço, e o que não pode ser cobrado não é oferecido.
            ...publicMarketView(table.venues.market, { servicoBp: table.venues.servico_basis_points, cnpj: table.venues.cnpj }),
          },
          table: { label: table.label, training: table.training === true },
          check: { id: cand.id, items },
          state,
        };
      }
      return null;
    },

    loadEvents,

    async findCheckByTxid(txid) {
      const { data, error } = await client
        .from('payments')
        .select('check_id')
        .eq('txid', txid)
        .maybeSingle();
      throwOn(error, 'findCheckByTxid');
      return data ? { id: data.check_id } : null;
    },

    async getVenueForCheck(checkId) {
      if (!isUuid(checkId)) return null;
      const { data, error } = await client
        .from('checks')
        .select(`venues(${VENUE_COLS})`)
        .eq('id', checkId)
        .maybeSingle();
      throwOn(error, 'getVenueForCheck');
      if (!data || !data.venues) return null;
      return mapVenue(data.venues);
    },

    async getPayment(txid) {
      const { data, error } = await client
        .from('payments')
        // Os ACUMULADOS ESTORNADOS entram aqui porque a guarda de versão do
        // reparo (migração 0023) compara justamente eles. Sem as colunas, o
        // `repairRowFromLedger` mandava `0` sempre — e a guarda passava só na
        // linha virgem, ficando INERTE em toda linha que já teve estorno, que é
        // exatamente a família que ela existe pra proteger. Achado pela
        // revisão de segurança de 2026-09-08.
        // `venue_id`, `currency` e `created_at` entram porque o store de MEMÓRIA
        // os devolve, e um dublê que oferece campo que a produção não tem é uma
        // armadilha esperando o próximo leitor: ele usa, passa no teste, e em
        // produção recebe `undefined`. Nenhum código lê estes três hoje — é
        // justamente por isso que dá pra igualar agora, de graça. Ver
        // `store-shape.test.js`.
        .select('txid, check_id, venue_id, amount_cents, tip_cents, currency, confirmed_amount_cents, confirmed_tip_cents, payer_label, status, method, psp_payload_masked, confirmed_at, created_at, refunded_amount_cents, refunded_tip_cents')
        .eq('txid', txid)
        .maybeSingle();
      throwOn(error, 'getPayment');
      if (!data) return null;
      return {
        txid: data.txid, checkId: data.check_id,
        amountCents: data.amount_cents, tipCents: data.tip_cents,
        payerLabel: data.payer_label, status: data.status, method: data.method,
        pspPayloadMasked: data.psp_payload_masked, confirmedAt: data.confirmed_at,
        refundedAmountCents: data.refunded_amount_cents || 0,
        refundedTipCents: data.refunded_tip_cents || 0,
        venueId: data.venue_id, currency: data.currency, createdAt: data.created_at,
        // Os CONFIRMADOS: as colunas que viram faturamento e gorjeta. O store
        // de memória as devolvia e este não — mesma armadilha dos três acima.
        confirmedAmountCents: data.confirmed_amount_cents,
        confirmedTipCents: data.confirmed_tip_cents,
      };
    },

    // --- writes ------------------------------------------------------------
    /**
     * @param {string} [pspEventId] id do evento do PSP. O RPC confere DENTRO do
     *   lock e devolve `seq` negativo quando já aplicou (migração 0018) — é o
     *   que fecha a corrida entre duas entregas simultâneas do mesmo evento.
     */
    /**
     * COMPARE-AND-APPEND (migração 0034). O RPC confere o último `seq` DENTRO
     * da trava e recusa com 40001 quando o razão mudou; o índice único parcial
     * recusa com 23505 a mesma devolução fora do trilho registrada duas vezes.
     * Os dois códigos chegam no `pgCode` pelo `throwOn` — e são CHECADOS pela
     * rota (inegociável #7).
     */
    async appendEventIfUnchanged(checkId, type, payload, pspEventId = null, expectedSeq = null) {
      const { data, error } = await client.rpc('append_check_event_if_unchanged', {
        p_check_id: checkId, p_type: type, p_payload: payload,
        p_psp_event_id: pspEventId, p_expected_seq: expectedSeq,
      });
      throwOn(error, 'appendEventIfUnchanged');
      return data;
    },
    async appendEvent(checkId, type, payload, pspEventId = null) {
      const { data, error } = await client.rpc('append_check_event', {
        p_check_id: checkId, p_type: type, p_payload: payload, p_psp_event_id: pspEventId,
      });
      throwOn(error, 'appendEvent'); // NEVER treat an errored claim as "skipped"
      return data;
    },

    /**
     * Evento de dinheiro que não achou conta (migração 0024). Reentrega não
     * duplica: `psp_event_id` é único, e o conflito é sucesso — a linha já
     * está lá.
     * @returns {Promise<boolean>} true = registrado (ou já estava).
     */
    async recordOrphanMoneyEvent(e) {
      const { error } = await client.from('orphan_money_events').insert({
        kind: e.kind, psp: e.psp || null, event_type: e.eventType || null,
        txid: e.txid || null, psp_event_id: e.pspEventId || null,
        amount_cents: e.amountCents ?? null, payload: e.payload || null,
      });
      if (error && error.code === '23505') return true; // já registrado
      throwOn(error, 'recordOrphanMoneyEvent');
      return true;
    },

    /**
     * Registra que alguém ABRIU a conta na mesa (migração 0028).
     *
     * Idempotente por (conta, sessão): o app consulta a conta a cada 4
     * segundos, e contar leitura seria contar polling em vez de gente. O
     * conflito é sucesso — a pessoa já estava contada.
     */
    async recordCheckView({ checkId, venueId, tableId, sessionHash }) {
      const { error } = await client.from('check_views').insert({
        check_id: checkId, venue_id: venueId, table_id: tableId || null,
        session_hash: sessionHash,
      });
      if (error && error.code === '23505') return false;   // já contada
      throwOn(error, 'recordCheckView');
      return true;
    },

    /**
     * O FUNIL de adoção por casa: abriram → pagaram. É o que o portão do
     * CLAUDE.md pede e o banco não sabia responder.
     */
    async getAdoptionFunnel(venueId, { sinceIso } = {}) {
      const desde = sinceIso || new Date(Date.now() - 30 * 86400000).toISOString();
      // As TRÊS paginam: é este funil que mede o portão de adoção (≥25% em oito
      // semanas), e uma leitura cortada mede a casa pela metade — decisão de
      // roteiro tomada sobre um número truncado, sem erro nenhum na tela.
      const [views, checks, pagos] = await Promise.all([
        lerPaginado({ op: 'getAdoptionFunnel.views',
          consulta: (de, ate) => client.from('check_views').select('check_id')
            .eq('venue_id', venueId).gte('at', desde).order('check_id', { ascending: true }).range(de, ate) }),
        lerPaginado({ op: 'getAdoptionFunnel.checks',
          consulta: (de, ate) => client.from('checks').select('id')
            .eq('venue_id', venueId).gte('opened_at', desde).order('id', { ascending: true }).range(de, ate) }),
        lerPaginado({ op: 'getAdoptionFunnel.pagos',
          consulta: (de, ate) => client.from('payments').select('check_id')
            .eq('venue_id', venueId).eq('status', 'confirmado').gte('confirmed_at', desde)
            // `check_id` NÃO é ordem total aqui (uma conta tem vários
            // pagamentos), e é de propósito: as duas leituras colapsam num
            // `Set` de `check_id`, então embaralhar empates dentro do mesmo
            // grupo não muda o resultado. Vira defeito no dia em que alguma
            // delas CONTAR linhas em vez de colapsar — que é exatamente o que a
            // irmã aqui do lado (`contasCriadas`) faz. Se esta projeção mudar,
            // a ordem tem que ficar total.
            .order('check_id', { ascending: true }).order('txid', { ascending: true }).range(de, ate) }),
      ]);
      // `lerPaginado` devolve um ARRAY, não `{ data }`. A conversão pra
      // paginação trocou `views.data` por `views` e esqueceu os outros dois:
      // `contasCriadas` e `contasPagas` viravam ZERO pra sempre, sem erro — e é
      // deste número que sai o portão de adoção (≥25% em oito semanas) que o
      // CLAUDE.md diz que estaciona o produto. A forma "conserto pela metade",
      // dentro do commit que existe pra acabar com consertos pela metade.
      // Segunda revisão de segurança de 2026-09-16 (NEW-2).
      const abertas = new Set(views.map((r) => r.check_id));
      const pagas = new Set(pagos.map((r) => r.check_id));
      /** O numerador INTERSECTADO: quem pagou E foi visto na mesa. */
      const convertidas = new Set([...pagas].filter((id) => abertas.has(id)));
      return {
        contasCriadas: checks.length,
        contasAbertasNaMesa: abertas.size,
        contasPagas: pagas.size,
        // A leitura do portão: das contas que alguém ABRIU, quantas fecharam
        // pelo Racha. Sem o denominador certo, 25% não quer dizer nada.
        /**
         * A CONVERSÃO É SOBRE QUEM ABRIU — e o numerador tem que ser subconjunto
         * do denominador.
         *
         * Era `pagas.size / abertas.size` com os dois conjuntos medidos
         * INDEPENDENTES. O `recordCheckView` é telemetria de navegador, melhor
         * esforço: bloqueada, limitada por taxa ou perdida, a conta entra em
         * `pagas` e não em `abertas`. Com duas contas — A vista e não paga, B paga
         * com o beacon bloqueado — a conta dava 1.0, ou seja 100% de conversão,
         * onde a verdadeira é 0%. E é este número que o portão de adoção lê pra
         * decidir se o produto continua (CLAUDE.md, ≥25% na semana 8): inflado,
         * ele mantém vivo um piloto que fracassou. Achado pela terceira revisão de
         * segurança de 2026-09-16 (M4).
         */
        conversao: abertas.size > 0 ? convertidas.size / abertas.size : null,
      };
    },

    /** Órfãos ainda ABERTOS — o que a conciliação diária tem que gritar. */
    async listOpenOrphanMoneyEvents(limit = 50) {
      const { data, error } = await client
        .from('orphan_money_events')
        // `payload` entra porque é nele que viaja o `orderCode` — o endereço da
        // conta. Sem ele, o aviso diário dizia "sumiu dinheiro" e não dizia de
        // qual mesa, e o procedimento mandava consultar um campo que a leitura
        // nem trazia.
        .select('id, at, kind, psp, event_type, txid, amount_cents, payload')
        .is('resolved_at', null)
        .order('at', { ascending: false })
        .limit(limit);
      throwOn(error, 'listOpenOrphanMoneyEvents');
      return (data || []).map((o) => ({
        id: o.id, at: o.at, kind: o.kind, psp: o.psp,
        eventType: o.event_type, txid: o.txid, amountCents: o.amount_cents,
        orderCode: (o.payload && o.payload.orderCode) || null,
      }));
    },

    /**
     * Reprojeta a linha a partir do razão SÓ se ela ainda estiver como foi
     * lida (migração 0023). Claim condicional → RPC com o erro conferido
     * (inegociável #7): a reparação roda justamente quando há duas entregas em
     * voo, e um UPDATE cego perdia a escrita da outra.
     * @returns {Promise<boolean>} true = reparou; false = a linha mudou.
     */
    async repairPaymentRow(p) {
      const { data, error } = await client.rpc('repair_payment_row', {
        p_txid: p.txid,
        p_expected_status: p.expectedStatus,
        p_expected_refunded_amount: p.expectedRefundedAmountCents,
        p_expected_refunded_tip: p.expectedRefundedTipCents,
        p_status: p.status,
        p_confirmed_amount: p.confirmedAmountCents,
        p_confirmed_tip: p.confirmedTipCents,
        p_refunded_amount: p.refundedAmountCents,
        p_refunded_tip: p.refundedTipCents,
        p_confirmed_at: p.confirmedAt || null,
        // QUEM pediu (migração 0029). O log gravava "reentrega de webhook" pros
        // três chamadores, e a varredura noturna — que roda sem ninguém
        // presente e escreve a base da folha — era um deles. Registro que
        // descreve a operação errada é prova pior que nenhuma (LGPD art. 37).
        p_source: p.source || null,
      });
      throwOn(error, 'repairPaymentRow'); // claim com erro NUNCA é "pulou"
      return data === true;
    },

    /**
     * Expira uma cobrança SÓ enquanto ela ainda está `pendente` (migração
     * 0020). Claim condicional → RPC com o erro conferido (inegociável #7):
     * um UPDATE cego aqui apagava um pagamento confirmado quando o
     * `payment_failed` chegava depois do `succeeded`.
     * @returns {Promise<boolean>} true = expirou agora.
     */
    async expirePaymentIfPending(txid) {
      const { data, error } = await client.rpc('expire_payment_if_pending', { p_txid: txid });
      throwOn(error, 'expirePaymentIfPending'); // claim com erro NUNCA é "pulou"
      return data === true;
    },

    /** Ver `seenPspEvent` no store de memória: resposta honesta, não garantia. */
    async seenPspEvent(pspEventId) {
      if (pspEventId == null) return false;
      const { data, error } = await client
        .from('check_events').select('seq').eq('psp_event_id', pspEventId).limit(1);
      throwOn(error, 'seenPspEvent');
      return Boolean(data && data.length);
    },
    async registerCharge({ checkId, txid, amountCents, tipCents, payerLabel, method = 'pix' }) {
      // O RÓTULO DO PAGADOR É CONFERIDO AQUI, no único ponto por onde TODA
      // cobrança passa. A regra existia só no `create-charge`, e o
      // `/api/pay/stripe-intent` — pública, token de mesa, sem sessão — chama
      // o `registerCharge` DIRETO: um `payerLabel` de 900 KB, ou um objeto no
      // lugar de uma string, chegava intacto à coluna que o painel do dono lê
      // de volta. É a forma "chamador esquecido" que este repositório já
      // nomeia três vezes, e o conserto é o mesmo das outras: a regra desce
      // pro sítio que não dá pra contornar, em vez de virar mais um item num
      // censo de chamadores. Achado pela revisão de segurança de 2026-09-15.
      //
      // E ele NORMALIZA, não só confere. Enquanto a regra era uma lista de
      // recusa, "conferir aqui" e "conferir no portão" davam no mesmo. Quando o
      // portão passou a LIMPAR, os dois deixaram de coincidir: o portão
      // aprovava `"Ana" + cem espaços` (que normaliza pra `"Ana"`) e esta linha
      // recusava o cru, DEPOIS de o adquirente já ter criado a cobrança — e a
      // vaga do teto não voltava. Guardar o normalizado é o que faz "o valor
      // conferido é o valor gravado" valer por construção, em vez de por
      // disciplina de chamador. Segunda revisão de segurança de 2026-09-16
      // (NEW-1).
      const rotulo = rotuloDoPagador(payerLabel);
      if (!rotulo.ok) throw badRequest('payerLabel must be a string of at most 60 chars');
      payerLabel = rotulo.valor;
      const { data: check, error: cErr } = await client
        .from('checks').select('venue_id, venues(market)').eq('id', checkId).single();
      throwOn(cErr, 'registerCharge.check');
      const { error } = await client.from('payments').insert({
        check_id: checkId, venue_id: check.venue_id, txid,
        method, amount_cents: amountCents, tip_cents: tipCents,
        payer_label: payerLabel || null,
        // A MOEDA na linha. Nunca deduzida na leitura a partir de
        // `venues.market`: o market pode mudar e o pagamento não — e a
        // conciliação compararia 20000 com 20000 atravessando uma troca de
        // moeda, reportando 0,00 de divergência. Ver 0014_payment_currency.sql.
        currency: market(check.venues && check.venues.market).currency,
      });
      throwOn(error, 'registerCharge');
    },

    async recordPayment({
      txid, kind, status, pspPayloadMasked, confirmedAt,
      confirmedAmountCents = null, confirmedTipCents = null,
      refundedAmountCents = null, refundedTipCents = null,
    }) {
      const { error } = await client
        .from('payments')
        .update({
          // Os valores CONFIRMADOS entram ao lado dos registrados, nunca em
          // cima (migração 0015). Sobrescrever seria a correção óbvia e
          // destruiria o detector: é comparar pedido contra log que produz o
          // `amount_mismatch`.
          ...(confirmedAmountCents !== null ? { confirmed_amount_cents: confirmedAmountCents } : {}),
          ...(confirmedTipCents !== null ? { confirmed_tip_cents: confirmedTipCents } : {}),
          // Acumulado ESTORNADO na linha (migração 0016) — ver `confirmedMoney`.
          ...(refundedAmountCents !== null ? { refunded_amount_cents: refundedAmountCents } : {}),
          ...(refundedTipCents !== null ? { refunded_tip_cents: refundedTipCents } : {}),
          // O status vem resolvido do módulo de dinheiro (ver
          // ROW_STATUS_FOR_KIND). Era `kind === 'refund' ? … : 'confirmado'` aqui,
          // e com a família da disputa lida de verdade esse `else` fazia uma
          // disputa PERDIDA virar `confirmado` com o dinheiro já ido.
          status: status || (kind === 'refund' ? 'devolvido' : 'confirmado'),
          // `undefined` e NAO MEXER — explicito, e nao por acidente do
          // serializador. Era o `JSON.stringify` do supabase-js dropando a
          // chave que fazia isto funcionar, e o store de memoria, que nao tem
          // serializador, apagava a data. Ver `recordPayment` la.
          ...(pspPayloadMasked !== undefined ? { psp_payload_masked: pspPayloadMasked } : {}),
          ...(confirmedAt !== undefined ? { confirmed_at: confirmedAt } : {}),
        })
        .eq('txid', txid);
      throwOn(error, 'recordPayment');
    },

    // --- reconciliation -----------------------------------------------------
    /**
     * Pending PIX/card charges to actively reconcile against the PSP. A pure
     * READ (no PostgREST claim — rule 7 is about UPDATE+filter). Bounded by a
     * time window: created before now-graceMs (webhook got first crack) and
     * after now-windowMs (past-expiry charges drop out without any write).
     */
    /**
     * O TETO DE COBRANÇAS VIVAS: conta e reserva numa instrução só, no banco.
     * Ver `0033_charge_slots.sql` e o gêmeo em `memory.js`.
     *
     * O ERRO É CHECADO e ESTOURA (inegociável #7): sem a RPC — migração não
     * aplicada — a cobrança falha fechado, nunca passa sem teto. A ordem de
     * deploy é, portanto, MIGRAÇÃO PRIMEIRO.
     */
    async claimSlots({ keys, limits, windowMs } = {}) {
      const { data, error } = await client.rpc('claim_slots', {
        p_keys: keys, p_limits: limits, p_window_seconds: Math.round(windowMs / 1000),
      });
      throwOn(error, 'claimSlots');
      if (!data || typeof data !== 'object' || !('claim_id' in data)) {
        throw new Error('claimSlots: resposta sem claim_id');
      }
      return { claimId: data.claim_id, fullIndex: data.full_index, counts: data.counts || [] };
    },
    async releaseSlots(claimId) {
      const { data, error } = await client.rpc('release_slots', { p_claim_id: claimId });
      throwOn(error, 'releaseSlots');
      return data || 0;
    },
    /**
     * A impressão digital da 0033 instalada — ver `charge_slots_fingerprint()`.
     * Erro checado e resposta conferida: sem a função, ou com uma resposta que
     * não é texto, ESTOURA — quem compara é o cron, e ele pagina.
     */
    async slotsFingerprint() {
      const { data, error } = await client.rpc('charge_slots_fingerprint');
      throwOn(error, 'slotsFingerprint');
      if (typeof data !== 'string' || !/^[0-9a-f]{32}$/.test(data)) {
        throw new Error('slotsFingerprint: resposta não é um md5');
      }
      return data;
    },
    async listPendingCharges({ checkId = null, graceMs = 0, windowMs = null, limit = 100 } = {}) {
      const now = Date.now();
      let q = client
        .from('payments')
        .select('txid, check_id, amount_cents, tip_cents, method, currency, created_at')
        .eq('status', 'pendente')
        // Exclusão, não inclusão — ver INLINE_METHODS no store de memória: uma
        // lista de inclusão deixava todo trilho novo (Bizum) fora da
        // reconciliação ativa, em silêncio.
        .not('method', 'in', '("house_account")')
        .lt('created_at', new Date(now - graceMs).toISOString())
        .order('created_at', { ascending: true })
        .limit(limit);
      if (windowMs != null && Number.isFinite(windowMs)) {
        q = q.gte('created_at', new Date(now - windowMs).toISOString());
      }
      if (checkId) q = q.eq('check_id', checkId);
      const { data, error } = await q;
      throwOn(error, 'listPendingCharges');
      return (data || []).map((r) => ({
        checkId: r.check_id, txid: r.txid,
        amountCents: r.amount_cents, tipCents: r.tip_cents, method: r.method,
        // `currency` viaja com a linha porque é a CONCILIAÇÃO que precisa dela:
        // comparar centavos por venue sem saber a moeda é o jeito de atravessar
        // uma troca de moeda reportando 0,00 de divergência.
        currency: r.currency,
        // `createdAt` pro julgamento de ABANDONO — ver `reconcile-charges.js`.
        createdAt: r.created_at,
      }));
    },

    /**
     * Cobranças CONFIRMADAS recentes de um restaurante — pra conferir o destino
     * do dinheiro nos recebíveis do adquirente (a terceira perna).
     *
     * Limitada por janela e por quantidade porque cada uma custa uma chamada de
     * API: a varredura diária não pode virar mil requisições.
     */
    /**
     * Quantas cobranças a casa JÁ confirmou — sem janela.
     *
     * `listRecentConfirmedCharges` tem recorte de data porque alimenta a perna
     * por cobrança, que é I/O externo. O guarda de recebedor inutilizável faz
     * uma pergunta diferente: "esta casa já recebeu dinheiro alguma vez?" — uma
     * propriedade PERMANENTE. Perguntá-la pela janela de 24h fazia o achado se
     * calar no dia seguinte. `head: true` não traz linha nenhuma, só o total.
     */
    async contarCobrancasConfirmadas(venueId) {
      if (!isUuid(venueId)) return 0;
      const { count, error } = await client
        .from('payments')
        .select('txid', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('status', 'confirmado')
        .not('confirmed_at', 'is', null)
        // `house_account` não passa por adquirente: não tem recebível, e por
        // isso não conta como "dinheiro que precisa de destino conferível".
        .neq('method', 'house_account');
      throwOn(error, 'contarCobrancasConfirmadas');
      return count || 0;
    },

    async listRecentConfirmedCharges(venueId, { sinceIso, limit = 50 } = {}) {
      let q = client
        .from('payments')
        .select('txid, check_id, amount_cents, tip_cents, confirmed_amount_cents, confirmed_tip_cents, method, confirmed_at')
        .eq('venue_id', venueId)
        .eq('status', 'confirmado')
        .not('confirmed_at', 'is', null)
        .order('confirmed_at', { ascending: false })
        .limit(limit);
      if (sinceIso) q = q.gte('confirmed_at', sinceIso);
      const { data, error } = await q;
      throwOn(error, 'listRecentConfirmedCharges');
      return (data || [])
        // `house_account` não passa por adquirente: não tem recebível.
        .filter((p) => p.method !== 'house_account')
        .map((p) => ({
          txid: p.txid, checkId: p.check_id, method: p.method, confirmedAt: p.confirmed_at,
          // O CAPTURADO, que é contra o que os recebíveis são conferidos.
          paidAmountCents: Number.isFinite(p.confirmed_amount_cents)
            ? (p.confirmed_amount_cents || 0) + (p.confirmed_tip_cents || 0)
            : (p.amount_cents || 0) + (p.tip_cents || 0),
        }));
    },

    async listChecksForReconcile(venueId) {
      /**
       * A CONSULTA QUE DIRIGE AS OUTRAS TAMBÉM PAGINA.
       *
       * O commit anterior paginou os FILHOS (razão e pagamentos) e deixou esta
       * — a lista de contas da casa — com um `select` seco. Acima de mil
       * contas o PostgREST devolvia as primeiras mil com um 200, e a
       * conciliação diária passava a rodar para sempre sobre um subconjunto
       * arbitrário da história da casa, dizendo que bate. E não é só drift
       * escondido: `reconcileVenueHouse` monta `checkLedgerTxids` a partir
       * desta lista, então um resgate cujo razão ficou de fora vira um achado
       * `critical` mandando RE-CREDITAR a conta da casa — o cliente fica com a
       * refeição e com o saldo de volta. Saldo pré-pago é dinheiro do cliente.
       *
       * O docblock do `lerPorLote` já descrevia esse corte, o que fazia esta
       * lacuna parecer coberta. Achado pela revisão de compliance de
       * 2026-09-16 (HIGH-2).
       */
      const checks = await lerPaginado({
        op: 'listChecksForReconcile.checks',
        // `order('id')`: sem ordem total, duas páginas repetem e omitem a mesma
        // linha — o mesmo motivo do `ordem` do `lerPorLote`.
        // `opened_at`: a conciliação precisa da idade pra separar a conta que
        // está abrindo AGORA da órfã. Ver `conta-sem-opened.js`.
        // `status`: a COLUNA, não o razão. É ela que tranca a mesa (o índice de
        // uma aberta por mesa), e é ela que o reparo à mão de uma órfã muda.
        consulta: (de, ate) => client.from('checks').select('id, opened_at, status').eq('venue_id', venueId)
          .order('id', { ascending: true }).range(de, ate),
      });
      const out = [];
      // POR LOTE, os dois lados. Era UMA leitura de pagamentos MAIS uma do
      // razão POR CONTA, em série: 2N+1 idas pra conciliar uma casa, e a
      // conciliação roda todo dia sobre a casa INTEIRA (inegociável #8). Uma
      // casa de cinco mil contas fazia dez mil idas e batia no `maxDuration`
      // antes de terminar — a conciliação parava de rodar justo quando a casa
      // ficava grande o bastante pra importar.
      const ids = (checks || []).map((c) => c.id);
      const [razoes, pagamentos] = await Promise.all([
        loadEventsPorLote(ids),
        lerPorLote({
          tabela: 'payments',
          // Os CONFIRMADOS entram na leitura da conciliação: são as colunas
          // que o painel soma em faturamento e em GORJETA (base da folha, Lei
          // 13.419), e até aqui elas eram conferidas contra NADA. Ver
          // `reconcileCheck`.
          colunas: 'check_id, txid, amount_cents, tip_cents, confirmed_amount_cents, confirmed_tip_cents, refunded_amount_cents, refunded_tip_cents, status, method, currency, confirmed_at',
          coluna: 'check_id',
          ids,
          ordem: ['check_id', 'txid'],
          op: 'listChecksForReconcile.payments',
        }),
      ]);
      for (const c of checks || []) {
        const pays = pagamentos.get(c.id) || [];
        out.push({
          checkId: c.id,
          openedAt: c.opened_at,
          statusDaLinha: c.status,
          events: razoes.get(c.id) || [],
          payments: (pays || []).map((p) => ({
            txid: p.txid, amountCents: p.amount_cents, tipCents: p.tip_cents,
            status: p.status, method: p.method, currency: p.currency,
            // Nulo é histórico (linha anterior à migração 0015): o
            // `confirmedMoney` cai no registrado, e a conciliação faz o mesmo.
            confirmedAmountCents: p.confirmed_amount_cents,
            confirmedTipCents: p.confirmed_tip_cents,
            // A DATA: é ela que faz a dívida de restituição envelhecer.
            confirmedAt: p.confirmed_at,
            // Acumulados estornados: a conciliação soma LÍQUIDO dos dois lados.
            refundedAmountCents: p.refunded_amount_cents || 0,
            refundedTipCents: p.refunded_tip_cents || 0,
          })),
        });
      }
      return out;
    },

    // --- house accounts (saldo da casa) -------------------------------------
    // Operational balances (principal_cents + house_bonus_lots) are written
    // ONLY by the house_* RPCs (locked per account, salt 43); reads here
    // derive from the ledger exactly like the memory store, so both stores
    // present identical views. listHouseAccountsForReconcile exposes the
    // stored columns for the cross-check.
    /**
     * A mesa por token IGNORANDO `active` — só pra decidir se ela já existe.
     * `getVenueByTableToken` filtra por ativa (propriedade de segurança: token
     * girado/desativado é token morto), e semear com base nesse null cria uma
     * venue órfã por request quando a mesa existe mas está desativada.
     */
    async findTableAnyState(qrToken) {
      if (!qrToken) return null;
      const { data, error } = await client
        .from('venue_tables')
        .select('id, venue_id, label, qr_token, active')
        .eq('qr_token', qrToken)
        .maybeSingle();
      throwOn(error, 'findTableAnyState');
      return data ? { id: data.id, venueId: data.venue_id, label: data.label, qrToken: data.qr_token, active: data.active } : null;
    },
    async getVenueByTableToken(qrToken) {
      if (!qrToken) return null;
      const { data, error } = await client
        .from('venue_tables')
        .select(`id, label, active, training, venues(${VENUE_COLS})`)
        .eq('qr_token', qrToken)
        .eq('active', true)
        .maybeSingle();
      throwOn(error, 'getVenueByTableToken');
      if (!data || !data.venues) return null;
      return { venue: mapVenue(data.venues), table: { id: data.id, label: data.label, training: data.training === true } };
    },
    /**
     * Grava o recebedor (re_) criado no PSP — a partir daí o split roteia. opts
     * carrega o status inicial (ex.: 'registration') e os contatos do dono pro
     * aviso de KYC (e-mail + WhatsApp), capturados no mesmo form.
     */
    async setVenueRecipient(venueId, recipientId, opts = {}) {
      const patch = { psp_recipient_id: recipientId };
      if (opts.status !== undefined) patch.psp_recipient_status = opts.status;
      if (opts.notifyEmail !== undefined) patch.notify_email = opts.notifyEmail;
      if (opts.notifyWhatsapp !== undefined) patch.notify_whatsapp = opts.notifyWhatsapp;
      // O documento da casa, quando ela ainda não tinha: ver o comentário na
      // rota. Comprovante e liquidação passam a ser o mesmo documento.
      if (opts.cnpj !== undefined) patch.cnpj = opts.cnpj;
      const { data, error } = await client
        .from('venues')
        .update(patch)
        .eq('id', venueId)
        .select('id, psp_recipient_id')
        .single();
      throwOn(error, 'setVenueRecipient');
      return { id: data.id, pspRecipientId: data.psp_recipient_id };
    },
    /** Grava a conta conectada Stripe (acct_) do venue — rail de cartão/Apple Pay. */
    async setVenueStripeAccount(venueId, accountId) {
      const { data, error } = await client
        .from('venues')
        .update({ stripe_account_id: accountId })
        .eq('id', venueId)
        .select('id, stripe_account_id')
        .single();
      throwOn(error, 'setVenueStripeAccount');
      return { id: data.id, stripeAccountId: data.stripe_account_id };
    },
    /** Atualiza só o status do recebedor (o cron, ao detectar a transição KYC). */
    async setVenueRecipientStatus(venueId, status) {
      const { data, error } = await client
        .from('venues')
        .update({ psp_recipient_status: status })
        .eq('id', venueId)
        .select('id, psp_recipient_status')
        .single();
      throwOn(error, 'setVenueRecipientStatus');
      return { id: data.id, pspRecipientStatus: data.psp_recipient_status };
    },
    /**
     * Venues com recebedor ainda NÃO-terminal (segue no KYC) — o cron refetcha e
     * avisa na virada. Inclui registration, affiliation e afins; para de listar
     * só quando chega num terminal (active/refused/…), pra o dono ser avisado uma
     * vez e o venue sair da varredura.
     */
    async listVenuesPendingRecipient() {
      // Plataforma inteira, não uma casa: este é o cron que persegue recebedor
      // pendente, e uma casa que não cabe na primeira página nunca é perseguida.
      const data = await lerPaginado({
        op: 'listVenuesPendingRecipient',
        consulta: (de, ate) => client.from('venues').select(VENUE_COLS)
          .not('psp_recipient_status', 'is', null)
          .not('psp_recipient_status', 'in', `(${RECIPIENT_TERMINAL.join(',')})`)
          .order('id', { ascending: true }).range(de, ate),
      });
      return data.map(mapVenue);
    },
    /**
     * Números do funil de ativação, um registro por restaurante (RPC
     * venue_activation_stats — migração 0011). Datas viram epoch ms aqui, na
     * borda, porque o classificador (activation/radar.js) é puro e só fala
     * número: quem converte formato é o store, não a regra.
     */
    /**
     * Retenção (migração 0031). Anonimiza o que passou do prazo e devolve a
     * CONTAGEM por categoria — zero muitos dias seguidos é sinal de que parou
     * de rodar, não de que não havia o que apagar. Ver docs/compliance/retencao.md.
     */
    async purgeExpiredPersonalData(prazos = {}) {
      const { data, error } = await client.rpc('purge_expired_personal_data', {
        p_label_days: prazos.labelDays ?? 90,
        p_wallet_days: prazos.walletDays ?? 90,
        p_views_days: prazos.viewsDays ?? 90,
      });
      throwOn(error, 'purgeExpiredPersonalData');
      return {
        payerLabels: Number(data?.payer_labels ?? 0),
        payerHints: Number(data?.payer_hints ?? 0),
        houseAccounts: Number(data?.house_accounts ?? 0),
        checkViews: Number(data?.check_views ?? 0),
      };
    },

    /**
     * A ÚLTIMA execução da retenção — e é isto que torna "a ausência é o
     * alarme" verdadeiro. Sem este registro, cron parado e cron sem nada pra
     * apagar reportam a mesma coisa (zero), e a diferença só existia na cabeça
     * de quem lembrasse de conferir. Ver migração 0032.
     */
    async lastRetentionRun() {
      const { data, error } = await client
        .from('retention_runs')
        // Sem `kind` no select: o filtro já o fixa em 'purge' e nada lê de
        // volta — selecionar campo que ninguém usa é o que fez os dois stores
        // divergirem em forma sem ninguém notar.
        .select('at, payer_labels, payer_hints, house_accounts, check_views')
        .eq('kind', 'purge')
        .order('at', { ascending: false })
        .limit(1);
      throwOn(error, 'lastRetentionRun');
      const r = (data || [])[0];
      if (!r) return null;
      return {
        at: r.at,
        payerLabels: Number(r.payer_labels ?? 0),
        payerHints: Number(r.payer_hints ?? 0),
        houseAccounts: Number(r.house_accounts ?? 0),
        checkViews: Number(r.check_views ?? 0),
      };
    },

    /**
     * Pedido do titular (art. 18 IV): o nome livre de UM pagamento sai AGORA,
     * não no dia 90. Instrumento limitado no lugar de SQL ad-hoc com a service
     * role — ver migração 0031.
     */
    async erasePaymentLabel(txid) {
      const { data, error } = await client.rpc('erase_payment_label', { p_txid: txid });
      throwOn(error, 'erasePaymentLabel');
      return Number(data ?? 0);
    },

    async listVenueActivation() {
      const { data, error } = await client.rpc('venue_activation_stats');
      throwOn(error, 'listVenueActivation');
      const ms = (v) => (v ? Date.parse(v) : null);
      return (data || []).map((r) => ({
        id: r.id,
        name: r.name,
        isTest: r.is_test === true,
        recebedorOk: r.recebedor_ok === true,
        /**
         * O ID do recebedor, não só o booleano `recebedor_ok`.
         *
         * A terceira perna da conciliação compara os recebíveis do adquirente
         * contra ELE. Só o booleano chegava, então a perna rodava com
         * `undefined`: `payables_no_recipient` ALTO pra toda casa com cobrança
         * nas últimas 24h, toda noite, e `custody_leak` — o achado que responde
         * a pergunta de custódia do inegociável #4 — inalcançável. Uma chamada
         * de API por cobrança, paga pra não conferir nada.
         *
         * Meu teste inventava o campo num store escrito à mão, e o censo de
         * encanamento conferia os três parâmetros de que eu tinha lembrado.
         * Ver a migração 0027 e `store-shape.test.js`.
         * Achado pelas duas revisões de 2026-09-08.
         */
        pspRecipientId: r.psp_recipient_id || null,
        recipientStatus: r.psp_recipient_status || null,
        mesasReais: Number(r.mesas_reais) || 0,
        mesasTotal: Number(r.mesas_total) || 0,
        contas: Number(r.contas) || 0,
        pagosConfirmados: Number(r.pagos_confirmados) || 0,
        valorCents: Number(r.valor_cents) || 0,
        ultimoPagamentoMs: ms(r.ultimo_pagamento),
        criadoMs: ms(r.created_at),
      }));
    },
    async setHouseConfig(venueId, clean) {
      const patch = {};
      if ('enabled' in clean) patch.house_enabled = clean.enabled;
      if ('bonusBp' in clean) patch.house_bonus_bp = clean.bonusBp;
      if ('validityDays' in clean) patch.house_validity_days = clean.validityDays;
      if ('minLoadCents' in clean) patch.house_min_load_cents = clean.minLoadCents;
      if ('maxLoadCents' in clean) patch.house_max_load_cents = clean.maxLoadCents;
      const { data, error } = await client
        .from('venues')
        .update(patch)
        .eq('id', venueId)
        .select(VENUE_COLS)
        .single();
      throwOn(error, 'setHouseConfig');
      return mapVenue(data);
    },
    async createHouseAccount({ venueId, phone, name }) {
      const { data, error } = await client.rpc('house_open_account', {
        p_venue_id: venueId, p_phone: phone, p_name: name,
      });
      if (error) {
        // PELO CÓDIGO (23505 do índice único da 0005), não pela frase.
        try { throwOn(error, 'createHouseAccount'); } catch (e) {
          if (!unicidadeViolada(e)) throw e;
          const dup = new Error('duplicate house account'); dup.code = 'house_duplicate_account'; throw dup;
        }
      }
      return {
        id: data.id, venueId: data.venueId, phone: data.phone,
        name: data.name, accountToken: data.accountToken, createdAt: data.createdAt,
      };
    },
    async getHouseAccountByToken(token) {
      if (!token || typeof token !== 'string') return null;
      const { data, error } = await client
        .from('house_accounts')
        .select('id, venue_id, phone, name, account_token, created_at')
        .eq('account_token', token)
        .eq('active', true)
        .maybeSingle();
      throwOn(error, 'getHouseAccountByToken');
      return mapHouseAccount(data);
    },
    async getHouseAccountById(accountId) {
      if (!isUuid(accountId)) return null;
      const { data, error } = await client
        .from('house_accounts')
        .select('id, venue_id, phone, name, account_token, active, created_at')
        .eq('id', accountId)
        .maybeSingle();
      throwOn(error, 'getHouseAccountById');
      return mapHouseAccount(data);
    },
    async countHouseAccounts(venueId) {
      if (!isUuid(venueId)) return 0;
      const { count, error } = await client
        .from('house_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId);
      throwOn(error, 'countHouseAccounts');
      return count || 0;
    },
    async setHouseAccountActive(accountId, active) {
      if (!isUuid(accountId)) { const e = new Error('house_account_not_found'); e.statusCode = 404; e.code = 'house_account_not_found'; throw e; }
      const { data, error } = await client
        .from('house_accounts')
        .update({ active: !!active })
        .eq('id', accountId)
        .select('id, active')
        .maybeSingle();
      throwOn(error, 'setHouseAccountActive');
      if (!data) { const e = new Error('house_account_not_found'); e.statusCode = 404; e.code = 'house_account_not_found'; throw e; }
      return { id: data.id, active: data.active };
    },
    async loadHouseEvents(accountId) {
      if (!isUuid(accountId)) return [];
      // Pagina pelo mesmo motivo do `loadEvents`: razão cortado é saldo errado,
      // e aqui o saldo é dinheiro pré-pago do cliente.
      return lerPaginado({
        op: 'loadHouseEvents',
        consulta: (de, ate) => client.from('house_account_events')
          .select('seq, type, payload').eq('account_id', accountId)
          .order('seq', { ascending: true }).range(de, ate),
      });
    },
    async rotateHouseAccountToken(accountId) {
      if (!isUuid(accountId)) return null;
      const newToken = require('crypto').randomUUID().replace(/-/g, '');
      const { data, error } = await client
        .from('house_accounts')
        .update({ account_token: newToken })
        .eq('id', accountId)
        .select('id, account_token')
        .maybeSingle();
      throwOn(error, 'rotateHouseAccountToken');
      return data ? { id: data.id, accountToken: data.account_token } : null;
    },
    async listHouseAccounts(venueId) {
      if (!isUuid(venueId)) return [];
      // `MAX_ACCOUNTS_PER_VENUE` é 5000: o teto do PostgREST é alcançável POR
      // DESENHO. `created_at` não é ordem total (duas contas no mesmo
      // milissegundo), então o `id` desempata.
      const data = await lerPaginado({
        op: 'listHouseAccounts',
        consulta: (de, ate) => client.from('house_accounts')
          .select('id, venue_id, phone, name, account_token, created_at')
          .eq('venue_id', venueId)
          .order('created_at', { ascending: true }).order('id', { ascending: true })
          .range(de, ate),
      });
      return data.map(mapHouseAccount);
    },
    async registerHouseLoad({ accountId, txid, amountCents, bonusCents, validityDays }) {
      const { error } = await client.from('house_loads').insert({
        txid, account_id: accountId, amount_cents: amountCents,
        bonus_cents: bonusCents, validity_days: validityDays,
      });
      throwOn(error, 'registerHouseLoad');
    },
    async findHouseLoadByTxid(txid) {
      if (!txid) return null;
      const { data, error } = await client
        .from('house_loads')
        .select('txid, account_id, amount_cents, bonus_cents, validity_days, status')
        .eq('txid', txid)
        .maybeSingle();
      throwOn(error, 'findHouseLoadByTxid');
      if (!data) return null;
      return {
        txid: data.txid, accountId: data.account_id,
        amountCents: Number(data.amount_cents), bonusCents: Number(data.bonus_cents),
        validityDays: data.validity_days, status: data.status,
      };
    },
    async confirmHouseLoad({ txid, confirmedAt }) {
      const { data, error } = await client.rpc('house_confirm_load', {
        p_txid: txid, p_confirmed_at: confirmedAt,
      });
      throwOn(error, 'confirmHouseLoad');
      return { accountId: data.accountId, seq: data.seq, duplicate: data.duplicate === true };
    },
    async redeemHouse({ accountId, checkId, txid, amountCents, nowIso }) {
      const { data, error } = await client.rpc('house_redeem', {
        p_account_id: accountId, p_check_id: checkId, p_txid: txid,
        p_amount_cents: amountCents, p_now: nowIso,
      });
      throwDaCarteira(error, 'redeemHouse');
      return {
        seq: data.seq, duplicate: data.duplicate === true,
        principalUsedCents: Number(data.principalUsedCents),
        bonusUsedCents: Number(data.bonusUsedCents),
      };
    },
    async reverseHouseRedeem({ accountId, txid, nowIso }) {
      const { data, error } = await client.rpc('house_redeem_reverse', {
        p_account_id: accountId, p_txid: txid, p_now: nowIso,
      });
      throwOn(error, 'reverseHouseRedeem');
      return { duplicate: data.duplicate === true, seq: data.seq };
    },
    async appendHousePaymentGuarded(checkId, txid, amountCents) {
      const { data, error } = await client.rpc('append_house_payment_guarded', {
        p_check_id: checkId, p_txid: txid, p_amount_cents: amountCents,
      });
      throwDaCarteira(error, 'appendHousePaymentGuarded');
      return data;
    },
    async refundHousePrincipal({ accountId, amountCents, nowIso }) {
      const { data, error } = await client.rpc('house_refund_principal', {
        p_account_id: accountId, p_amount_cents: amountCents, p_now: nowIso,
      });
      throwDaCarteira(error, 'refundHousePrincipal');
      return { seq: data.seq, principalCents: Number(data.principalCents) };
    },
    async recordHousePaymentRow({ checkId, venueId, txid, amountCents, confirmedAt }) {
      // Idempotent by txid: a healed retry re-attempts this write; an
      // existing row is left untouched (never silently rewritten).
      const { error } = await client.from('payments').upsert({
        check_id: checkId, venue_id: venueId, txid,
        method: 'house_account', amount_cents: amountCents, tip_cents: 0,
        status: 'confirmado', confirmed_at: confirmedAt,
      }, { onConflict: 'txid', ignoreDuplicates: true });
      throwOn(error, 'recordHousePaymentRow');
    },
    async listHouseAccountsForReconcile(venueId) {
      // PAGINA, como a lista de contas acima — e aqui o teto é alcançável POR
      // DESENHO: `MAX_ACCOUNTS_PER_VENUE` é 5000 (`house-service.js`), cinco
      // vezes o corte do PostgREST. Ver o bloco em `listChecksForReconcile`.
      const accounts = await lerPaginado({
        op: 'listHouseAccountsForReconcile',
        consulta: (de, ate) => client.from('house_accounts').select('id, principal_cents')
          .eq('venue_id', venueId).order('id', { ascending: true }).range(de, ate),
      });
      const out = [];
      // POR LOTE. Eram DUAS idas por conta da casa — os lotes de bônus e o
      // razão —, em série, dentro da conciliação diária. Mesmo motivo do
      // `listChecksForReconcile` logo acima.
      const ids = (accounts || []).map((a) => a.id).filter(isUuid);
      const [lotesPorConta, razoes] = await Promise.all([
        lerPorLote({
          tabela: 'house_bonus_lots',
          colunas: 'account_id, event_seq, remaining_cents, expires_at',
          coluna: 'account_id',
          ids,
          ordem: ['account_id', 'event_seq'],
          op: 'listHouseAccountsForReconcile.lots',
        }),
        lerPorLote({
          tabela: 'house_account_events',
          colunas: 'account_id, seq, type, payload',
          coluna: 'account_id',
          ids,
          ordem: ['account_id', 'seq'],
          op: 'listHouseAccountsForReconcile.events',
        }),
      ]);
      for (const a of accounts || []) {
        const lots = lotesPorConta.get(a.id) || [];
        out.push({
          accountId: a.id,
          events: razoes.get(a.id) || [],
          stored: {
            principalCents: Number(a.principal_cents),
            lots: (lots || []).map((l) => ({
              seq: l.event_seq,
              remainingCents: Number(l.remaining_cents),
              expiresAt: l.expires_at,
            })),
          },
        });
      }
      return out;
    },

    // --- panel --------------------------------------------------------------
    async getPanelView(venueId, nowIso = new Date().toISOString()) {
      // `market` no SELECT, e não só no objeto de saída.
      //
      // A correção da moeda do painel foi metade da correção: eu acrescentei
      // `currency: market(venue.market).currency` na saída e NÃO acrescentei
      // `market` no select. Em memória o objeto tem o campo, então `npx jest`
      // ficou verde; em produção `venue.market` chega `undefined`, `market()`
      // cai no Brasil, e o painel de uma casa espanhola volta a dizer "R$" —
      // exatamente o bug que o commit dizia fechar, inclusive na linha de
      // GORJETA, que é o número que o dono leva pra folha.
      //
      // É a MESMA armadilha anotada duzentas linhas acima neste arquivo, na
      // leitura da conta: "sem ele a coluna chega undefined e a conta cai no
      // default brasileiro". Achado pela revisão de segurança.
      const { data: venue, error: vErr } = await client
        .from('venues').select('id, name, market').eq('id', venueId).maybeSingle();
      throwOn(vErr, 'getPanelView.venue');
      if (!venue) return null;

      /**
       * A JANELA DE PAGAMENTOS SOBE, porque a lista de contas depende dela.
       *
       * O terceiro conjunto de contas ("as que receberam dinheiro na janela")
       * sai dos `check_id` desta leitura, entao ela precisa acontecer antes.
       * As mesas de TREINO sobem junto: e o filtro delas que decide o que
       * conta como dinheiro de verdade.
       */
      // A MESA DE TREINO NÃO SAI MAIS DOS NÚMEROS. Ela saía — pagamentos,
      // serviço (a base da folha) e sobra —, e nenhum caminho de pagamento a
      // recusava: dinheiro real que o dono não via. Agora ela não cobra
      // (`mesa-de-treino.js`), e todo dinheiro que o painel encontra é dinheiro
      // de verdade e conta, inclusive o de antes, pago numa mesa que depois foi
      // marcada como treino.

      /**
       * A janela de 7 DIAS, e o `today` recortado do dia de verdade.
       *
       * A consulta não tinha predicado de data nenhum, e o resultado saía sob
       * o rótulo "recebido hoje" e "serviço da equipe (folha)". Um dono que
       * leia aquela linha como a gorjeta do dia e distribua está distribuindo o
       * acumulado da VIDA da casa — base de folha (Lei 13.419) lida de um
       * agregado com rótulo errado. Achado pela revisão de compliance de
       * 2026-09-08.
       *
       * A série semanal precisa de 7 dias, então a consulta busca 8 (folga de
       * fuso) e o `today` filtra o dia em São Paulo — o mesmo corte do
       * `buildAtivacao`, pra as duas linhas do painel nunca discordarem.
       */
      const desde = new Date(Date.parse(nowIso) - 8 * 86400000).toISOString();
      /**
       * A LEITURA QUE VIRA O NÚMERO DA FOLHA — e ela não paginava.
       *
       * Daqui saem `today.tipsCents` (o "serviço da equipe" que o dono leva
       * pra folha, Lei 13.419 e inegociável #2) e o faturamento do dia. Sem
       * `range`, mil pagamentos confirmados na janela de oito dias — cerca de
       * 125 por dia, uma casa de quarenta mesas rachando em três — faziam o
       * PostgREST devolver mil com um 200, e a gorjeta chegava CURTA na tela.
       * Sem `order`, quais mil chegam é escolha do planejador: o número podia
       * mudar entre duas recargas de quatro segundos sem nada acontecer.
       *
       * E a conciliação NÃO enxergava: `listChecksForReconcile` pagina certo,
       * então o canário noturno ficava verde enquanto a tela do dono estava
       * errada — o sucesso silencioso que o inegociável #8 existe pra proibir.
       * Achado pela revisão de segurança de 2026-09-16 (HIGH-1).
       */
      const confirmedRaw = await lerPaginado({
        op: 'getPanelView.payments',
        consulta: (de, ate) => client
          .from('payments')
          // `txid` é a CHAVE do mapa de sobras que o `buildAtivacao` usa. Sem
          // ele, `sobraDe()` devolvia 0 pra toda linha e a série semanal seguia
          // contando dívida (CC art. 876) como receita — a correção existia e não
          // rodava. É a mesma armadilha documentada 120 linhas acima, onde eu
          // acrescentei `currency` ao mapeador e não ao select.
          .select('txid, amount_cents, tip_cents, confirmed_amount_cents, confirmed_tip_cents, refunded_amount_cents, refunded_tip_cents, check_id, confirmed_at, method')
          .eq('venue_id', venueId)
          .eq('status', 'confirmado')
          .gte('confirmed_at', desde)
          // A ORDEM SEGUE O FILTRO, não o contrário.
          //
          // `txid` sozinho é ordem total (é único desde a 0001) e serviria pra
          // paginar — mas filtrar por `(venue_id, status, confirmed_at)` e
          // ordenar por `txid` obriga o Postgres a ORDENAR todas as linhas que
          // casam antes de cortar a página, e a repetir isso a cada página.
          // Ordenando pelo próprio `confirmed_at` (com o `txid` desempatando,
          // que é o que mantém a ordem total), o mesmo índice que serve o
          // filtro serve a ordem, e a página sai por varredura.
          .order('confirmed_at', { ascending: true })
          .order('txid', { ascending: true })
          .range(de, ate),
      });

      /**
       * AS CONTAS QUE O PAINEL PRECISA — e só elas.
       *
       * Paginar esta leitura consertou o número (antes ela era cortada em mil
       * e o painel parava de listar as mesas de HOJE, porque `opened_at` é
       * ascendente). Mas trocou "silenciosamente errado" por "sem teto": o
       * painel passou a ler TODA conta que a casa já teve, e o
       * `loadEventsPorLote` logo abaixo a ler TODO evento de cada uma — a cada
       * volta do laço do painel. Numa casa com 120 contas/dia isso são dez mil
       * contas em três meses, e dezenas de idas por carga até a função morrer
       * no `maxDuration`. A troca foi na direção certa (o #8 prefere a tela
       * parar a mostrar número errado), mas é um precipício com data marcada.
       * Achado pelas duas revisões de 2026-09-16 (compliance MEDIUM-C,
       * segurança NEW-3).
       *
       * O recorte NÃO pode ser uma janela de data seca: uma conta ABERTA de
       * qualquer idade tem que aparecer, e uma obrigação de restituição
       * (CC art. 876) não vence com o tempo. Então são três conjuntos:
       *
       *  1. **As abertas, de qualquer idade.** Provadamente pequeno: a 0004
       *     mantém `status='fechada'` DENTRO do portão de append, e o índice
       *     `checks_one_open_per_table` é único sobre `status <> 'fechada'` —
       *     no máximo uma aberta POR MESA.
       *  2. **As da janela**, pelo `opened_at`: o que o dono espera ver.
       *  3. **As que receberam dinheiro na janela**, mesmo velhas e fechadas —
       *     é delas que sai o `sobraPorTxid` que desconta dívida do faturamento
       *     da série semanal. Sem este terceiro conjunto, a série voltaria a
       *     contar como receita uma dívida (o defeito de a95e15c).
       *
       * O que sai da lista: conta fechada, velha e sem movimento na janela. Se
       * ela tiver obrigação pendente, ela continua aparecendo — pelos ACHADOS
       * da conciliação, que varre a casa inteira e grita `critical` depois de
       * 48 h. O canal alto continua alto.
       */
      const COLUNAS_DA_CONTA = 'id, table_id, opened_at, venue_tables(label)';
      /**
       * Buscar contas POR ID, mas SEMPRE dentro desta casa.
       *
       * Os conjuntos 3 e 4 partem de ids achados noutra tabela (`payments`,
       * `check_events`). O `lerPorLote` não tem filtro, então uma busca por id
       * puro tomaria o inquilino por herança em vez de re-derivá-lo — e o
       * `select` puxa `venue_tables(label)`, então uma divergência desenharia a
       * mesa, os totais e a dívida de OUTRA casa no painel deste dono. É o único
       * lugar do recorte onde o id não vem de uma consulta já filtrada por
       * `venue_id`, e é por isso que o `.eq('venue_id')` está aqui.
       * Apontado pela terceira revisão de segurança de 2026-09-16 (L3).
       */
      const contasDaCasaPorId = async (ids, op) => {
        const limpos = [...new Set(ids)].filter(isUuid);
        if (limpos.length === 0) return [];
        const fora = [];
        for (let i = 0; i < limpos.length; i += IDS_POR_LOTE) {
          const lote = limpos.slice(i, i + IDS_POR_LOTE);
          fora.push(...await lerPaginado({
            op,
            consulta: (de, ate) => client.from('checks').select(COLUNAS_DA_CONTA)
              .eq('venue_id', venueId).in('id', lote)
              .order('id', { ascending: true }).range(de, ate),
          }));
        }
        return fora;
      };

      const [abertas, daJanela] = await Promise.all([
        lerPaginado({
          op: 'getPanelView.checks.abertas',
          consulta: (de, ate) => client.from('checks').select(COLUNAS_DA_CONTA)
            .eq('venue_id', venueId).neq('status', 'fechada')
            .order('id', { ascending: true }).range(de, ate),
        }),
        lerPaginado({
          op: 'getPanelView.checks.janela',
          consulta: (de, ate) => client.from('checks').select(COLUNAS_DA_CONTA)
            .eq('venue_id', venueId).gte('opened_at', desde)
            .order('opened_at', { ascending: true }).order('id', { ascending: true })
            .range(de, ate),
        }),
      ]);
      const jaTenho = new Set([...abertas, ...daJanela].map((c) => c.id));

      /**
       * O QUARTO CONJUNTO: as contas com DISPUTA na janela.
       *
       * Uma disputa não toca `confirmed_at` nem `status` da conta — ela é um
       * evento no razão, e chega semanas depois do pagamento (o cartão tem 120
       * dias). Então a conta disputada é sempre velha e fechada, e caía FORA dos
       * três conjuntos: o quadro de chargebacks do painel ficava vazio por
       * construção, justo pro caso em que há dinheiro saindo.
       *
       * E o canal alto NÃO cobria: a conciliação só emite `dispute_evidence_due`
       * numa faixa de sete dias antes do prazo, e uma disputa PERDIDA não gera
       * achado `dispute_*` nenhum — só o dinheiro vai embora. Achado pela
       * terceira revisão de segurança de 2026-09-16 (M3).
       *
       * A leitura de `check_events` não tem `venue_id` (a tabela não tem a
       * coluna), então ela varre a janela e o filtro de casa é aplicado na busca
       * das contas, acima. Disputa é rara — são poucas linhas em oito dias.
       */
      const eventosDeDisputa = await lerPaginado({
        op: 'getPanelView.checks.disputa',
        consulta: (de, ate) => client.from('check_events').select('check_id')
          .in('type', ['PAYMENT_DISPUTED', 'PAYMENT_DISPUTE_CLOSED'])
          .gte('created_at', desde)
          .order('check_id', { ascending: true }).order('seq', { ascending: true })
          .range(de, ate),
      });

      // Só o que AINDA NÃO TENHO vai pro banco de novo: numa casa normal quase
      // todo pagamento da janela é de uma conta que o conjunto 2 já trouxe, e
      // buscá-las outra vez eram idas a mais em toda carga do painel (L4).
      const [comDinheiro, comDisputa] = await Promise.all([
        contasDaCasaPorId(
          (confirmedRaw || []).map((p) => p.check_id).filter((id) => !jaTenho.has(id)),
          'getPanelView.checks.comDinheiro',
        ),
        contasDaCasaPorId(
          eventosDeDisputa.map((e) => e.check_id).filter((id) => !jaTenho.has(id)),
          'getPanelView.checks.comDisputa',
        ),
      ]);

      const porId = new Map();
      for (const c of [...abertas, ...daJanela, ...comDinheiro, ...comDisputa]) porId.set(c.id, c);
      // ORDEM CRONOLÓGICA, como era antes do recorte: a união dos conjuntos sai
      // na ordem em que eles foram lidos, e o painel desenha `data.checks` sem
      // ordenar — a lista de mesas do dono tinha virado uma ordem arbitrária.
      const checks = [...porId.values()]
        .sort((a, b) => String(a.opened_at || '').localeCompare(String(b.opened_at || '')) || a.id.localeCompare(b.id));

      const rows = [];
      /**
       * txid → quanto daquele pagamento entrou a MAIS e ainda falta restituir.
       *
       * Sai daqui porque é aqui que os eventos são reduzidos: o excedente vive
       * no RAZÃO, e `payments` não tem coluna pra ele. Serve pra série semanal
       * não contar dívida como receita (CC art. 876) — o widget do dia já
       * descontava, e a série ao lado dele não.
       */
      const sobraPorTxid = new Map();
      // POR LOTE: era uma leitura do razão POR CONTA ABERTA, em série, e o
      // painel do dono recarrega a cada 4 s. Ver `loadEventsPorLote`.
      const razoes = await loadEventsPorLote((checks || []).map((c) => c.id));
      for (const c of checks || []) {
        const state = reduce(razoes.get(c.id) || []);
        // SEM `OPENED`, a conta não entra no painel — e não o derruba. Era
        // `state.status` num `null`: uma conta órfã deixava o painel INTEIRO
        // da casa em 500 a cada recarga de 4 s (segurança, quarta rodada, H-1).
        // Fora da janela normal, o alarme. Ver `conta-sem-opened.js`.
        if (!state) {
          const { idadeMs, orfa } = idadeSemOpened(c.opened_at, Date.parse(nowIso));
          if (orfa) process.stderr.write(linhaDeAlarme(c.id, idadeMs, 'getPanelView'));
          continue;
        }
        // PELA REGRA ÚNICA: este mapa desconta a dívida do FATURAMENTO da série
        // semanal (ver `ativacao.js`), e lido do excedente congelado ele era
        // cego justamente na sobra que nasce de uma reversão — a série contava
        // como receita a mesma quantia que a linha ao lado chamava de dívida
        // (CC art. 876; segurança HIGH-1 de a95e15c).
        acumularSobra(state, sobraPorTxid);
        rows.push({
          checkId: c.id,
          tableLabel: c.venue_tables ? c.venue_tables.label : '?',
          state: {
            status: state.status,
            totalCents: state.totalCents,
            paidCents: state.paidCents,
            tipCents: state.tipCents,
            anomalies: state.anomalies.length,
            // A SOBRA a devolver, por conta. O redutor já a calculava e o
            // número morria ali: nenhum painel, nenhuma tela. Ver
            // `overpaid_pending_restitution` na conciliação.
            overpaidCents: state.overpaidCents,
            // PAGO DEPOIS DE FECHAR, na parte que a sobra não cobre — ver `paidAfterClose`. A equipe
            // confere com a mesa se ela também pagou no caixa. (Compliance HIGH-1.)
            paidAfterClose: paidAfterClose(state),
            /**
             * QUAL cobrança devolver — o painel não podia dizer.
             *
             * O dono lia "R$ 90,00 a devolver a clientes" e tinha que adivinhar
             * qual cobrança abrir no painel do adquirente. Uma obrigação que a
             * tela anuncia e não sabe endereçar não é acionável (CC art. 876:
             * a restituição não espera o cliente pedir). O txid é do LADO DO
             * DONO, atrás de auth — a leitura pública segue com ordinal.
             */
            /**
             * QUAL cobrança devolver, e QUANTO.
             *
             * A primeira versão filtrava "tem consumo devolvível" e reportava
             * o saldo devolvível INTEIRO — então numa conta rachada listava as
             * cobranças de quem pagou exato, com o valor cheio do pagamento. O
             * runbook manda o operador devolver "o valor que o painel indica":
             * seguido à letra, ele estornava o pagador errado, ou estornava um
             * pagamento inteiro e reabria uma conta quitada (a mesa cobrada de
             * novo, CDC art. 42). Achado pela revisão de compliance de
             * 2026-09-08.
             *
             * Agora: só quem TEM excedente, e o valor é o que falta restituir
             * daquele pagamento. Fica do lado do dono, atrás de auth — a
             * leitura pública segue com ordinal.
             */
            ...(state.overpaidCents > 0 ? {
              // PELA REGRA ÚNICA do redutor: o excedente cru é zero na
              // duplicidade que nasce depois, e o painel mostrava "a devolver"
              // sem nenhuma cobrança embaixo — com o runbook mandando devolver
              // "pelo valor ao lado da cobrança" (compliance HIGH-1 de 089e8a2).
              overpaidTxids: linhasDeSobra(state),
            } : {}),
            // Disputas por CONTAGEM: é a taxa de chargeback que o
            // adquirente julga, e o dono não tinha como ver a dele.
            disputes: disputeCounts(state),
          },
        });
      }

      const confirmed = (confirmedRaw || [])
        .map((p) => ({
          txid: p.txid,
          amountCents: p.amount_cents, tipCents: p.tip_cents,
          confirmedAmountCents: p.confirmed_amount_cents,
          confirmedTipCents: p.confirmed_tip_cents,
          refundedAmountCents: p.refunded_amount_cents || 0,
          refundedTipCents: p.refunded_tip_cents || 0,
          checkId: p.check_id, confirmedAt: p.confirmed_at, method: p.method,
        }));

      /**
       * HOJE, no fuso de São Paulo — o mesmo corte da série semanal.
       *
       * `confirmed` cobre a janela inteira porque o `buildAtivacao` precisa
       * dela; o `today` é o recorte do dia. Sem isto a linha rotulada
       * "recebido hoje" somava tudo o que a casa já recebeu, e é dessa linha
       * que sai o número da gorjeta que vai pra folha.
       */
      // O INSTANTE vem de fora, com padrão de agora.
      //
      // Uma função que agrupa por dia tem que receber o dia: com o relógio
      // lido de dentro, um teste de relógio fixo não conseguia ver o próprio
      // pagamento — e o mesmo vale pra qualquer reprocessamento de um dia
      // passado. O `buildAtivacao` já era assim.
      const hoje = spDay(nowIso);
      const doDia = confirmed.filter((p) => p.confirmedAt && spDay(p.confirmedAt) === hoje);
      /**
       * A sobra do DIA, não a da vida da casa.
       *
       * `overpaidTotal` não tinha limite de data e era subtraída do
       * faturamento de HOJE: uma dívida de 90,00 de três semanas atrás baixava
       * a receita todo dia, e num dia fraco levava o número pra negativo. A
       * dívida acumulada continua aparecendo na conciliação, que é onde ela
       * pertence — o widget do dia fala do dia.
       */
      const contasDoDia = new Set(doDia.map((p) => p.checkId));
      const overpaidTotal = rows
        .filter((r) => contasDoDia.has(r.checkId))
        .reduce((s, r) => s + (r.state.overpaidCents || 0), 0);

      return {
        // A MOEDA vai no payload do painel porque o painel imprime dinheiro, e
        // o cliente não deve adivinhar. Sem ela, `brl()` caía no padrão BRL e o
        // dono de uma casa espanhola lia "R$" no faturamento do dia e na linha
        // de GORJETA — que é o número que ele leva pra folha. Achado da revisão
        // de compliance de 2026-09-07.
        venue: { name: venue.name, currency: market(venue.market).currency },
        checks: rows,
        today: {
          // O CONFIRMADO, com o registrado como reserva pra histórico anterior
          // à coluna. Somava o PEDIDO, então numa divergência o dono lia
          // faturamento e GORJETA errados — e a gorjeta é a base da folha
          // (Lei 13.419). Ver `confirmed-money.js` e a migração 0015.
          //
          // MENOS a sobra a devolver: dinheiro que o cliente pagou a mais é
          // dívida da casa (CC art. 876), não receita dela. Estava indo
          // direto pro faturamento — e, no dia em que houver margem sobre
          // volume, a gente cobraria margem em cima da dívida também.
          confirmedCents: doDia.reduce((s, p) => s + confirmedMoney(p).amountCents, 0)
            - overpaidTotal,
          /** A dívida, na sua própria linha — visível, não subtraída em silêncio. */
          overpaidCents: overpaidTotal,
          tipsCents: doDia.reduce((s, p) => s + confirmedMoney(p).tipCents, 0),
          /**
           * Serviço COBRADO vs ARRECADADO — o contrapeso da regra de imputação.
           *
           * Num Pix pago a menor o serviço é o resíduo (ver
           * `allocateUnderpayment`): quem digita menos está recusando a linha
           * opcional, não devendo comida. Essa regra favorece sistematicamente
           * a casa na linha da gorjeta, então a diferença tem que ser VISÍVEL —
           * uma diferença que aparece é um fato do negócio; a mesma diferença
           * escondida é uma reclamação trabalhista.
           */
          /**
           * Cobrado vs ARRECADADO — e o estorno de fora dos dois.
           *
           * `tipsCents` é líquido de estorno (via `confirmedMoney`), e
           * `tipsChargedCents` era o bruto pedido: depois de qualquer estorno
           * parcial o painel dizia "R$ 5,50 de R$ 10,00 cobrados" quando a
           * diferença era um ESTORNO, não um cliente arredondando pra baixo.
           * Dois fatos do negócio diferentes debaixo da mesma legenda.
           *
           * Agora `tipsChargedCents` também é líquido do estornado: a diferença
           * que sobra é só a arrecadação a menor, que é o que a regra de
           * imputação produz e o que a folha precisa ver.
           */
          /**
           * O serviço COBRADO (bruto), o ARRECADADO (`tipsCents`, líquido) e o
           * ESTORNADO, em três linhas.
           *
           * Tentei resolver a confusão "estorno parecendo arrecadação a menor"
           * descontando o estorno também do cobrado — e aí os dois lados caíam
           * junto e a diferença DESAPARECIA. Ou seja: uma restituição que
           * raspasse a gorjeta ficava invisível justo no contrapeso que existe
           * pra mostrar isso. Três números não se confundem; dois com o mesmo
           * desconto se anulam. Achado pela revisão de compliance de
           * 2026-09-08.
           */
          tipsChargedCents: doDia.reduce((s, p) => s + (p.tipCents || 0), 0),
          tipsRefundedCents: doDia.reduce((s, p) => s + (p.refundedTipCents || 0), 0),
          paymentsCount: doDia.length,
          anomalies: rows.reduce((s, r) => s + r.state.anomalies, 0),
        },
        ativacao: buildAtivacao(confirmed, nowIso, sobraPorTxid),
      };
    },
  };
}

module.exports = { createSupabaseStore };
