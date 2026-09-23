'use strict';

/**
 * FECHAR E AJUSTAR NÃO GRAVAM SOBRE UM ESTADO VELHO.
 *
 * `closeCheck` e `adjustCheck` liam o razão e gravavam com nada no meio. A
 * auditoria do painel mediu 3–4 s entre o toque em "fechar" e a tela mudar, com
 * o botão ativo o tempo todo: dois toques gravavam DOIS `CLOSED` (o livro de
 * abertos tinha medido a mesma coisa com dois `closeCheck` concorrentes). Agora
 * o lançamento é condicional ao `seq` lido (`appendEventIfUnchanged`).
 */

const { createMemoryStore } = require('../_lib/store/memory');
const { createCheckService } = require('../_lib/checks/check-service');

async function mesa() {
  const store = createMemoryStore();
  const venue = store.seedVenue({ name: 'Casa', servicoBp: 1000 });
  const table = store.seedTable(venue.id, 'Mesa 1');
  const svc = createCheckService({ store });
  const aberta = await svc.openCheck({ tableId: table.id, totalCents: 5000 });
  return { store, svc, checkId: aberta.checkId };
}

// As duas chamadas LEEM antes de qualquer uma gravar: a gravação espera um
// pouco — só na fronteira do store, como numa rede de verdade.
function comLatencia(store, ms = 20) {
  const original = store.appendEventIfUnchanged.bind(store);
  store.appendEventIfUnchanged = async (...args) => { await new Promise((r) => setTimeout(r, ms)); return original(...args); };
}

test('dois toques em "fechar" → UM `CLOSED`, com o motivo do dono — e os dois respondem que fechou', async () => {
  const { store, svc, checkId } = await mesa();
  comLatencia(store);
  const r = await Promise.all([svc.closeCheck({ checkId }), svc.closeCheck({ checkId })]);
  expect(r).toEqual([{ checkId, status: 'fechada' }, { checkId, status: 'fechada' }]);
  const fechamentos = (await store.loadEvents(checkId)).filter((e) => e.type === 'CLOSED');
  expect(fechamentos).toHaveLength(1);
  expect(fechamentos[0].payload).toEqual({ motivo: 'dono' });
});

test('fechar uma conta JÁ fechada, à mão, continua sendo erro (400) — não um sucesso silencioso', async () => {
  const { svc, checkId } = await mesa();
  await svc.closeCheck({ checkId });
  await expect(svc.closeCheck({ checkId })).rejects.toMatchObject({ statusCode: 400 });
});

test('ajuste cruzado com um pagamento: o ajuste relê e grava sobre o estado NOVO', async () => {
  const { store, svc, checkId } = await mesa();
  // O pagamento entra entre a leitura do ajuste e a gravação dele.
  const original = store.appendEventIfUnchanged.bind(store);
  let uma = true;
  store.appendEventIfUnchanged = async (...args) => {
    if (uma) { uma = false; await store.appendEvent(checkId, 'PAYMENT_CONFIRMED', { txid: 'tx1', amountCents: 1000, tipCents: 0, method: 'pix' }); }
    return original(...args);
  };
  const r = await svc.adjustCheck({ checkId, totalCents: 6000 });
  expect(r.totalCents).toBe(6000);
  const tipos = (await store.loadEvents(checkId)).map((e) => e.type);
  expect(tipos).toEqual(['OPENED', 'PAYMENT_CONFIRMED', 'ADJUSTED']);
});

test('um conflito que não passa em TENTATIVAS vira 409 `check_changed` — não um lançamento às cegas', async () => {
  const { store, svc, checkId } = await mesa();
  store.appendEventIfUnchanged = async () => { const e = new Error('o razão mudou'); e.pgCode = '40001'; throw e; };
  await expect(svc.closeCheck({ checkId })).rejects.toMatchObject({ statusCode: 409, code: 'check_changed' });
  expect((await store.loadEvents(checkId)).map((e) => e.type)).toEqual(['OPENED']);
});

test('um erro que NÃO é conflito sobe como está', async () => {
  const { store, svc, checkId } = await mesa();
  store.appendEventIfUnchanged = async () => { throw new Error('banco caiu'); };
  await expect(svc.closeCheck({ checkId })).rejects.toThrow('banco caiu');
});

test('o censo: nenhuma escrita de CLOSED/ADJUSTED é incondicional', () => {
  // O livro de abertos pediu: toda escrita de `CLOSED`/`ADJUSTED` passa pelo
  // `appendEventIfUnchanged`. A demo e o serviço de conta são as duas.
  const fs = require('node:fs');
  const path = require('node:path');
  const RAIZ = path.join(__dirname, '..');
  const arquivos = [];
  (function andar(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) andar(f); else if (f.endsWith('.js')) arquivos.push(f);
    }
  }(RAIZ));
  const sujos = [];
  for (const f of arquivos) {
    const codigo = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/\bappendEvent\([^)]*'(CLOSED|ADJUSTED)'/.test(codigo)) sujos.push(path.relative(RAIZ, f));
  }
  expect(sujos).toEqual([]);
  // O serviço de conta monta o tipo numa variável — então ele não pode ter
  // `appendEvent(` NENHUM: toda gravação dele é condicional.
  const svc = fs.readFileSync(path.join(RAIZ, '_lib', 'checks', 'check-service.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(svc).not.toMatch(/\bstore\.appendEvent\(/);
  expect(svc).toMatch(/store\.appendEventIfUnchanged\(/);
});
