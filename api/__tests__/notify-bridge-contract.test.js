'use strict';

/**
 * O que a Racha MANDA tem que ser o que a ponte ACEITA.
 *
 * Em 2026-09-12 a revisão de segurança leu o receptor — coisa que três rodadas
 * anteriores não fizeram, porque todas endureceram o TRANSPORTE deste lado (o
 * `AbortSignal.timeout`, os fallbacks pra stderr) sem nunca perguntar se o
 * outro lado aceita o corpo. O receptor roteia `activation_radar` e depois
 * exige um campo `status` que a Racha não manda em evento nenhum de fundador.
 * Resultado: todo `reconcile_drift`, todo `reconcile_heartbeat` e todo evento
 * de dinheiro voltavam 400.
 *
 * A batida noturna, cujo contrato declarado é "a ausência dela é o alarme",
 * nunca chegou uma vez — então o contrato estava satisfeito de forma vazia.
 *
 * Este teste é o censo que faltava nos dois repositórios: a lista de eventos
 * que a Racha emite, contra a lista que a ponte aceita. A lista da ponte vive
 * aqui como FIXTURE porque os dois lados deployam separado — e é por isso que
 * ela precisa ser conferida à mão quando a ponte mudar. O que o teste garante é
 * que nenhum evento NOVO nasça do lado de cá sem alguém olhar o outro lado.
 */

const fs = require('node:fs');
const path = require('node:path');

const { KINDS_DE_FUNDADOR } = require('../_lib/notify');

const NOTIFY = fs.readFileSync(path.join(__dirname, '..', '_lib', 'notify.js'), 'utf8');
const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

/**
 * E TODO `_lib` JUNTO — o censo lia só o roteador.
 *
 * Quando o vigia do adquirente passou a emitir `account_alert` de dentro de
 * `_lib/pay/observa-adquirente.js`, o censo cujo trabalho declarado é "nenhum
 * evento NOVO nasça do lado de cá sem alguém olhar o outro lado" deixou de
 * cobrir o arquivo onde alertas de dinheiro são emitidos. Nada quebrou na hora
 * — `account_alert` já estava nas duas listas — e é exatamente por isso que
 * valia pegar: o censo teria ficado cego em silêncio até o próximo kind.
 * Achado pela revisão de segurança de 2026-09-21 (MEDIUM-2).
 */
function todoOLib(dir, fora = []) {
  for (const nome of fs.readdirSync(dir)) {
    const cheio = path.join(dir, nome);
    if (fs.statSync(cheio).isDirectory()) { todoOLib(cheio, fora); continue; }
    // Por CAMINHO, não por conteúdo: a primeira versão filtrava quem contivesse
    // a frase `MONEY EVENT ALERT`, que é o prefixo de log da casa — então o
    // próximo emissor que a copiasse sairia do censo em silêncio, que é
    // exatamente o modo de falha que este censo existe pra pegar.
    if (nome === 'notify.js') continue;   // o REMETENTE, não um emissor
    if (nome.endsWith('.js')) fora.push(fs.readFileSync(cheio, 'utf8'));
  }
  return fora;
}
/**
 * O `notify.js` fica de FORA: ele é o remetente, não um emissor.
 *
 * Dentro do corpo, ele contribuía duas `chamadas` falsas — um comentário que
 * cita o padrão e a própria DECLARAÇÃO `async function notifyFounderMoneyEvent({
 * kind, …`, que o regex não distingue de uma chamada — compensadas por duas
 * `dinamicos` falsas (outro comentário e um `kind: parsed.kind` do
 * `webhook-handler` que vai pra OUTRO destinatário). 2 + 5 = 7 fechava por
 * coincidência, e apagar aquela linha do `webhook-handler` reprovava este
 * censo por nada. Achado pela re-revisão de segurança (2026-09-21).
 */
const EMISSORES = [ROUTER, ...todoOLib(path.join(__dirname, '..', '_lib'))].join('\n');

/**
 * O que `restaurant-ai-mcp/api/racha-notify.js` aceita hoje.
 *
 * FIXTURE à mão porque os dois lados deployam separado — e por isso ela precisa
 * ser conferida quando a ponte mudar. O que o teste garante é que nenhum evento
 * novo nasça deste lado sem alguém olhar o outro.
 */
const A_PONTE_ACEITA = new Set([
  'activation_radar',
  'recipient_status',
  'reconcile_drift', 'reconcile_heartbeat',
  'dispute_opened', 'dispute_updated', 'dispute_funds', 'dispute_lost',
  'account_alert', 'unusable_money_event', 'refund_failed',
  // ⚠️ `money_without_check` foi acrescentado do lado da Racha em 2026-09-16 e
  // PRECISA ser aceito em `restaurant-ai-mcp/api/racha-notify.js` — os dois
  // lados deployam separado. Enquanto a ponte não o aceitar, o aviso é recusado
  // lá e o evento segue DURÁVEL aqui (`orphan_money_events`), porque o
  // `needsRetry` depende do registro e não do aviso. Ou seja: some o alerta,
  // não o dinheiro.
  'money_without_check',
  'retention_ok', 'retention_blocked', 'retention_late',
]);

describe('a ponte de avisos aceita o que a Racha manda', () => {
  test('todo kind de fundador está na lista da ponte — comparação de CONJUNTOS', () => {
    // A primeira versão disto era uma regex procurando
    // `notifyFounderMoneyEvent({ kind: '<literal>'` no router: primeira chave,
    // literal, logo depois da chave. Três dos seis call sites passam
    // `kind: parsed.kind` — os TRÊS de disputa e estorno — e sumiam. O censo
    // media a FORMA DA CHAMADA, não o conjunto de eventos emitidos, e por isso
    // certificou como coberto justamente o que voltava 400.
    //
    // Agora a lista é exportada pelo remetente e o teste compara conjuntos.
    expect(KINDS_DE_FUNDADOR.size).toBeGreaterThan(0);
    const recusados = [...KINDS_DE_FUNDADOR].filter((k) => !A_PONTE_ACEITA.has(k)).sort();
    expect(recusados).toEqual([]);
  });

  test('todo kind que os adaptadores produzem foi CLASSIFICADO', () => {
    // A direção que faltava. A comparação de subconjunto acima não vê uma
    // REMOÇÃO: tirar `dispute_opened` da lista mantém o subconjunto e passa
    // verde, enquanto o webhook passa a estourar em produção.
    //
    // Aqui a fonte é o que os adaptadores de PSP realmente normalizam. Todo
    // `kind` que eles produzem tem que estar num dos dois lados: vai pro
    // fundador, ou está nomeado aqui como coisa que não vai. Um adaptador que
    // invente um evento novo reprova até alguém decidir de que lado ele fica.
    const dir = path.join(__dirname, '..', '_lib', 'pay');
    const kinds = new Set();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const texto = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of texto.matchAll(/kind: '([a-z_]+)'/g)) kinds.add(m[1]);
      // A forma ternária: `kind: x ? 'refund_failed' : 'refund_progress'`.
      for (const m of texto.matchAll(/kind: [^,\n]*\? '([a-z_]+)' : '([a-z_]+)'/g)) {
        kinds.add(m[1]); kinds.add(m[2]);
      }
    }
    expect(kinds.size).toBeGreaterThan(5);

    // Os que NÃO viram aviso de fundador, um a um, com o motivo.
    const NAO_AVISAM = new Map([
      ['payment_confirmed', 'caminho feliz: vira evento de razão, não alerta'],
      ['payment_failed', 'o cliente vê na tela; não acorda ninguém'],
      ['refund', 'estorno normal, gravado no razão'],
      ['refund_progress', 'estado intermediário — o router exclui explicitamente'],
      ['dispute_won', 'desfecho bom: entra no razão, não alerta'],
      ['ignored', 'evento do PSP que não nos diz respeito'],
    ]);

    const semClassificacao = [...kinds]
      .filter((k) => !KINDS_DE_FUNDADOR.has(k) && !NAO_AVISAM.has(k))
      .sort();
    expect(semClassificacao).toEqual([]);
  });

  test('a lista da ponte não tem nome que não seja evento', () => {
    // O outro lado do mesmo erro: a lista tinha `dispute_evidence_due`,
    // `money_event_unrecorded` e três irmãos — códigos de achado da conciliação
    // e de erro HTTP, que só PARECEM nome de evento. Deixá-los lá faz o
    // próximo leitor acreditar que disputa está coberta.
    const naoSaoEventos = ['overpaid_pending_restitution', 'money_event_unrecorded',
      'dispute_close_unrecorded', 'dispute_evidence_due', 'dispute_evidence_overdue'];
    const intrusos = naoSaoEventos.filter((n) => A_PONTE_ACEITA.has(n));
    expect(intrusos).toEqual([]);
  });

  test('todo call site passa um kind que a lista conhece', () => {
    // O remetente ESTOURA num kind desconhecido, então o caminho dinâmico
    // (`kind: parsed.kind`) falha alto em vez de sumir. Aqui se garante que o
    // caminho literal também não escapa: todo literal escrito no router tem que
    // estar na lista.
    const literais = [...EMISSORES.matchAll(/(?:notifyFounderMoneyEvent|avisarEventoDeDinheiro)\(\{[\s\S]{0,120}?kind: '([a-z_]+)'/g)]
      .map((m) => m[1]);
    expect(literais.length).toBeGreaterThan(0);
    const forasDaLista = [...new Set(literais)].filter((k) => !KINDS_DE_FUNDADOR.has(k)).sort();
    expect(forasDaLista).toEqual([]);

    // E TODO call site foi contabilizado: se um deles passar o kind por
    // variável sem que o remetente valide, isto denuncia a diferença.
    const chamadas = (EMISSORES.match(/(?:notifyFounderMoneyEvent|avisarEventoDeDinheiro)\(\{/g) || []).length;
    /**
     * DENTRO da chamada de aviso, não solto no arquivo.
     *
     * `kind: parsed.kind` também aparece num `recordPayment(...)` do
     * `webhook-handler` — outro destinatário, nada a ver com a ponte. Contado
     * solto, ele inflava `dinamicos` e o invariante só fechava porque outra
     * contagem estava inflada na mesma medida.
     */
    const dinamicos = [...EMISSORES.matchAll(
      /(?:notifyFounderMoneyEvent|avisarEventoDeDinheiro)\(\{[\s\S]{0,200}?kind: (?:parsed|aviso)\.kind/g,
    )].length;
    expect(literais.length + dinamicos).toBe(chamadas);
  });

  /**
   * E A FONTE DINÂMICA TAMBÉM É FECHADA.
   *
   * O censo acima aceita `kind: <algo>.kind` porque o remetente estoura num
   * kind desconhecido — "falha alto em vez de sumir". Só que no observador do
   * adquirente esse estouro NÃO é alto: ele cai no catch do `avisar`, vira
   * `entregue = false`, e o efeito é o pager calado. Então a fonte precisa ser
   * fechada na origem, e não só barulhenta na ponte.
   *
   * O vigia produz um kind só, e este teste é o que impede o segundo de nascer
   * sem passar pela lista da ponte. (segurança LOW-5 da re-revisão.)
   */
  test('o kind que o vigia do adquirente produz está na lista da ponte', () => {
    const { criarVigiaDoAdquirente } = require('../_lib/pay/saude-do-adquirente');
    const olho = criarVigiaDoAdquirente({ seguidasPorCasa: 1 });
    const recusa = (httpStatus) => Object.assign(new Error('x'), { httpStatus });
    const vistos = new Set();
    for (const [st, casa, chk] of [[403, null, null], [422, 'v1', 'c1']]) {
      const aviso = olho.registrarFalha(recusa(st), casa, chk);
      expect(aviso).toBeTruthy();
      vistos.add(aviso.kind);
    }
    // Os dois escopos, e nenhum kind fora da lista que a ponte aceita.
    expect([...vistos].filter((k) => !KINDS_DE_FUNDADOR.has(k))).toEqual([]);
  });

  test('os eventos da conciliação estão na lista da ponte', () => {
    const eventos = [...NOTIFY.matchAll(/event: heartbeat \? '([a-z_]+)' : '([a-z_]+)'/g)]
      .flatMap((m) => [m[1], m[2]]);
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos.filter((e) => !A_PONTE_ACEITA.has(e)).sort()).toEqual([]);
  });

  test('entrega recusada OU vazia nunca passa por silêncio — nem a batida', () => {
    // Duas coisas: a batida recusada não escrevia nada (`!res.ok && !heartbeat`),
    // e 200 com zero canais entregues era tratado como sucesso. A ponte captura
    // toda falha de canal numa string e devolve 200 — então `res.ok` sozinho
    // trocava "400 alto no log" por "200 calado", que é o pior dos dois.
    expect(NOTIFY).not.toMatch(/if \(!res\.ok && !heartbeat\)/);
    // OS TRÊS remetentes, não dois. O do dono ficou pra trás na primeira
    // passada — e é onde o `.ok` mais pesa: ele PORTÃO da gravação da transição
    // de status do recebedor, então um 200 sem entrega persiste a transição, a
    // aresta some, e o dono nunca fica sabendo que o recebedor foi recusado.
    expect((NOTIFY.match(/const entregue = entregouAlgumCanal\(data\)/g) || []).length).toBe(3);
    expect((NOTIFY.match(/if \(!res\.ok \|\| !entregue\)/g) || []).length).toBe(3);
    // E o `ok` DEVOLVIDO leva a entrega junto — sem isto, reverter a linha do
    // retorno deixa tudo verde e o campo volta a significar "a ponte recebeu".
    expect((NOTIFY.match(/ok: res\.ok && entregue/g) || []).length).toBe(3);
  });

  test('todo conjunto que DESPACHA pro avisador é subconjunto do que ele aceita', () => {
    // A invariante que torna o `throw` seguro, e que faltava.
    //
    // `NON_LEDGER_KINDS` é despachado pro `handleNonLedgerMoneyEvent`, que
    // chama o avisador quando o kind não está em `SEM_ALARDE`. `payment_failed`
    // estava nos três lugares errados: no despacho, fora da lista do avisador,
    // e fora do silêncio. Com o `throw`, isso deixou de ser "um alerta espúrio"
    // e virou "o endpoint do adquirente desligado" — o registro durável já foi
    // gravado, o webhook devolve 5xx, e a reentrega eterna derruba TODA
    // confirmação de Pix.
    //
    // A armadilha já estava documentada no `router.js`; este commit mudou o
    // preço dela. Achado pelas duas revisões de 2026-09-12.
    const { NON_LEDGER_KINDS } = require('../_lib/pay/webhook-handler');
    const { SEM_ALARDE } = require('../_lib/pay/non-ledger');
    expect(NON_LEDGER_KINDS.size).toBeGreaterThan(0);
    const desprotegidos = [...NON_LEDGER_KINDS]
      .filter((k) => !KINDS_DE_FUNDADOR.has(k) && !SEM_ALARDE.has(k))
      .sort();
    expect(desprotegidos).toEqual([]);
  });

  test('todo kind que os GUARDAS do webhook deixam passar é aceito pelo avisador', () => {
    // O outro caminho de despacho, e o que a mutação do revisor abriu: pôr
    // `|| parsed.kind === 'dispute_won'` na condição do `:789` passava com 683
    // verdes, porque `dispute_won` está em `NAO_AVISAM` — o mapa certifica "este
    // não avisa" e nada conferia se o ROTEADOR concorda.
    const guarda = ROUTER.slice(ROUTER.indexOf("if (parsed.kind === 'dispute_opened'"));
    const condicao = guarda.slice(0, guarda.indexOf(') {'));
    const noGuarda = [...condicao.matchAll(/parsed\.kind === '([a-z_]+)'/g)].map((m) => m[1]);
    expect(noGuarda.length).toBeGreaterThan(3);

    // `refund_progress` é excluído explicitamente antes do aviso.
    const chegamAoAvisador = noGuarda.filter((k) => k !== 'refund_progress');
    const recusados = chegamAoAvisador.filter((k) => !KINDS_DE_FUNDADOR.has(k)).sort();
    expect(recusados).toEqual([]);

    // Os dois ramos de kind único que também chamam o avisador.
    for (const k of ['dispute_lost', 'refund_failed']) {
      expect(ROUTER).toMatch(new RegExp(`parsed\\.kind === '${k}'`));
      expect(KINDS_DE_FUNDADOR.has(k)).toBe(true);
    }
  });

  test('contrato quebrado perde o alerta, nunca o endpoint', () => {
    // `throw` puro nos sites de webhook derrubaria a requisição inteira. Só o
    // erro MARCADO é engolido, e alto; falha de entrega continua subindo.
    expect(NOTIFY).toMatch(/err\.code = 'kind_desconhecido'/);
    expect(ROUTER).toMatch(/async function avisarEventoDeDinheiro/);
    expect(ROUTER).toMatch(/e\.code === 'kind_desconhecido'/);
    // OS DOIS webhooks — o recorte começava no da Stripe, e o do Pix ficava de
    // fora do bloco que o teste chama de "o bloco dos webhooks".
    const webhook = ROUTER.slice(ROUTER.indexOf("url.pathname === '/api/webhooks/psp'"),
      ROUTER.indexOf("url.pathname === '/api/cron/"));
    // CONTAGEM POSITIVA antes da negativa: se alguém mover um cron pra cima dos
    // webhooks, ou renomear a âncora, o recorte vira vazio e o `not.toMatch`
    // passa calado. É a guarda que o `sql-contract.test.js` já tem e esta não
    // tinha — "um regex quebrado passaria calado".
    expect(webhook.length).toBeGreaterThan(1000);
    expect((webhook.match(/avisarEventoDeDinheiro\(\{/g) || []).length).toBe(3);
    expect(webhook).not.toMatch(/await notifyFounderMoneyEvent\(/);

    // E a LIGAÇÃO do handler não-lançável também passa pelo embrulho: é o
    // quarto caminho, e não é expressão de chamada, então nenhum censo de
    // chamada o veria.
    expect(ROUTER).toMatch(/store, notify: avisarEventoDeDinheiro,/);
    expect(ROUTER).not.toMatch(/store, notify: notifyFounderMoneyEvent,/);
  });

  test('um kind fora da lista ESTOURA no remetente', async () => {
    const { notifyFounderMoneyEvent } = require('../_lib/notify');
    await expect(notifyFounderMoneyEvent({ kind: 'inventado_agora' }))
      .rejects.toThrow(/kind desconhecido/);
  });
});
