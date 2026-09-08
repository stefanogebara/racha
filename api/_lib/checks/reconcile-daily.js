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

const { reconcileVenue, reconcileVenueHouse } = require('./reconcile');

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
async function reconcileOneVenue(store, venue) {
  const base = {
    venueId: venue.id,
    name: venue.name,
    severity: 'ok',
    driftCents: 0,
    findings: [],
    checksChecked: 0,
    accountsChecked: 0,
  };
  try {
    const [checks, house] = await Promise.all([
      reconcileVenue(store, venue.id),
      reconcileVenueHouse(store, venue.id),
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
    const findings = [...checkFindings, ...houseFindings];

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
    };
  } catch (err) {
    // Um restaurante que estoura é ele próprio um achado crítico: significa que
    // o dinheiro dele não pôde ser conferido, que é o pior estado possível —
    // pior que drift conhecido.
    return {
      ...base,
      severity: 'critical',
      findings: [{
        severity: 'critical',
        code: 'venue_reconcile_threw',
        message: `não deu pra conciliar: ${String(err && err.message).slice(0, 200)}`,
      }],
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
  for (const v of venues) {
    // Em série de propósito: a varredura é diária e roda no escuro; martelar o
    // banco em paralelo pra terminar meio segundo antes não paga o risco.
    venueReports.push(await reconcileOneVenue(store, v));
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
  if (report.venuesRed === 0 && orfaos === 0) return null;
  const linhaOrfaos = orfaos > 0
    ? `\n\n${orfaos} evento(s) de dinheiro SEM conta correspondente: `
      + (report.orphans || []).slice(0, 5)
        .map((o) => `${o.kind}${o.txid ? ` ${o.txid}` : ''}`).join(', ')
    : '';
  if (report.venuesRed === 0) {
    return `Conciliação ${report.at.slice(0, 10)}: restaurantes ok.${linhaOrfaos}`;
  }
  const linhas = report.red.slice(0, 10).map((v) => {
    const pior = v.findings.find((f) => f.severity === 'critical')
      || v.findings.find((f) => f.severity === 'high')
      || v.findings[0];
    const drift = v.driftCents ? ` · drift ${(v.driftCents / 100).toFixed(2).replace('.', ',')}` : '';
    return `• ${v.name} [${v.severity}]${drift} — ${pior ? pior.message : 'sem detalhe'}`;
  });
  const resto = report.red.length > 10 ? `\n(+${report.red.length - 10} restaurantes)` : '';
  return `Conciliação ${report.at.slice(0, 10)}: ${report.venuesRed} de ${report.venuesChecked} restaurantes com divergência.\n\n${linhas.join('\n')}${resto}${linhaOrfaos}`;
}

module.exports = { reconcileAllVenues, reconcileOneVenue, formatReconcileAlert, worse };
