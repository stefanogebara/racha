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

  test('toda coluna que o predicado LÊ tem um escritor ALCANÇÁVEL', () => {
    // O censo que teria pego o buraco — e a primeira versão DELE também estava
    // errada, o que é apropriado. Ela perguntava "esta palavra aparece em
    // algum lugar do `api/`?", e `active` aparece: em status de recebedor, em
    // mesa de demo, no próprio store. Passava verde com o predicado morto.
    //
    // A pergunta certa é mais estreita: o método do STORE que escreve esta
    // coluna é chamado por alguém que não seja teste? `setHouseAccountActive`
    // existe nos dois stores e tem exatamente um chamador no repositório
    // inteiro — um teste. A coluna nasce `true` e nada a vira, então o telefone
    // do cliente ficaria pra sempre (a falha que a migração diz fechar) e a
    // contagem reportaria zero, que é o que o doc manda ler como "o job parou".
    //
    // Um predicado cuja satisfatibilidade depende de feature não implementada é
    // uma frase, não um guarda.
    const corpo = SQL.slice(SQL.indexOf('purge_expired_personal_data('), SQL.indexOf('$$;'));
    const colunas = new Set();
    for (const m of corpo.matchAll(/\b(?:a|p|c|l|e)\.(\w+)\s*(?:=|<|>|is )/g)) colunas.add(m[1]);

    // O banco mantém estas sozinho: nascem preenchidas e mudam por si.
    const MANTIDAS_PELO_BANCO = new Set(['created_at', 'updated_at', 'closed_at', 'expires_at',
      'at', 'check_id', 'account_id', 'id', 'status', 'remaining_cents', 'principal_cents']);
    const alvos = [...colunas].filter((c) => !MANTIDAS_PELO_BANCO.has(c));
    expect(alvos.length).toBeGreaterThan(0);

    const memoria = fs.readFileSync(path.join(RAIZ, 'api', '_lib', 'store', 'memory.js'), 'utf8');
    const linhas = memoria.split('\n');

    /**
     * TODOS os métodos do store que atribuem esta coluna — não o primeiro.
     *
     * Pegar o primeiro foi o erro da versão anterior deste censo: `active` é
     * escrita por `setTableActive` (mesa, alcançável por rota) e por
     * `setHouseAccountActive` (carteira, sem chamador nenhum). O primeiro match
     * era o alcançável, e o censo passava verde sobre o predicado morto — o
     * mesmo erro que ele existe pra pegar, dentro dele. Se um método que
     * escreve a coluna não tem chamador, a coluna não serve de chave: ou é
     * outra entidade, ou é código morto, e nos dois casos o predicado depende
     * de algo que ninguém produz.
     */
    function metodosQueEscrevem(col) {
      const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const achados = new Set();
      for (let i = 0; i < linhas.length; i += 1) {
        if (!new RegExp(`\\.(?:${col}|${camel})\\s*=[^=]`).test(linhas[i])) continue;
        for (let j = i; j >= 0; j -= 1) {
          const m = linhas[j].match(/^\s*async (\w+)\s*\(/);
          if (m) { achados.add(m[1]); break; }
        }
      }
      return [...achados];
    }

    // Todo `api/` menos os stores e os testes, MAIS `scripts/`: um instrumento
    // de operação é um chamador de verdade tanto quanto uma rota. Foi assim que
    // este censo pegou o `erasePaymentLabel`, que existia no store e no SQL e
    // não tinha como ser invocado por ninguém — art. 18 com instrumento
    // inalcançável é o mesmo que sem instrumento.
    const chamadores = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!/^(node_modules|__tests__|store)$/.test(e.name)) walk(full); }
        else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) chamadores.push(fs.readFileSync(full, 'utf8'));
      }
    }(path.join(RAIZ, 'api')));
    (function walkScripts(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkScripts(full);
        else if (/\.(js|mjs)$/.test(e.name)) chamadores.push(fs.readFileSync(full, 'utf8'));
      }
    }(path.join(RAIZ, 'scripts')));
    const codigo = chamadores.join('\n');

    const mortas = alvos.filter((col) => {
      const metodos = metodosQueEscrevem(col);
      // Sem método que escreva: ou é derivada, ou o predicado lê algo que nada
      // produz. Nos dois casos não serve de chave.
      if (metodos.length === 0) return true;
      return metodos.some((m) => !new RegExp(`\\b${m}\\b`).test(codigo));
    });
    expect(mortas).toEqual([]);
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
