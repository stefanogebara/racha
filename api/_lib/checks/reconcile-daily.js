'use strict';

/**
 * A varredura diária de conciliação — a promessa #8 do CLAUDE.md, finalmente
 * com quem a dispare.
 *
 * O canário (`reconcile.js`) já existia e já era testado, mas só rodava dentro
 * de `GET /api/house/admin`: quer dizer, só se o dono de um restaurante que usa
 * conta-corrente pré-paga abrisse aquela página específica. Um restaurante que
 * nunca usou saldo, ou um dono que nunca abriu aquela tela, não tinha
 * conciliação nenhuma — e o resultado, quando rodava, voltava pro front e não
 * era exibido. "Concilia desde o dia 1" não pode depender de alguém clicar.
 *
 * Este módulo varre TODOS os restaurantes, roda os dois canários por
 * restaurante e devolve um relatório ranqueado. É TOTAL: um restaurante que
 * exploda vira um achado `critical` e a varredura continua — uma casa com dado
 * ruim não pode cegar as outras trinta.
 *
 * O que ele NÃO faz: consertar. Conciliação que corrige sozinha esconde a causa
 * raiz; aqui ela grita e um humano decide.
 *
 * O que ele AINDA NÃO faz, e a #8 pede: comparar com o EXTRATO DO PSP. Hoje os
 * dois canários cruzam dois registros NOSSOS (log de eventos × tabela de
 * pagamentos), escritos pelo mesmo webhook — divergência do lado do PSP (valor
 * liquidado, roteamento do split, gorjeta) é invisível aqui. A terceira perna
 * (listar liquidações do PSP no período e bater txid a txid) é a próxima
 * entrega desta promessa; até lá, a promessa está escrita com o tamanho que o
 * código tem, e não maior.
 */

const { reconcileVenue, reconcileVenueHouse, resumoDoReparo } = require('./reconcile');
const { reconcilePayables } = require('./reconcile-payables');

const RANK = { ok: 0, info: 1, high: 2, critical: 3 };
const LEVELS = ['ok', 'info', 'high', 'critical'];

/** O pior de dois níveis, por nome. */
function worse(a, b) {
  return LEVELS[Math.max(RANK[a] || 0, RANK[b] || 0)];
}

/**
 * Concilia um restaurante: contas + contas-correntes.
 * Nunca lança — a falha vira achado.
 * @returns {{venueId, name, severity, driftCents, findings: Array, checksChecked, accountsChecked}}
 */
/**
 * A TERCEIRA PERNA, por restaurante: os recebíveis do adquirente.
 *
 * Melhor esforço e limitada: cada cobrança custa uma chamada de API, então a
 * varredura pega uma janela e um teto. Falha de rede não é achado de dinheiro —
 * ela vira um `info` que diz que não deu pra conferir, porque silêncio não pode
 * passar por prova.
 *
 * `psp` e `store` opcionais mantêm o resto da varredura funcionando onde a
 * perna não existe (mock, memória, um adquirente sem recebíveis).
 */
async function reconcilePayablesLeg(store, psp, venue, opts = {}) {
  const { sinceIso, limit = 25 } = opts;
  /**
   * DESLIGADA é um ACHADO, não um silêncio.
   *
   * Com `RACHA_PAYABLES_LEG=off` a rota não passa o `psp`, e isto devolvia
   * `[]`: o relatório noturno saía idêntico a uma noite saudável —
   * `worstSeverity: 'ok'`, `venuesRed: 0`, o alerta nem sai — e o
   * `custody_leak`, que é o achado que responde a pergunta de custódia do
   * inegociável #4, simplesmente não existia. É o estado em que alguém entra
   * às 2h de uma madrugada e nunca mais sai.
   *
   * O commit 4930caa fez a coisa certa com o irmão deste caso: `CRON_SECRET`
   * ausente PAGINA em vez de desligar em silêncio. Um interruptor de controle
   * de custódia merece o mesmo. Achado pela revisão de segurança de
   * 2026-09-09.
   */
  if (opts.legDisabled === true) {
    return [{
      severity: 'high',
      code: 'payables_leg_disabled',
      message: 'a conferência de destino do dinheiro (recebíveis do adquirente) está DESLIGADA por configuração',
    }];
  }
  // Ausência de PSP por outro motivo — um chamador que não tem adquirente
  // (store de memória, conciliação só de carteira) — é silêncio legítimo: não
  // houve decisão de desligar nada.
  if (!psp || typeof psp.listChargePayables !== 'function') return [];
  if (typeof store.listRecentConfirmedCharges !== 'function') return [];
  const recebedor = venue.pspRecipientId || null;
  let cobrancas;
  try {
    cobrancas = await store.listRecentConfirmedCharges(venue.id, { sinceIso, limit });
  } catch (e) {
    return [{
      severity: 'info', code: 'payables_unchecked',
      message: `não deu pra listar as cobranças pra conferir recebíveis: ${String(e.message).slice(0, 120)}`,
    }];
  }
  const achados = [];
  /**
   * ORÇAMENTO DE TEMPO, porque isto é I/O externo dentro do cron.
   *
   * O laço é serial e cada volta é uma chamada com timeout de 15s. Trinta casas
   * × 25 cobranças são até 750 requisições em sequência — e a plataforma mata a
   * função muito antes, o que produz NENHUM relatório e NENHUM alerta. O commit
   * anterior a esta série teve trabalho pra fazer um segredo ausente PAGINAR em
   * vez de emudecer; isto reabria o caminho silencioso pela porta da frente.
   *
   * Estourado o orçamento, as cobranças que sobraram viram um achado que diz
   * quantas ficaram sem conferir. Achado pela revisão de segurança de
   * 2026-09-08.
   */
  /**
   * O orçamento é da VARREDURA INTEIRA, não de cada casa.
   *
   * Era por casa e conferido ENTRE chamadas: dez casas × 20s de orçamento mais
   * uma chamada de 15s já em vôo passava dos 300s do padrão da plataforma — e
   * uma função morta não resolve a promessa, então o `catch` da rota nunca
   * roda e o alerta noturno não sai NEM como falha. A ausência da batida vira
   * o único sinal, que é a forma silenciosa que o inegociável #8 proíbe.
   *
   * `opts.deadline` é um instante absoluto que a varredura passa adiante, e
   * `maxDuration` está declarado no `vercel.json` em vez de herdado de um
   * padrão que já mudou duas vezes.
   * Achado pela revisão de segurança de 2026-09-09.
   */
  const inicio = Date.now();
  const orcamentoMs = Number.isSafeInteger(opts.budgetMs) ? opts.budgetMs : 20_000;
  const prazoFinal = Number.isSafeInteger(opts.deadline) ? opts.deadline : Infinity;
  let conferidas = 0;
  let verificadas = 0;
  for (const [i, c] of cobrancas.entries()) {
    if (Date.now() - inicio > orcamentoMs || Date.now() > prazoFinal) {
      achados.push({
        severity: 'info', code: 'payables_unchecked',
        message: `orçamento de tempo estourado: ${cobrancas.length - i} cobrança(s) sem conferir`,
        unchecked: cobrancas.length - i,
      });
      break;
    }
    conferidas += 1;
    try {
      const payables = await psp.listChargePayables(c.txid);
      const r = reconcilePayables({
        chargeId: c.txid,
        venueRecipientId: recebedor,
        paidAmountCents: c.paidAmountCents,
        payables,
      });
      // "Conferiu" é ter recebível pra olhar. Sem isso, a perna passou por ali
      // e não afirmou nada.
      if (payables.length > 0) verificadas += 1;
      achados.push(...r.findings);
    } catch (e) {
      achados.push({
        severity: 'info', code: 'payables_unchecked', chargeId: c.txid,
        message: `recebíveis de ${c.txid} não consultados: ${String(e.message).slice(0, 120)}`,
      });
    }
  }
  /**
   * A TESTEMUNHA AGREGADA da própria perna.
   *
   * `payables_absent` e `payables_unchecked` são `info` um por um — e devem
   * ser, porque o recebível nasce depois da liquidação e um 502 do adquirente
   * não é achado de dinheiro. Mas isso fazia "a perna verificou tudo" e "a
   * perna não verificou NADA a noite inteira" saírem no mesmo relatório verde.
   *
   * É a mesma forma do serviço nunca arrecadado: o que distingue não é o caso
   * isolado, é o agregado. Achado pela revisão de segurança de 2026-09-08.
   */
  if (conferidas >= 5 && verificadas === 0) {
    achados.push({
      severity: 'high',
      code: 'payables_never_verified',
      message: `${conferidas} cobranças consideradas e nenhuma verificada — a conferência de destino não está funcionando`,
      considered: conferidas,
    });
  }
  return achados;
}

async function reconcileOneVenue(store, venue, opts = {}) {
  const base = {
    venueId: venue.id,
    name: venue.name,
    severity: 'ok',
    driftCents: 0,
    findings: [],
    checksChecked: 0,
    accountsChecked: 0,
    // ESTES DOIS EXISTEM EM TODO RETORNO, inclusive no do `catch`.
    //
    // Eles foram acrescentados ao retorno de SUCESSO, ao agregado, ao
    // `formatReconcileAlert` e ao payload do aviso — quatro lugares — e o
    // `base`, que é a forma que o `catch` devolve, ficou de fora. Três de
    // quatro, de novo. O efeito medido: a varredura ESCREVIA numa linha e o
    // relatório afirmava `rowsRepaired: 0`, com o achado da gorjeta descartado
    // junto. Ausência silenciosa seria ruim; isto era uma afirmação FALSA num
    // relatório de dinheiro (HIGH-1 da revisão de segurança de 2026-09-09).
    rowsRepaired: 0,
    rowsRepairRaced: 0,
    rowsRepairAckLost: 0,
    rowsRepairRejected: 0,
    infoFindings: [],
  };
  /**
   * O REPARO SAI DO `Promise.all` — escrita que aconteceu sobrevive a leitura
   * que falhou.
   *
   * `reconcileVenue` é quem escreve. Dentro do `Promise.all`, a rejeição de
   * QUALQUER uma das três pernas levava junto o que ele já tinha feito: os
   * contadores e o `payment_tip_base_repaired` (o `high` que a compliance
   * exigiu no primeiro reparo justamente pra não se esconder atrás de
   * contagem). Pior, a janela de erro é CAUSADA pelo reparo — a releitura em
   * `reconcile.js` só acontece nas noites em que houve escrita, e um 5xx
   * transitório nela é a classe exata de transitório que esta função existe
   * pra consertar.
   */
  // O SUMIDOURO: `repararLinhasAtrasadas` escreve nele À MEDIDA que age, então
  // o `catch` lê o que já aconteceu mesmo que o estouro venha de DENTRO do
  // `reconcileVenue` — de um `reduce()` na conta seguinte, por exemplo, depois
  // de a linha anterior já ter sido escrita. Sem ele a testemunha só sobrevivia
  // a um estouro de perna IRMÃ. (MEDIUM-2 da revisão de segurança.)
  const pia = { repaired: [], failed: [], raced: [], ackLost: [], tip: [], skipped: 0 };
  let reparo = { rowsRepaired: 0, rowsRepairRaced: 0, rowsRepairAckLost: 0, rowsRepairRejected: 0, venueFindings: [] };
  try {
    const checks = await reconcileVenue(store, venue.id, { ...opts, witness: pia });
    reparo = {
      rowsRepaired: checks.rowsRepaired || 0,
      rowsRepairRaced: checks.rowsRepairRaced || 0,
      rowsRepairAckLost: checks.rowsRepairAckLost || 0,
      rowsRepairRejected: checks.rowsRepairRejected || 0,
      venueFindings: checks.venueFindings || [],
    };
    const [house, payables] = await Promise.all([
      reconcileVenueHouse(store, venue.id),
      // A terceira perna: o razão do ADQUIRENTE. As outras duas são nossas, e
      // uma é projeção da outra — só esta é testemunha independente.
      reconcilePayablesLeg(store, opts.psp, venue, opts),
    ]);

    // Achados das contas: o canário já ranqueia por severidade.
    const checkFindings = checks.failed.flatMap((f) =>
      f.findings.map((x) => ({ ...x, checkId: f.checkId })));
    // Achados de conta-corrente: os de venue (redeem ↔ payments) já vêm
    // ranqueados; os por conta vêm dentro de `failed`.
    const houseFindings = [
      ...house.findings,
      ...house.failed.flatMap((f) => f.findings.map((x) => ({ ...x, accountId: f.accountId }))),
    ];
    // Achados do RESTAURANTE: os que só existem no agregado (serviço cobrado
    // e nunca arrecadado, por exemplo — nenhuma conta sozinha revela isso).
    // Sem esta linha eles ficavam calculados e não relatados.
    const findings = [
      ...checkFindings, ...houseFindings,
      ...(checks.venueFindings || []),
      ...payables,
    ];

    return {
      ...base,
      severity: findings.reduce((s, f) => worse(s, f.severity), 'ok'),
      // O drift da casa entrava zerado: `checks.totalDriftCents` só cobre a
      // perna das contas, e o canário de SALDO carrega o dele em `driftCents`
      // por achado — uma casa com R$500 de drift de saldo alertava "drift 0,00".
      // Em módulo, e só a perna da casa: a das contas já vem somada em módulo
      // (reconcile.js:133), e somar os dois sinais aqui cancelava o total.
      driftCents: checks.totalDriftCents
        + houseFindings.reduce((sum, f) => sum + Math.abs(Number(f.driftCents) || 0), 0),
      findings,
      checksChecked: checks.checksChecked,
      accountsChecked: house.accountsChecked,
      // O que a varredura ESCREVEU nesta casa. Sem estas duas linhas o
      // relatório de uma noite em que ela reprojetou linhas de dinheiro saía
      // idêntico ao de uma noite em que ela não fez nada (HIGH-2 da revisão de
      // segurança de 2026-09-09). O achado correspondente vem em `findings`,
      // via `venueFindings`; estes contadores são pro relatório e pro alerta.
      rowsRepaired: checks.rowsRepaired || 0,
      rowsRepairRaced: checks.rowsRepairRaced || 0,
      rowsRepairAckLost: checks.rowsRepairAckLost || 0,
      rowsRepairRejected: checks.rowsRepairRejected || 0,
      // O TIER `info` para de ser só-escrita. `venues[]` descarta `findings` de
      // casa não-vermelha, então uma noite inteira de corridas perdidas — ou a
      // perna de custódia pulada por prazo — saía como um relatório mudo.
      infoFindings: findings.filter((f) => f.severity === 'info').map((f) => f.code),
    };
  } catch (err) {
    // Reconstrói o resumo a partir da pia — mesma função do caminho feliz, pra
    // que os dois lados não possam divergir.
    const resumo = resumoDoReparo(pia);
    // Um restaurante que estoura é ele próprio um achado crítico: significa que
    // o dinheiro dele não pôde ser conferido, que é o pior estado possível —
    // pior que drift conhecido.
    return {
      ...base,
      severity: 'critical',
      // O que o reparo JÁ FEZ vem junto: os contadores e os achados dele. A
      // conciliação não pôde ser concluída, mas as linhas que foram reescritas
      // foram reescritas, e quem lê o alerta precisa saber disso.
      // Do SUMIDOURO, não do `reparo`: se o estouro veio de dentro do
      // `reconcileVenue`, `reparo` nunca foi atribuído — mas a pia já tem o que
      // foi escrito até ali.
      rowsRepaired: resumo.reparadas,
      rowsRepairRaced: resumo.corridas,
      rowsRepairAckLost: resumo.ackPerdidos,
      rowsRepairRejected: resumo.rejeitados,
      // `venueFindings` VEM JUNTO: sem ele o `service_never_collected` — o
      // achado que só existe no agregado — sumia do caminho de erro, e uma
      // noite em que o restaurante perde 10% em toda conta virava uma linha
      // dizendo "supabase 503".
      findings: [{
        severity: 'critical',
        code: 'venue_reconcile_threw',
        message: `não deu pra conciliar: ${String(err && err.message).slice(0, 200)}`,
      }, ...resumo.achados, ...resumo.venueFindings],
    };
  }
}

/**
 * Varre todos os restaurantes.
 *
 * Restaurantes de teste (`isTest`) ficam de fora por padrão: o alerta existe pra
 * ser lido, e um alerta que dispara toda noite por causa de dado de teste é um
 * alerta que ninguém lê no terceiro dia.
 *
 * @param {object} store
 * @param {{ includeTest?: boolean }} [opts]
 */
async function reconcileAllVenues(store, opts = {}) {
  const all = await store.listVenueActivation();
  const venues = opts.includeTest ? all : all.filter((v) => v.isTest !== true);

  const venueReports = [];
  // Um prazo só pra varredura inteira: 90s dos 120s declarados, deixando folga
  // pro relatório e pro alerta saírem.
  const prazoDaVarredura = Date.now() + (Number.isSafeInteger(opts.sweepBudgetMs)
    ? opts.sweepBudgetMs : 90_000);
  for (const v of venues) {
    // Em série de propósito: a varredura é diária e roda no escuro; martelar o
    // banco em paralelo pra terminar meio segundo antes não paga o risco.
    /**
     * OPT-IN AQUI TAMBÉM. Era `opts.repair !== false` — opt-OUT.
     *
     * O `reconcileVenue` virou opt-in e o comentário dele diz "qualquer chamador
     * novo nasce lendo". Era verdade pra ele e MENTIRA uma camada acima: uma
     * rota nova fazendo `reconcileAllVenues(store, {})` escrevia calada, e o
     * censo de rotas procura a string `repair: true`, então não pegaria. O
     * padrão tem que ser o mesmo nos dois níveis, senão a frase protege só
     * metade do caminho. (LOW-3 da revisão de segurança de 2026-09-09.)
     *
     * O cron passa `repair` explicitamente — ele já calcula
     * `url.searchParams.get('dry') !== '1'`.
     */
    venueReports.push(await reconcileOneVenue(store, v, {
      ...opts, deadline: prazoDaVarredura, repair: opts.repair === true,
    }));
  }

  const red = venueReports.filter((r) => r.severity === 'critical' || r.severity === 'high');

  /**
   * Os ÓRFÃOS entram no relatório diário.
   *
   * `orphan_money_events` (migração 0024) guarda evento de dinheiro que não
   * achou conta — um cancelamento parcial de uma cobrança que a gente não
   * conhece, um alerta de repasse. Guardar sem ler é o mesmo que perder com
   * passos extras: uma tabela que ninguém olha é onde as coisas vão pra ser
   * esquecidas. Órfão aberto é `high` no relatório — pede ação humana e não
   * some sozinho.
   */
  let orphans = [];
  if (typeof store.listOpenOrphanMoneyEvents === 'function') {
    try { orphans = await store.listOpenOrphanMoneyEvents(); }
    catch (e) { process.stderr.write(`[reconcile-daily] órfãos não lidos: ${String(e.message).slice(0, 120)}\n`); }
  }
  const severidadeGeral = orphans.length > 0
    ? worse(venueReports.reduce((s, r) => worse(s, r.severity), 'ok'), 'high')
    : venueReports.reduce((s, r) => worse(s, r.severity), 'ok');

  return {
    at: new Date().toISOString(),
    venuesChecked: venueReports.length,
    venuesRed: red.length,
    orphanMoneyEvents: orphans.length,
    orphans: orphans.slice(0, 10),
    worstSeverity: severidadeGeral,
    totalDriftCents: venueReports.reduce((s, r) => s + r.driftCents, 0),
    // QUANTAS LINHAS A VARREDURA ESCREVEU. Ela repara `payments` em toda casa,
    // toda noite, sem ninguém olhando — e sem estes dois números o relatório de
    // uma noite dessas é indistinguível de uma noite parada. Um bug de projeção
    // que se repete seria remendado pra sempre e reportado verde: a forma exata
    // dos 12 dias do incidente do Seatable (HIGH-2, revisão de 2026-09-09).
    rowsRepaired: venueReports.reduce((s, r) => s + (r.rowsRepaired || 0), 0),
    rowsRepairRaced: venueReports.reduce((s, r) => s + (r.rowsRepairRaced || 0), 0),
    rowsRepairAckLost: venueReports.reduce((s, r) => s + (r.rowsRepairAckLost || 0), 0),
    rowsRepairRejected: venueReports.reduce((s, r) => s + (r.rowsRepairRejected || 0), 0),
    // O TIER `info` DO SWEEP INTEIRO. Ele atravessava uma fronteira e parava na
    // seguinte: `infoFindings` existia por casa e nada o lia. `payables_unchecked`
    // é `info`, então a perna de custódia podia apagar a varredura inteira e o
    // relatório sair verde. (MEDIUM-2 da revisão de segurança de 2026-09-09.)
    infoCodes: [...new Set(venueReports.flatMap((r) => r.infoFindings || []))].sort(),
    // O relatório inteiro é grande e ninguém lê trinta casas verdes: só o que
    // pede ação sai detalhado.
    red,
    venues: venueReports.map(({ findings, ...rest }) => rest),
  };
}

/**
 * A mensagem que o fundador recebe. Uma linha por casa vermelha, com o achado
 * mais grave junto — um alerta que só diz "tem drift" obriga a abrir o painel
 * pra descobrir onde, e às 4 da manhã isso vira "vejo amanhã".
 */
function formatReconcileAlert(report) {
  // ÓRFÃO ABERTO acorda o alerta mesmo com todo restaurante verde: é dinheiro
  // que se moveu e não achou conta, e ele não sai de lá sozinho.
  const orfaos = report.orphanMoneyEvents || 0;
  /**
   * ESCRITA em linha de dinheiro SEMPRE fala — a contagem é o eixo errado.
   *
   * O corte era `> 3` pra virar `high`, e abaixo disso a casa não ficava
   * vermelha, e sem casa vermelha esta função devolvia `null` ANTES de anexar
   * a linha do reparo. Resultado medido: 1, 2 ou 3 reprojeções por noite
   * saíam com alerta NENHUM, e o trecho que carrega `linhaReparos` no ramo
   * verde era código morto (só alcançável com órfão aberto). Três por noite é
   * noventa por mês de escrita não anunciada em `payments`.
   *
   * Contagem é bom proxy pra "isto é sistemático"; não é proxy nenhum pra
   * "mexemos em dinheiro sem perguntar". O `> 3 → high` continua, pro caso
   * sistemático — mas QUALQUER escrita bem-sucedida aparece na mensagem.
   * (HIGH-3 da revisão de segurança de 2026-09-09.)
   */
  // ACK PERDIDO conta como escrita: "pode ter escrito" precisa acordar alguém
  // tanto quanto "escreveu". Corrida perdida não escreveu nada, mas o número
  // atravessa o relatório pra que o tier `info` deixe de ser só-escrita.
  const escreveu = (report.rowsRepaired || 0) > 0 || (report.rowsRepairAckLost || 0) > 0
    || (report.rowsRepairRejected || 0) > 0;
  if (report.venuesRed === 0 && orfaos === 0 && !escreveu) return null;
  // O que a varredura ESCREVEU sai na mensagem, não só no JSON: quem lê o
  // alerta às 4 da manhã precisa saber que a conciliação mexeu em linha de
  // dinheiro antes de julgar o resto do texto.
  const reparos = report.rowsRepaired || 0;
  const semResposta = report.rowsRepairAckLost || 0;
  const recusados = report.rowsRepairRejected || 0;
  const linhaReparos = (reparos > 0 || semResposta > 0 || recusados > 0)
    ? `\n\na varredura reprojetou ${reparos} linha(s) de pagamento do razão`
      + (recusados > 0 ? `, teve ${recusados} RECUSADA(S) pelo banco (nada escrito)` : '')
      + (semResposta > 0 ? ` e ficou SEM RESPOSTA em ${semResposta} (pode ter escrito)` : '')
    : '';
  const linhaOrfaos = orfaos > 0
    ? `\n\n${orfaos} evento(s) de dinheiro SEM conta correspondente: `
      + (report.orphans || []).slice(0, 5)
        .map((o) => `${o.kind}${o.txid ? ` ${o.txid}` : ''}`).join(', ')
    : '';
  if (report.venuesRed === 0) {
    return `Conciliação ${report.at.slice(0, 10)}: restaurantes ok.${linhaOrfaos}${linhaReparos}`;
  }
  const linhas = report.red.slice(0, 10).map((v) => {
    /**
     * "NÃO DEU PRA CONCILIAR" NÃO PODE ENCOBRIR O QUE FOI ACHADO.
     *
     * `venue_reconcile_threw` é `critical` e entra na FRENTE da lista, então
     * `find(critical)` devolvia sempre ele — e uma casa arrecadando ZERO de
     * serviço saía como "• Boteco [critical] — não deu pra conciliar: supabase
     * 503". Eu tinha acabado de pôr o `service_never_collected` de volta no
     * array e ele parava aqui, uma camada abaixo de quem lê: o achado existe em
     * `report.red[].findings`, que só vive no corpo da resposta HTTP do cron —
     * e o invocador de cron da Vercel joga esse corpo fora.
     *
     * Então o estouro vira CONTEXTO e o pior achado de verdade vira a mensagem.
     * (HIGH-1, reaberto pela revisão de segurança de 2026-09-09.)
     */
    const estouro = v.findings.find((f) => f.code === 'venue_reconcile_threw');
    const reais = v.findings.filter((f) => f.code !== 'venue_reconcile_threw');
    const pior = reais.find((f) => f.severity === 'critical')
      || reais.find((f) => f.severity === 'high')
      || reais[0]
      || estouro;
    const drift = v.driftCents ? ` · drift ${(v.driftCents / 100).toFixed(2).replace('.', ',')}` : '';
    // Quando há os dois, os dois saem: o achado primeiro, porque é o que pede
    // ação, e o estouro em seguida, porque explica por que a conta pode estar
    // incompleta.
    const contexto = (estouro && pior && pior !== estouro)
      ? ` (e ${estouro.message})` : '';
    return `• ${v.name} [${v.severity}]${drift} — ${pior ? pior.message : 'sem detalhe'}${contexto}`;
  });
  const resto = report.red.length > 10 ? `\n(+${report.red.length - 10} restaurantes)` : '';
  return `Conciliação ${report.at.slice(0, 10)}: ${report.venuesRed} de ${report.venuesChecked} restaurantes com divergência.\n\n${linhas.join('\n')}${resto}${linhaOrfaos}${linhaReparos}`;
}

module.exports = {
  reconcileAllVenues, reconcileOneVenue, reconcilePayablesLeg,
  formatReconcileAlert, worse,
};
