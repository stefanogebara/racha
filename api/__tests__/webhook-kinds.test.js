'use strict';

/**
 * O CENSO das espécies de evento.
 *
 * As duas revisões de 2026-09-08 apontaram a mesma coisa por caminhos
 * diferentes: o portão do webhook endurecia a espécie inofensiva (`ignored`) e
 * deixava as perigosas passando pro aplicador, onde tudo que não é `refund` é
 * tratado como PAGAMENTO. Uma notificação de chargeback viraria
 * PAYMENT_CONFIRMED, a conta viraria `paga` e a mesa fecharia em cima dele.
 *
 * Um teste por caso pega o caso. Este pega a PRÓXIMA espécie que alguém
 * inventar: ele varre os adaptadores procurando `kind: '…'` e exige que cada
 * uma esteja classificada. Foi o que faltou quando eu acrescentei
 * `unusable_money_event` — ela não estava em conjunto nenhum, e sem este teste
 * teria caído no aplicador e virado um pagamento.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  createWebhookHandler, LEDGER_KINDS, NON_LEDGER_KINDS,
} = require('../_lib/pay/webhook-handler');

const ADAPTERS = ['mock-psp.js', 'pagarme-psp.js', 'stripe-psp.js'];

function kindsEmitidos() {
  const found = new Map();
  for (const file of ADAPTERS) {
    const src = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', file), 'utf8');
    for (const m of src.matchAll(/\bkind:\s*'([a-z_]+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push(file);
    }
    // `kind: cond ? 'a' : 'b'` — o ternário do refund/refund_failed.
    for (const m of src.matchAll(/\bkind:\s*[^,\n]*\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g)) {
      for (const k of [m[1], m[2]]) {
        if (!found.has(k)) found.set(k, []);
        found.get(k).push(file);
      }
    }
  }
  return found;
}

describe('censo das espécies de evento de webhook', () => {
  test('toda espécie que um adaptador emite está classificada', () => {
    const classificadas = new Set([...LEDGER_KINDS, ...NON_LEDGER_KINDS, 'ignored']);
    const emitidas = kindsEmitidos();
    const orfas = [...emitidas.keys()].filter((k) => !classificadas.has(k)).sort();
    expect(orfas).toEqual([]);
    // E o censo não pode estar vazio por um regex que parou de casar — se
    // isso acontecer, o teste passa sem olhar nada.
    expect(emitidas.size).toBeGreaterThanOrEqual(4);
    expect([...emitidas.keys()]).toContain('payment_confirmed');
    expect([...emitidas.keys()]).toContain('refund');
  });

  test('toda espécie do razão tem um tipo de evento, e o razão conhece o tipo', () => {
    const { EVENT_FOR_KIND } = require('../_lib/pay/webhook-handler');
    const { EVENT_TYPES } = require('../_lib/checks/check-state');
    expect(new Set(Object.keys(EVENT_FOR_KIND))).toEqual(LEDGER_KINDS);
    for (const [kind, tipo] of Object.entries(EVENT_FOR_KIND)) {
      // O mapa substituiu o ternário `kind === 'refund' ? … : PAYMENT_CONFIRMED`,
      // cujo `else` fazia qualquer espécie desconhecida virar PAGAMENTO.
      expect(EVENT_TYPES).toContain(tipo);
      expect(typeof kind).toBe('string');
    }
  });

  test('as duas listas são DISJUNTAS — nada move e não move o razão ao mesmo tempo', () => {
    for (const k of LEDGER_KINDS) expect(NON_LEDGER_KINDS.has(k)).toBe(false);
    expect(LEDGER_KINDS.has('ignored')).toBe(false);
    expect(NON_LEDGER_KINDS.has('ignored')).toBe(false);
  });

  test('cada espécie tem o desfecho certo no portão, e desconhecida ESTOURA', async () => {
    const aplicou = [];
    const handleWith = (parsed) => createWebhookHandler({
      psp: { async verifyAndParseWebhook() { return parsed; } },
      loadEvents: async () => [],
      appendEvent: async () => 1,
      findCheckByTxid: async (txid) => { aplicou.push(txid); return null; },
      fallback: async () => null,
    })('corpo', 'assinatura');

    // Ignorado: 200 barato, sem tocar no razão.
    expect(await handleWith({ kind: 'ignored', type: 'charge.updated' }))
      .toEqual({ status: 'ignored', type: 'charge.updated' });

    // Evento de dinheiro sem lançamento: para no portão, e diz qual é.
    for (const kind of NON_LEDGER_KINDS) {
      const r = await handleWith({ kind, txid: 'pi_x', amountCents: 3390 });
      expect(r.status).toBe(kind);
      expect(r.txid).toBe('pi_x');
    }
    // NENHUM deles chegou ao aplicador — é o ponto todo.
    expect(aplicou).toEqual([]);

    // Os do razão chegam. Aqui o txid é desconhecido, então é recusa alta,
    // que é o comportamento certo pra um txid que não emitimos.
    for (const kind of LEDGER_KINDS) {
      const r = await handleWith({ kind, txid: 'pi_y', amountCents: 3390, tipCents: 0 });
      expect(r.status).toBe('rejected');
    }
    // Uma entrada por espécie do razão — contagem derivada da lista, não
    // escrita à mão: `refund_failed` mudou de lado quando ganhou evento
    // próprio, e um número fixo aqui só teria dado trabalho.
    expect(aplicou).toEqual(new Array(LEDGER_KINDS.size).fill('pi_y'));

    // Espécie desconhecida não é ignorada nem aplicada: estoura.
    await expect(handleWith({ kind: 'especie_nova', txid: 'pi_z' }))
      .rejects.toThrow(/kind desconhecido/);
    await expect(handleWith({ txid: 'pi_z' })).rejects.toThrow(/sem `kind`/);
  });
});

test('a rota do Stripe conhece exatamente as mesmas espécies que o portão', () => {
  // O censo prova o `createWebhookHandler`. Mas a rota `/api/webhooks/stripe`
  // NÃO passa por ele: ela chama o adaptador e o aplicador direto, com uma
  // lista de espécies copiada à mão. Então o teste provava um portão que a
  // produção não atravessa — a substância do achado estava fechada, a prova
  // apontava pro lugar errado. Achado pela revisão de compliance de 2026-09-08.
  //
  // O custo de divergir: uma espécie nova acrescentada ao adaptador e ao
  // `NON_LEDGER_KINDS` e esquecida na lista da rota cai no aplicador, o
  // `EVENT_FOR_KIND` não a conhece, e vira 500 → reenvio → endpoint
  // desabilitado → eventos de dinheiro de verdade perdidos.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

  // O bloco de despacho da rota do Stripe: `parsed.kind === '…'` dentro dela.
  const inicio = src.indexOf("url.pathname === '/api/webhooks/stripe'");
  expect(inicio).toBeGreaterThan(0);
  /**
   * ATÉ A PRÓXIMA ROTA, e não uma janela de N caracteres.
   *
   * Era `slice(inicio, inicio + 12000)`. Um comentário acrescentado no meio da
   * rota empurrou parte do despacho pra fora da janela e o censo passou a
   * acusar espécies "faltando" que estão lá — uma janela fixa envelhece junto
   * com o arquivo, e o jeito dela falhar é acusar o inocente, que morre igual a
   * absolver o culpado. É o mesmo recorte que o `non-ledger.test.js` já usa.
   */
  const fimDaRota = src.indexOf("url.pathname === '", inicio + 40);
  const bloco = src.slice(inicio, fimDaRota > inicio ? fimDaRota : undefined);
  const naRota = new Set([...bloco.matchAll(/parsed\.kind === '([a-z_]+)'/g)].map((m) => m[1]));

  // Toda espécie que NÃO move o razão precisa estar tratada na rota — senão
  // cai no aplicador, que só conhece as do razão.
  const faltando = [...NON_LEDGER_KINDS].filter((k) => !naRota.has(k)).sort();
  expect(faltando).toEqual([]);

  // E a rota não pode inventar espécie que o portão não conhece.
  const classificadas = new Set([...LEDGER_KINDS, ...NON_LEDGER_KINDS, 'ignored']);
  const inventadas = [...naRota].filter((k) => !classificadas.has(k)).sort();
  expect(inventadas).toEqual([]);
});

/**
 * O CENSO do `eventId` — a idempotência que existia só no papel.
 *
 * A migração 0018 fecha a corrida entre duas entregas simultâneas com um
 * índice único em `psp_event_id`, DENTRO do lock por conta. O índice é
 * parcial: ele ignora nulos. Então um adaptador que não carrega o id do evento
 * não tem a defesa — e o do Pagar.me, que é o trilho em produção, não
 * carregava em retorno nenhum. A defesa inteira existia só pra Stripe, que
 * está desligada.
 *
 * O que ficava aberto: duas entregas do mesmo `charge.refunded` liam o mesmo
 * estado velho (a leitura é FORA do lock), calculavam o mesmo delta e
 * gravavam as duas. Achado pelas duas revisões de 2026-09-08, por caminhos
 * diferentes.
 *
 * Um teste por adaptador pega o adaptador. Este pega o PRÓXIMO.
 */
describe('censo do id do evento', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  test('todo retorno que move ou toca dinheiro carrega `eventId`', () => {
    const semId = [];
    for (const file of ADAPTERS) {
      const src = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', file), 'utf8');
      // Cada `return { … kind: '…' … }` do parser de webhook, com o corpo
      // inteiro (podem ser várias linhas).
      for (const m of src.matchAll(/return \{[\s\S]{0,400}?\};/g)) {
        const corpo = m[0];
        const kind = corpo.match(/kind:\s*'([a-z_]+)'/);
        if (!kind) continue;
        // `ignored` também carrega, mas quem não pode faltar é dinheiro.
        const classificada = LEDGER_KINDS.has(kind[1]) || NON_LEDGER_KINDS.has(kind[1]);
        if (!classificada) continue;
        if (!/\beventId\b/.test(corpo)) semId.push(`${file}: kind ${kind[1]}`);
      }
    }
    expect(semId).toEqual([]);
  });

  test('o mock também — um duble sem id não exercita a defesa', () => {
    // O mock é o PSP de todo teste de rota e da demo. Se ele não carrega o id,
    // nenhum teste de ponta a ponta passa pela idempotência do append, e o
    // buraco reaparece na produção sem nada ficar vermelho.
    const src = fs.readFileSync(path.join(__dirname, '..', '_lib', 'pay', 'mock-psp.js'), 'utf8');
    expect(src).toMatch(/eventId/);
  });
});

/**
 * O CENSO das dependências do fabricante.
 *
 * `createWebhookHandler` desestrutura o que recebe e monta o `deps` que passa
 * ao aplicador — à mão, campo por campo. `seenPspEvent` ficou de fora: os três
 * chamadores passavam, dois jogavam fora em silêncio, e o curto-circuito de
 * reentrega (o que faz a segunda entrega sair como `duplicate` em vez de 409 →
 * reenvio → endpoint desabilitado) estava morto nos dois caminhos de webhook.
 */
describe('o fabricante do portão não perde dependência no caminho', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..');

  test('tudo que o aplicador USA chega nele', () => {
    const src = fs.readFileSync(path.join(raiz, '_lib', 'pay', 'webhook-handler.js'), 'utf8');
    // Todo `const { … } = deps` do módulo: o aplicador e os auxiliares que
    // recebem `deps` inteiro (a reparação da linha, por exemplo).
    const usadas = new Set();
    for (const m of src.matchAll(/const \{([^}]*)\} = deps;/g)) {
      for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) usadas.add(n);
    }
    for (const m of src.matchAll(/const \{ ([^}]*) \} = deps;/g)) {
      for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) usadas.add(n);
    }
    expect(usadas.size).toBeGreaterThanOrEqual(6);

    const fab = src.match(/const deps = \{([^}]*)\}/);
    expect(fab).not.toBeNull();
    const passadas = new Set(fab[1].split(',').map((x) => x.trim()).filter(Boolean));

    // A direção que importa: nada que o aplicador usa pode faltar no `deps`.
    // Era exatamente isto — `seenPspEvent` desestruturado lá e ausente aqui,
    // então o curto-circuito de reentrega ficou morto nos dois caminhos de
    // webhook enquanto os três chamadores passavam a dependência.
    const faltando = [...usadas].filter((n) => !passadas.has(n)).sort();
    expect(faltando).toEqual([]);
    for (const obrigatoria of ['seenPspEvent', 'getPayment', 'recordPayment']) {
      expect(passadas.has(obrigatoria)).toBe(true);
    }
  });

  test('os chamadores de verdade passam tudo — nenhum monta o `deps` pela metade', () => {
    const src = fs.readFileSync(path.join(raiz, '_app', 'router.js'), 'utf8');
    // Cada lugar do router que monta dependências de dinheiro começa por
    // `loadEvents: store.loadEvents…`. São três: o webhook do Pix, a
    // conciliação ativa, e o webhook da demo.
    const inicios = [...src.matchAll(/loadEvents: store\.loadEvents/g)].map((m) => m.index);
    expect(inicios.length).toBeGreaterThanOrEqual(3);
    for (const i of inicios) {
      const bloco = src.slice(i, i + 700);
      for (const dep of ['appendEvent', 'recordPayment', 'findCheckByTxid',
        'seenPspEvent', 'getPayment']) {
        expect(bloco).toContain(dep);
      }
    }
  });
});

/**
 * O CENSO das chaves de idempotência.
 *
 * `psp_event_id` é único no banco INTEIRO (migração 0018). Então uma entrega
 * que produz DOIS lançamentos não pode usar o mesmo `evt_` nos dois: o segundo
 * append vira no-op silencioso, ou — pior — o primeiro queima a chave e a
 * REENTREGA (o mecanismo em que o caminho fora-de-ordem confia) sai como
 * `duplicate` sem aplicar nada.
 *
 * Aconteceu nos dois lugares onde uma entrega produz dois lançamentos. Um foi
 * corrigido à mão (`${eventId}:closed`, no fecho da disputa) e o outro ficou
 * (a anomalia de reversão fora de ordem) — a correção à mão achou um dos dois.
 * Este censo acha o próximo.
 */
describe('censo das chaves de idempotência', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..');

  /**
   * Os arquivos vêm de uma VARREDURA, não de uma lista escrita à mão.
   *
   * A primeira versão listava dois arquivos e havia quatro que gravam
   * `PAYMENT_ANOMALY` — uma lista de lugares a censar tem o mesmo modo de
   * falha que a lista de espécies que o censo veio substituir.
   */
  function arquivosQueGravamAnomalia() {
    const achados = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '__tests__'].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')
          && /PAYMENT_ANOMALY|PAYMENT_DISPUTE_CLOSED/.test(fs.readFileSync(full, 'utf8'))) {
          achados.push(path.relative(raiz, full));
        }
      }
    }(raiz));
    return achados;
  }

  test('todo append EXTRA de uma mesma entrega usa chave com sufixo', () => {
    const arquivos = arquivosQueGravamAnomalia();
    // Quatro hoje: o portão, a rota, o tratador de não-lançáveis e a
    // conciliação. Se a varredura devolver menos, ela quebrou.
    expect(arquivos.length).toBeGreaterThanOrEqual(4);
    const semSufixo = [];
    for (const rel of arquivos) {
      semSufixo.push(...varrerChaves(rel, fs.readFileSync(path.join(raiz, rel), 'utf8')));
    }
    expect(semSufixo).toEqual([]);
  });

  /**
   * O SCANNER, extraído — porque a prova de que ele enxerga é rodá-lo.
   *
   * A versão anterior desta prova era `expect(fonte).toMatch(/:out_of_order`/)`:
   * ela afirmava a GRAFIA de duas chaves de hoje pra mostrar que o censo não
   * estava cego. Testar grafia é o que morre primeiro — o dia em que as chaves
   * passaram a sair de um ajudante (`gritar(chave, …)`), as duas grafias
   * sumiram do arquivo, o censo continuou correto e a prova dele quebrou. Pior
   * seria o contrário: as grafias ficarem e o censo quebrar.
   */
  function varrerChaves(rel, src) {
    // Appends de ANOMALIA e de FECHO: os dois tipos que acompanham outro
    // lançamento na mesma entrega. O lançamento principal usa a chave pura,
    // e é assim que tem que ser.
    const alvos = [/PAYMENT_ANOMALY[\s\S]{0,600}?\}\s*,\s*([^)]*)\)/g,
      /PAYMENT_DISPUTE_CLOSED[\s\S]{0,300}?\}\s*,\s*([^)]*)\)/g];
    const fora = [];
    for (const re of alvos) {
      for (const m of src.matchAll(re)) {
        const chave = m[1];
        if (!/eventId/.test(chave)) continue;      // não passa evento: nada a conferir
        if (!/`\$\{[^}]*eventId[^}]*\}:/.test(chave)) {
          fora.push(`${rel}: ${chave.trim().slice(0, 60)}`);
        }
      }
    }
    return fora;
  }

  test('o censo ENXERGA — medido sobre fontes sintéticas, não pela grafia', () => {
    // A chave PURA é o defeito: ela queima a idempotência do próprio evento.
    const cru = `await appendEvent(id, 'PAYMENT_ANOMALY', { txid, reason: 'x' }, parsed.eventId);`;
    expect(varrerChaves('falso.js', cru).length).toBe(1);
    // Com sufixo, literal — a forma antiga.
    const literal = 'await appendEvent(id, \'PAYMENT_ANOMALY\', { txid, reason: \'x\' }, `${parsed.eventId}:out_of_order`);';
    expect(varrerChaves('falso.js', literal)).toEqual([]);
    // Com sufixo VINDO DE VARIÁVEL — a forma de hoje, que a prova por grafia
    // não conseguia ver.
    const ajudante = 'await appendEvent(id, \'PAYMENT_ANOMALY\', { txid, reason }, `${parsed.eventId}:${chave}`);';
    expect(varrerChaves('falso.js', ajudante)).toEqual([]);
    // E uma chave que nem passa o evento continua fora do censo.
    const semEvento = `await appendEvent(id, 'PAYMENT_ANOMALY', { txid, reason: 'x' }, null);`;
    expect(varrerChaves('falso.js', semEvento)).toEqual([]);
  });
});
