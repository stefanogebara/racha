'use strict';

/**
 * O AUTH É DO PRÓPRIO RACHA — no servidor também (compliance, PR #22, H1).
 *
 * O router conferia o token contra `AUTH_SUPABASE_URL || SUPABASE_URL`: com a
 * env do login compartilhado esquecida na Vercel, todo token novo do Racha seria
 * recusado e os do Seatable seguiriam abrindo as casas antigas. O desvio saiu do
 * código; a env esquecida só grita.
 */
const fs = require('node:fs');
const path = require('node:path');
const RAIZ = path.join(__dirname, '..', '..');

test('o router confere o token SÓ contra o projeto dos dados', () => {
  const router = fs.readFileSync(path.join(RAIZ, 'api', '_app', 'router.js'), 'utf8');
  expect(router).toMatch(/const AUTH_SUPABASE_URL = process\.env\.SUPABASE_URL;/);
  expect(router).toMatch(/const AUTH_SUPABASE_KEY = process\.env\.SUPABASE_SERVICE_ROLE_KEY;/);
  expect(router).not.toMatch(/= process\.env\.AUTH_SUPABASE_URL \|\|/);
  expect(router).not.toMatch(/= process\.env\.AUTH_SUPABASE_KEY \|\|/);
});

test('env esquecida do login compartilhado GRITA no boot', () => {
  const linhas = [];
  const espiao = jest.spyOn(process.stderr, 'write').mockImplementation((s) => { linhas.push(String(s)); return true; });
  const antes = process.env.AUTH_SUPABASE_URL;
  process.env.AUTH_SUPABASE_URL = 'https://ckforlwdhewexyqljsaf.supabase.co';
  try {
    jest.isolateModules(() => { require('../_app/router'); });
  } finally {
    if (antes === undefined) delete process.env.AUTH_SUPABASE_URL; else process.env.AUTH_SUPABASE_URL = antes;
    espiao.mockRestore();
  }
  expect(linhas.some((l) => l.startsWith('[auth] AUTH_SUPABASE_URL/KEY estão definidas e são IGNORADAS'))).toBe(true);
});

test('nada fora do web aponta mais pro Seatable como auth: .env.example e o preflight', () => {
  for (const f of ['.env.example', path.join('scripts', 'preflight-live.mjs'), path.join('scripts', 'split-smoke-live.mjs')]) {
    const src = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    expect([f, /AUTH_SUPABASE_URL=https:\/\/ckforlwdhewexyqljsaf/.test(src)]).toEqual([f, false]);
    expect([f, /env\.AUTH_SUPABASE_URL \|\|/.test(src)]).toEqual([f, false]);
  }
});

test('sem auth, o 501 leva CÓDIGO — a tela do dono não mostra o português cru', () => {
  const router = fs.readFileSync(path.join(RAIZ, 'api', '_app', 'router.js'), 'utf8');
  expect(router).toMatch(/if \(!auth\) \{ json\(res, 501, \{[^}]*code: 'auth_unavailable'/);
});

// A conta demo do dev-server nascia com senha FIXA num repositório público — e
// o dev-server já rodou contra o projeto de produção (5 casas `is_test=false`
// com dono `dono@bardoze.demo`). Senha tem que ser sorteada a cada subida.
test('o dev-server não tem senha fixa pra conta demo', () => {
  const dev = fs.readFileSync(path.join(RAIZ, 'dev-server.js'), 'utf8');
  expect(dev).toMatch(/const DEMO_PASS = `demo-\$\{crypto\.randomBytes\(\d+\)/);
  expect(dev).not.toMatch(/const DEMO_PASS = ['"]/);
});
