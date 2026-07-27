'use strict';

/**
 * Radar de ativação — onde cada restaurante EMPACOU no funil.
 *
 * Por que existe: em 25/jul/2026 o Racha tinha 3 restaurantes cadastrados e
 * ZERO uso de cliente real. Dois haviam travado dias antes (um sem recebedor,
 * outro sem nunca abrir uma conta) e nada avisou o fundador — cadastrar não é
 * ativar, e ninguém estava olhando a diferença. Este módulo é o olho.
 *
 * O funil, do mais longe do dinheiro pro mais perto:
 *   sem_recebedor → recebedor_em_analise → sem_mesas → sem_uso →
 *   sem_primeiro_pagamento → esfriou → ativo
 *
 * Cada restaurante para em UM degrau, e cada degrau tem UMA ação que destrava.
 * Um fundador solo não precisa de dashboard: precisa da próxima ligação.
 *
 * PURO por decisão: sem I/O e sem relógio próprio (nowMs entra por parâmetro).
 * Quem busca os números é o store; quem entrega é o cron. Assim isto é testável
 * de verdade e o cron não vira um emaranhado de regra com query.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

/** Carência: restaurante recém-criado ainda está montando — não é alerta. */
const DIAS_CARENCIA = 3;
/** Sem pagar por mais que isto = esfriou (a equipe parou de oferecer o QR). */
const DIAS_ESFRIOU = 7;

const ESTAGIOS = {
  SEM_RECEBEDOR: 'sem_recebedor',
  RECEBEDOR_EM_ANALISE: 'recebedor_em_analise',
  SEM_MESAS: 'sem_mesas',
  SEM_USO: 'sem_uso',
  SEM_PRIMEIRO_PAGAMENTO: 'sem_primeiro_pagamento',
  ESFRIOU: 'esfriou',
  NOVO: 'novo',
  ATIVO: 'ativo',
};

/**
 * Cada degrau: urgência (1 = mais longe do dinheiro), o que é, e a ÚNICA ação.
 * `precisaAcao: false` é o que mantém o digest silencioso quando está tudo bem.
 */
const DEGRAUS = {
  [ESTAGIOS.SEM_RECEBEDOR]: {
    prioridade: 1,
    precisaAcao: true,
    titulo: 'travado: não pode receber',
    acao: 'terminar o cadastro do recebedor (Pagar.me) — sem isso nenhum Pix entra',
  },
  [ESTAGIOS.RECEBEDOR_EM_ANALISE]: {
    prioridade: 2,
    precisaAcao: true,
    titulo: 'recebedor em análise (ainda não recebe)',
    acao: 'acompanhar o KYC na Pagar.me — NÃO pôr o QR na mesa antes de aprovar (o pagamento falharia)',
  },
  [ESTAGIOS.SEM_MESAS]: {
    prioridade: 3,
    precisaAcao: true,
    titulo: 'sem mesa de verdade',
    acao: 'cadastrar as mesas reais do salão (só treino/inativa não gera conta)',
  },
  [ESTAGIOS.SEM_USO]: {
    prioridade: 4,
    precisaAcao: true,
    titulo: 'pronto, mas nunca usou',
    acao: 'imprimir e pôr o QR na mesa + 15 min de treino com a equipe',
  },
  [ESTAGIOS.SEM_PRIMEIRO_PAGAMENTO]: {
    prioridade: 5,
    precisaAcao: true,
    titulo: 'abriu conta, ninguém pagou',
    acao: 'ver se o garçom está oferecendo — a frase na hora da conta é o que converte',
  },
  [ESTAGIOS.ESFRIOU]: {
    prioridade: 6,
    precisaAcao: true,
    titulo: 'esfriou',
    acao: 'ligar pro dono: usou e parou — descobrir o que travou',
  },
  [ESTAGIOS.NOVO]: {
    prioridade: 8,
    precisaAcao: false,
    titulo: 'recém-criado (na carência)',
    acao: null,
  },
  [ESTAGIOS.ATIVO]: {
    prioridade: 9,
    precisaAcao: false,
    titulo: 'ativo',
    acao: null,
  },
};

/**
 * Não-cliente: demo (Bar do Zé, Bar do Racha) OU venue marcado `is_test` —
 * sandbox do fundador, teste de amigo. O filtro por NOME não pega um teste
 * batizado de restaurante de verdade: em 27/jul/2026 o radar dizia "3
 * restaurantes, 1 ativo" quando a verdade era ZERO clientes. Métrica inflada
 * faz o fundador olhar pro lugar errado — e é o radar que decide o dia dele.
 */
function ehDemo(venue) {
  const v = typeof venue === 'string' ? { name: venue } : (venue || {});
  if (v.isTest === true) return true;
  return /demo|demonstra/i.test(String(v.name || ''));
}

const diasEntre = (deMs, ateMs) => Math.floor((ateMs - deMs) / DIA_MS);

/**
 * Em que degrau este restaurante parou.
 *
 * A ordem dos ifs É o funil, e é deliberadamente rígida: um dado inconsistente
 * (ex.: pagamento registrado num venue sem recebedor) nunca pode fazer o
 * bloqueio de dinheiro parecer resolvido. Campo faltando cai no pior caso —
 * o radar roda em cron e um venue capenga não pode derrubar o lote.
 */
function classificarVenue(v, nowMs) {
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const contas = num(v.contas);
  const pagos = num(v.pagosConfirmados);
  const mesas = num(v.mesasReais);
  const criadoMs = Number.isFinite(v.criadoMs) ? v.criadoMs : nowMs;
  const idadeDias = diasEntre(criadoMs, nowMs);

  const diasSemPagar = Number.isFinite(v.ultimoPagamentoMs)
    ? diasEntre(v.ultimoPagamentoMs, nowMs)
    : null;

  let estagio;
  if (!v.recebedorOk) estagio = ESTAGIOS.SEM_RECEBEDOR;
  // Só 'active' RECEBE de verdade. Um recipient parado no KYC da Pagar.me
  // ('registration'/'affiliation'/…) existe mas o pagamento falharia — e status
  // desconhecido (null) é "não sei", que aqui vale o mesmo que "não". Caso real:
  // o Kitos ficou dias em 'affiliation' parecendo "só não usaram ainda".
  else if (v.recipientStatus !== 'active') estagio = ESTAGIOS.RECEBEDOR_EM_ANALISE;
  else if (mesas === 0) estagio = ESTAGIOS.SEM_MESAS;
  else if (contas === 0) estagio = idadeDias > DIAS_CARENCIA ? ESTAGIOS.SEM_USO : ESTAGIOS.NOVO;
  else if (pagos === 0) estagio = ESTAGIOS.SEM_PRIMEIRO_PAGAMENTO;
  else if (diasSemPagar != null && diasSemPagar > DIAS_ESFRIOU) estagio = ESTAGIOS.ESFRIOU;
  else estagio = ESTAGIOS.ATIVO;

  return {
    id: v.id,
    name: v.name,
    estagio,
    ...DEGRAUS[estagio],
    idadeDias,
    diasSemPagar,
    contas,
    pagosConfirmados: pagos,
    mesasReais: mesas,
  };
}

/** Uma linha por restaurante travado — o fundador lê no celular e age. */
function linhaAlerta(a) {
  const contexto = a.diasSemPagar != null
    ? ` (${a.diasSemPagar}d sem pagamento)`
    : (a.idadeDias > 0 ? ` (${a.idadeDias}d de cadastro)` : '');
  return `• ${a.name} — ${a.titulo}${contexto}\n  → ${a.acao}`;
}

/**
 * O lote inteiro virado digest: só quem precisa de ação, mais urgente primeiro.
 * `precisaEnviar: false` quando não há alerta — silêncio é a feature (digest que
 * chega todo dia sem novidade vira ruído e para de ser lido).
 */
function montarRadar(venues, nowMs) {
  const reais = (venues || []).filter((v) => !ehDemo(v));
  const classificados = reais.map((v) => classificarVenue(v, nowMs));

  const alertas = classificados
    .filter((c) => c.precisaAcao)
    .sort((a, b) => a.prioridade - b.prioridade || String(a.name).localeCompare(String(b.name), 'pt-BR'));

  const porEstagio = classificados.reduce((acc, c) => {
    acc[c.estagio] = (acc[c.estagio] || 0) + 1;
    return acc;
  }, {});

  const ativos = porEstagio[ESTAGIOS.ATIVO] || 0;
  const cabecalho = `Racha — radar de ativação: ${reais.length} restaurante(s), ${ativos} ativo(s), ${alertas.length} precisando de ação.`;
  const mensagem = alertas.length
    ? `${cabecalho}\n\n${alertas.map(linhaAlerta).join('\n')}`
    : cabecalho;

  return {
    total: reais.length,
    ativos,
    alertas,
    porEstagio,
    precisaEnviar: alertas.length > 0,
    mensagem,
    classificados,
  };
}

module.exports = {
  ESTAGIOS, DEGRAUS, DIAS_CARENCIA, DIAS_ESFRIOU,
  ehDemo, classificarVenue, montarRadar,
};
