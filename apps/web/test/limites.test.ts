import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITES } from '../src/limites.ts';

/**
 * O MESMO NÚMERO EM TRÊS RUNTIMES.
 *
 * O limite do nome da casa, do rótulo da mesa e da cidade vive em três lugares
 * que não compartilham módulo: o servidor (`api/_lib/texto-da-casa.js`,
 * CommonJS), o formulário do dono (`apps/web/src/limites.ts`, TS/ESM) e o CHECK
 * da migração 0035 (SQL). A fonte é o JSON; estes testes são o que impede a
 * cópia de envelhecer.
 *
 * Não é hipótese: o campo do nome nasceu com `maxLength={60}` escrito à mão,
 * contra um servidor que aceitava outro número. Cliente mais apertado que o
 * servidor não vaza nada — mas é uma regra escrita duas vezes, e é assim que a
 * segunda envelhece até inverter.
 */
const RAIZ = join(import.meta.dirname, '..', '..', '..');
const JSON_DOS_LIMITES = join(RAIZ, 'api', '_lib', 'limites-da-casa.json');

test('o cliente usa os números do JSON — não os dele', () => {
  const doJson = JSON.parse(readFileSync(JSON_DOS_LIMITES, 'utf8'));
  for (const chave of ['nomeDaCasa', 'rotuloDaMesa', 'cidade'] as const) {
    assert.equal(LIMITES[chave], doJson[chave], `${chave}: cliente ${LIMITES[chave]} × fonte ${doJson[chave]}`);
  }
  // O censo tem que ver os três: um JSON vazio daria ✓ sobre nada.
  assert.equal(Object.keys(LIMITES).length, 3);
});

test('o CHECK da migração usa os mesmos números', () => {
  const dir = join(RAIZ, 'supabase', 'migrations');
  const sql = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  for (const [restricao, max] of [
    ['venues_name_len', LIMITES.nomeDaCasa],
    ['venues_city_len', LIMITES.cidade],
    ['venue_tables_label_len', LIMITES.rotuloDaMesa],
  ] as const) {
    const m = sql.match(new RegExp(`${restricao}[\\s\\S]{0,200}?between 1 and (\\d+)`));
    assert.ok(m, `${restricao}: nenhum CHECK encontrado nas migrações`);
    assert.equal(Number(m[1]), max, `${restricao}: banco ${m[1]} × cliente ${max}`);
  }
});

test('o formulário do dono lê a constante, não um número solto', () => {
  const admin = readFileSync(join(import.meta.dirname, '..', 'src', 'Admin.tsx'), 'utf8');
  // Os três campos que o servidor confere — cada um com o seu limite nomeado.
  for (const nome of ['LIMITES.nomeDaCasa', 'LIMITES.cidade', 'LIMITES.rotuloDaMesa']) {
    assert.ok(admin.includes(`maxLength={${nome}}`), `Admin.tsx: faltou maxLength={${nome}}`);
  }
  // E nenhum `maxLength` com número cru nos campos de texto da casa: é assim
  // que a quarta cópia nasce.
  const crus = [...admin.matchAll(/maxLength=\{(\d+)\}/g)].map((m) => m[1]);
  assert.deepEqual(crus, [], `Admin.tsx: maxLength com número solto: ${crus}`);
});
