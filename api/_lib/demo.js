'use strict';
/**
 * A mesa pública de demonstração (`?t=demoracha`) — UMA fonte pra conta que a
 * landing mostra, o dev-server semeia e o cron reseta.
 *
 * A landing prova "R$237.10 ÷ 3" com a conta desta mesa (Home.tsx: PROOF_TOTAL).
 * Se os itens mudarem, o total muda, e a prova mente — o teste
 * `demo-ensure.test.js` amarra os dois.
 *
 * `ensureDemoCheck` é auto-cura: um ambiente sem a mesa (preview do Vercel sem
 * store persistente, banco novo) ou com a conta da demo fechada (alguém pagou
 * tudo) NÃO mostra "conta não encontrada" no telefone da landing — cria/reabre.
 *
 * SÓ A DEMO. Nada aqui é seguro por ser "o token fixo": as duas funções são
 * alcançáveis por rota pública e sem auth, e `RACHA_DEMO_TABLE_TOKEN` é uma env
 * que alguém pode digitar errado. Um typo apontando pro token de uma mesa de
 * verdade faria `resetDemoCheck` FECHAR a conta aberta dela e abrir uma conta
 * falsa no lugar (achado CRÍTICO da revisão de compliance). Por isso a venue
 * resolvida é conferida contra um marcador durável ANTES de qualquer escrita, e
 * a mesa é procurada ignorando `active` — semear com base num null de mesa
 * desativada criava uma venue órfã por request.
 */

const { reduce } = require('./checks/check-state');
const { desfechoDoLancamento } = require('./checks/reconcile');

const DEMO_TOKEN = 'demoracha';
const DEMO_VENUE_NAME = 'Bar do Zé — demonstração';

const DEMO_ITEMS = Object.freeze([
  { id: 'd1', name: 'Picanha na chapa', priceCents: 8990 },
  { id: 'd2', name: 'Chopp artesanal (4x)', priceCents: 5560 },
  { id: 'd3', name: 'Batata rústica', priceCents: 3290 },
  { id: 'd4', name: 'Caipirinha (2x)', priceCents: 3980 },
  { id: 'd5', name: 'Pudim da casa', priceCents: 1890 },
].map(Object.freeze));

const DEMO_TOTAL_CENTS = DEMO_ITEMS.reduce((s, i) => s + i.priceCents, 0); // 23710

/** O marcador durável: venue de teste E recebedor mock. Os dois, não um ou outro. */
function isDemoVenue(venue) {
  return Boolean(venue) && venue.isTest === true && venue.pspRecipientId === 'rcpt_demo';
}

function isFresh(view) {
  return Boolean(view) && view.state.paidCents === 0 && view.state.totalCents === DEMO_TOTAL_CENTS;
}

/**
 * Resolve a mesa do token e prova que ela é a demo. Devolve:
 *   { table, venue } quando existe e é a demo
 *   null             quando não existe mesa nenhuma com esse token
 * Lança quando existe e NÃO é a demo — recusar alto é o ponto.
 */
async function resolveDemoTable(store, token) {
  const table = store.findTableAnyState ? await store.findTableAnyState(token) : null;
  if (!table) {
    // Store sem findTableAnyState: cai no caminho ativo, que é mais estrito.
    const hit = await store.getVenueByTableToken(token);
    if (!hit) return null;
    if (!isDemoVenue(hit.venue)) throw new Error('token is not the demo table');
    return { table: hit.table, venue: hit.venue };
  }
  const venue = store.getVenue ? await store.getVenue(table.venueId) : null;
  if (!isDemoVenue(venue)) throw new Error('token is not the demo table');
  if (table.active !== true) throw new Error('demo table is deactivated');
  return { table, venue };
}

/** Garante mesa + conta aberta pra demo. Devolve a view (nunca null). */
async function ensureDemoCheck(store, token = DEMO_TOKEN) {
  const found = await resolveDemoTable(store, token); // lança se não for a demo
  if (found) {
    const open = await store.getCheckByQrToken(token);
    if (open) return open;
  } else {
    const venue = await store.seedVenue({
      name: DEMO_VENUE_NAME, servicoBp: 1000, pspRecipientId: 'rcpt_demo', isTest: true,
    });
    await store.seedTable(venue.id, 'Mesa demo', token);
  }
  await store.openCheck(token, DEMO_ITEMS.map((i) => ({ ...i })));
  const view = await store.getCheckByQrToken(token);
  if (!view) throw new Error('demo check did not open');
  return view;
}

/**
 * Fecha a conta atual (se houver) e abre uma fresca. Idempotente se já fresca.
 *
 * O FECHAMENTO É UMA RESERVA ATÔMICA — o inegociável #7 na letra.
 *
 * Era ler → `appendEvent('CLOSED')` → abrir, sem nada entre a leitura e a
 * escrita. Com o cron e o `/api/demo/reset` isso era raro; com a renovação na
 * LEITURA da demo virou o caminho normal, porque a landing embute a demo num
 * iframe por visitante e todos sondam juntos. Medido com latência injetada:
 * vinte resets simultâneos deixaram DEZENOVE `CLOSED` na mesma conta, e o
 * razão imutável acusava todos menos o primeiro como `already closed`.
 *
 * Agora: lê os eventos, reduz, e só fecha se a conta ainda está aberta NO MESMO
 * `seq` que foi lido — pelo `appendEventIfUnchanged`, que o store já tinha. As
 * duas metades importam. Só a condição do `seq` não basta: se o CLOSED de outro
 * leitor cai ANTES da minha leitura, o `seq` que eu leio já o inclui, a minha
 * escrita condicional passa, e sai um segundo CLOSED. Por isso a redução
 * confere o estado no mesmo `seq` que a escrita reivindica.
 *
 * Quem perde a corrida (`40001`) não fecha nada: a conta já foi fechada por
 * outro, e ele só garante que existe uma aberta.
 *
 * E o fechamento diz QUEM fechou. Com `{}` vazio, o razão da demo não
 * distinguia a renovação do dono fechando a mesa (revisão de compliance).
 */
async function resetDemoCheck(store, token = DEMO_TOKEN, motivo = 'demo-renovada') {
  await resolveDemoTable(store, token); // lança antes de FECHAR qualquer coisa
  const view = await store.getCheckByQrToken(token);
  if (isFresh(view)) return { status: 'já fresca', totalCents: DEMO_TOTAL_CENTS };
  if (view) {
    const eventos = await store.loadEvents(view.check.id);
    const seq = eventos.length ? eventos[eventos.length - 1].seq : 0;
    const estado = reduce(eventos);
    if (estado && !estado.closed) {
      try {
        await store.appendEventIfUnchanged(view.check.id, 'CLOSED', { motivo }, null, seq);
      } catch (e) {
        // CONFLITO: o razão andou entre a minha leitura e a minha escrita —
        // outro leitor fechou primeiro. Qualquer outro desfecho é de verdade e
        // sobe. Pelo classificador, e não lendo o SQLSTATE aqui: decisão por
        // código de erro mora num lugar só, e o censo do `sql-contract` prende
        // isso — ele acusou a primeira versão deste `catch`.
        if (desfechoDoLancamento(e) !== 'conflito') throw e;
      }
    }
  }
  await ensureDemoCheck(store, token);
  return { status: 'resetada', totalCents: DEMO_TOTAL_CENTS };
}

/**
 * O TEMPO DE GLÓRIA de quem pagou a demo inteira.
 *
 * O "Conta paga por completo. Boa noite!" é o momento que a demo existe pra
 * mostrar. Renovar a conta no primeiro poll depois do pagamento arrancaria essa
 * tela de quem acabou de pagar — o telefone dele sonda a cada 4s. Noventa
 * segundos dão pra ver, respirar e fechar a aba; e ninguém que chega pela
 * landing espera mais que isso por uma conta nova.
 */
const DEMO_TEMPO_DE_GLORIA_MS = 90_000;

/**
 * A CONTA DA DEMO ESTÁ PAGA HÁ TEMPO DEMAIS? — decisão pura, sem I/O.
 *
 * Existe porque a cura de `/api/check` só disparava com a conta SUMIDA, e pagar
 * tudo não a faz sumir: fica `status: 'paga'`, ainda legível. O comentário da
 * cura prometia reabrir "com a conta fechada (alguém pagou tudo)"; o caso nunca
 * passava por ela. Visto em produção em 2026-09-23.
 *
 * Conta a partir do ÚLTIMO pagamento, não do primeiro: numa mesa de três, o
 * primeiro Pix pode ter uma hora e o que fechou a conta, dois segundos.
 *
 * Na dúvida, NÃO renova. Sem data legível não há como saber se alguém está
 * olhando a própria tela de pago — e renovar cedo demais é o único dano que
 * esta função pode causar. Não renovar é só o comportamento de hoje.
 */
function demoPagaHaTempo(state, agoraMs, graciaMs = DEMO_TEMPO_DE_GLORIA_MS) {
  if (!state || state.status !== 'paga') return false;
  // Um laço, e não `Math.max(...lista)`: o espalhamento estoura a pilha perto
  // de 125 mil pagamentos (medido pela revisão), e esta função roda numa
  // leitura PÚBLICA. Inalcançável numa conta de R$ 237,10 — é defesa, não
  // caminho —, mas uma decisão pura não deveria ter um tamanho em que lança.
  let ultimo = -Infinity;
  for (const p of Object.values(state.payments || {})) {
    const ms = Date.parse(p && p.confirmedAt);
    if (Number.isFinite(ms) && ms > ultimo) ultimo = ms;
  }
  if (ultimo === -Infinity) return false;
  return agoraMs - ultimo > graciaMs;
}

module.exports = {
  DEMO_TOKEN, DEMO_VENUE_NAME, DEMO_ITEMS, DEMO_TOTAL_CENTS, DEMO_TEMPO_DE_GLORIA_MS,
  ensureDemoCheck, resetDemoCheck, isFresh, isDemoVenue, demoPagaHaTempo,
};
