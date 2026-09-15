'use strict';

/**
 * O BOTÃO DE SIMULAR A CONFIRMAÇÃO DO BANCO SÓ NA CASA DE DEMONSTRAÇÃO.
 *
 * "✓ Simular confirmação do banco (demo)" aparecia pra todo cliente de verdade,
 * embaixo do Pix de verdade — a flag que o escondia começava falsa e só virava
 * depois de um toque devolver 404 (auditorias de fluxo H2 e de UI H3). A mesa
 * ficava perguntando se aquilo era teste, ou tocava.
 */

const fs = require('node:fs');
const path = require('node:path');

const ler = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

test('a conta e a carteira só mostram o botão com a casa marcada como demo', () => {
  expect(ler('apps', 'web', 'src', 'App.tsx')).toMatch(/\{venue\.demo === true && !demoGone && \(/);
  expect(ler('apps', 'web', 'src', 'Wallet.tsx')).toMatch(/\{venue\.demo === true && !demoGone && \(/);
});

test('a carteira recebe a marca da CASA, decidida pelo `isDemoVenue` — não pelo token', () => {
  expect(ler('api', '_lib', 'house', 'house-service.js')).toMatch(/venue: \{ name: venue \? venue\.name : '\?', demo: isDemoVenue\(venue\) \}/);
  const { isDemoVenue } = require('../_lib/demo');
  expect(isDemoVenue({ isTest: true, pspRecipientId: 'rcpt_demo' })).toBe(true);
  expect(isDemoVenue({ isTest: false, pspRecipientId: 're_real' })).toBe(false);
});
