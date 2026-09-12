'use strict';

/**
 * O prazo que o aviso PROMETE é o prazo que o job CUMPRE.
 *
 * A tela da conta diz ao cliente, em três idiomas, que o nome dele some 90 dias
 * depois de a conta fechar. Isso é uma promessa feita a um consumidor no
 * momento de pagar (art. 9º da LGPD, art. 6º III do CDC) — e é exatamente a
 * forma de erro que este repositório passou cinco rodadas de revisão
 * aprendendo a não cometer: uma frase sobre uma garantia, escrita a partir da
 * garantia que se estava olhando, sem nada que as amarre.
 *
 * Então elas ficam amarradas. Mudar o padrão da função SQL sem mudar o texto
 * (ou o contrário) derruba a suíte.
 */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(
  path.join(RAIZ, 'supabase', 'migrations', '0031_retention_purge.sql'), 'utf8');
const I18N = fs.readFileSync(path.join(RAIZ, 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
const DOC = fs.readFileSync(path.join(RAIZ, 'docs', 'compliance', 'retencao.md'), 'utf8');

describe('retenção: o prazo prometido é o prazo executado', () => {
  test('o padrão da função SQL é o número que o aviso diz ao cliente', () => {
    const padrao = SQL.match(/p_label_days integer default (\d+)/);
    expect(padrao).toBeTruthy();
    const dias = Number(padrao[1]);
    expect(dias).toBeGreaterThan(0);

    // As três traduções da frase do nome livre. Todas têm que citar o mesmo
    // número — um aviso que promete 90 em inglês e 30 em espanhol é duas
    // promessas diferentes pra mesma pessoa dependendo do idioma do telefone.
    const bloco = I18N.slice(I18N.indexOf("'priv.what1':"), I18N.indexOf("'priv.what2':"));
    expect(bloco.length).toBeGreaterThan(0);
    const citados = [...bloco.matchAll(/(\d+)\s*(?:days|dias|días)/gi)].map((m) => Number(m[1]));
    expect(citados.length).toBe(3);
    for (const n of citados) expect(n).toBe(dias);

    // E a política escrita bate com os dois.
    expect(DOC).toContain(`**${dias} dias**`);
  });

  test('a purga ANONIMIZA e não apaga pagamento — o razão é imutável', () => {
    // Apagar a linha de pagamento destruiria a contabilidade da casa. O que sai
    // é o dado pessoal; o fato de que houve pagamento fica.
    expect(SQL).toMatch(/update public\.payments[\s\S]*?set payer_label = null/);
    expect(SQL).not.toMatch(/delete\s+from\s+public\.payments/i);
    expect(SQL).not.toMatch(/delete\s+from\s+public\.check_events/i);
  });

  test('só toca conta FECHADA — conta aberta ainda mostra quem pagou o quê', () => {
    const bloco = SQL.slice(SQL.indexOf('update public.payments'), SQL.indexOf('get diagnostics v_labels'));
    expect(bloco).toMatch(/c\.status = 'fechada'/);
    expect(bloco).toMatch(/c\.closed_at is not null/);
  });

  test('prazo curto demais é erro, não silêncio', () => {
    // Roda por cron: um parâmetro errado apagaria dado vivo sem ninguém ver.
    expect(SQL).toMatch(/raise exception 'purge_expired_personal_data: prazo curto demais/);
  });

  test('a rota do cron existe, é protegida, e devolve a contagem', () => {
    const router = fs.readFileSync(path.join(RAIZ, 'api', '_app', 'router.js'), 'utf8');
    const rota = router.slice(
      router.indexOf("url.pathname === '/api/cron/retention'"),
      router.indexOf("url.pathname === '/api/cron/activation-radar'"),
    );
    expect(rota.length).toBeGreaterThan(0);
    expect(rota).toMatch(/segredoConfere\(req\.headers\.authorization, process\.env\.CRON_SECRET\)/);
    expect(rota).toMatch(/purgeExpiredPersonalData/);
    // A contagem sai no log: zero por muitos dias é sinal de que parou de
    // rodar, não de que não havia o que apagar.
    expect(rota).toMatch(/\[retencao\]/);

    const vercel = JSON.parse(fs.readFileSync(path.join(RAIZ, 'vercel.json'), 'utf8'));
    expect((vercel.crons || []).some((c) => c.path === '/api/cron/retention')).toBe(true);
  });
});
