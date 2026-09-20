/**
 * Deploy do racha@origin/main na Vercel via REST API (gitSource).
 *
 * Por que existe: o projeto Vercel NÃO tem a integração Git conectada — push
 * no GitHub não cria deployment (descoberto em 2026-07-21; os deploys
 * anteriores já eram via API). Até alguém conectar o repo no dashboard
 * (Settings → Git), o caminho de ship é:
 *
 *   git push origin main && node scripts/deploy.mjs
 *
 * Token: o do Vercel CLI local (%APPDATA%/com.vercel.cli/Data/auth.json),
 * renovado automaticamente via refresh_token quando expirado (mesmo fluxo
 * OAuth do CLI, client_id público do bundle). Nenhum token é impresso.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import impressao0033 from '../api/_lib/store/impressao-0033.js';

const PROJECT_ID = 'prj_9g4oNf6HoNUnJFAPD53NJ0CH08O1';
const TEAM_ID = 'team_0OAVq8O0WIyi5FXT8Bgoxvnx';
const OAUTH_CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp'; // público (bundle do CLI)
const REPO = 'stefanogebara/racha';

// `APPDATA` só existe no Windows, e sem ele o caminho resolvia RELATIVO ao cwd:
// o `loadToken()` estourava ENOENT na máquina que publica este repositório,
// antes de qualquer outra coisa. Achado pela revisão de segurança de 2026-09-14.
const authBase = process.env.APPDATA
  || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')));
const authPath = path.join(authBase, 'com.vercel.cli/Data/auth.json');

async function loadToken() {
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const validoAte = (auth.expiresAt ?? 0) * 1000;
  if (validoAte > Date.now() + 60_000) return auth.token;

  if (!auth.refreshToken) throw new Error('token expirado e sem refreshToken — rode `vercel login`');
  const disc = await (await fetch('https://vercel.com/.well-known/openid-configuration')).json();
  const res = await fetch(disc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`refresh do token falhou (${res.status}: ${json.error || '?'}) — rode \`vercel login\``);
  }
  fs.writeFileSync(authPath, JSON.stringify({
    ...auth,
    token: json.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600),
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
  }, null, 2));
  console.log('token renovado');
  return json.access_token;
}

const token = await loadToken();
const headers = { Authorization: `Bearer ${token}` };

const repoId = Number(execFileSync('gh', ['api', `repos/${REPO}`, '--jq', '.id']).toString().trim());
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// O CANÁRIO DO `CRON_SECRET` MORA AQUI, e ANTES do deploy.
//
// A rota `/api/cron/reconcile` fecha sem o segredo e grita no log, mas quem
// PAGINAVA era ela — do ramo em que, por definição, não há autenticação: o ramo
// do segredo ausente. Um `curl` anônimo em N conexões forçava N cold starts e
// rendia N avisos, porque o throttle era estado de módulo numa função
// serverless. Aqui a pergunta é feita por quem está fazendo o deploy, com o
// token do projeto, e ninguém de fora pode acioná-la.
//
// E ANTES, não depois: a primeira versão deste bloco ficava no FIM do arquivo,
// abaixo de um `process.exit` em todos os caminhos do laço de polling. Era
// código inalcançável — o pager tinha sido tirado da rota e posto numa linha
// que nunca roda, o que deixou o inegociável #8 sem canário nenhum por um
// commit inteiro. Achado pela revisão de segurança de 2026-09-14. Aqui ele
// também IMPEDE o deploy em vez de reclamar depois de a produção já estar no ar.
//
// Falha FECHADO: um 401 ou 403 devolve JSON sem `envs`, `temCronSecret` vira
// false e o script sai com 1.
const envs = await (await fetch(
  `https://api.vercel.com/v9/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}`, { headers },
)).json();
const temCronSecret = (envs.envs || []).some(
  (e) => e.key === 'CRON_SECRET' && (e.target || []).includes('production'),
);
if (!temCronSecret) {
  process.stderr.write(
    '\n✗ CRON_SECRET NÃO ESTÁ CONFIGURADO em production — deploy ABORTADO.\n'
    + '  A conciliação diária (inegociável #8) não roda sem ele: a rota fecha em 503.\n'
    + '  Configure em https://vercel.com/dashboard → Settings → Environment Variables.\n',
  );
  process.exit(1);
}
process.stdout.write('✓ CRON_SECRET configurado em production\n');

// O SEGREDO DA PONTE. Sem `RACHA_NOTIFY_SECRET` todo aviso ao fundador — o
// canário da conciliação (inegociável #8), o teto disparado, a RPC ausente —
// vira uma linha de stderr que ninguém lê. (Compliance, M3.)
if (!(envs.envs || []).some((e) => e.key === 'RACHA_NOTIFY_SECRET' && (e.target || []).includes('production'))) {
  process.stderr.write('\n✗ RACHA_NOTIFY_SECRET NÃO ESTÁ CONFIGURADO em production — deploy ABORTADO.\n'
    + '  Sem ele nenhum canário pagina: a conciliação, o teto e a RPC ausente só escrevem no log.\n');
  process.exit(1);
}
process.stdout.write('✓ RACHA_NOTIFY_SECRET configurado em production\n');

// A LOJA E O ADQUIRENTE DE VERDADE. Sem `RACHA_STORE=supabase` a produção grava
// no mapa em memória de uma instância; sem `RACHA_PSP=pagarme`, casa de verdade
// recebe BR Code de mentira (auditoria de backend C1). A API recusa as rotas de
// dinheiro nos dois casos — e o deploy nem começa. Os valores não são segredo:
// dá pra dizer qual está errado.
// `RACHA_ENV` entra na lista porque o portão do runtime não pode depender das
// variáveis de SISTEMA da Vercel: `VERCEL` e `VERCEL_ENV` saem da mesma chave do
// projeto, e com ela desligada o router não tinha como saber que estava em
// produção (segurança HIGH-1 de ec86b37). Agora o ambiente é nosso, e é aqui que
// se exige que ele esteja lá.
for (const [chave, esperado] of [['RACHA_STORE', 'supabase'], ['RACHA_PSP', 'pagarme'], ['RACHA_ENV', 'production']]) {
  const env = (envs.envs || []).find((e) => e.key === chave && (e.target || []).includes('production'));
  let valor = null;
  if (env && env.id) {
    const det = await fetch(`https://api.vercel.com/v1/projects/${PROJECT_ID}/env/${env.id}?teamId=${TEAM_ID}`, { headers })
      .then((r) => r.json()).catch(() => ({}));
    // CRU, sem `.trim()`. O valor colado com um espaço é um ERRO a corrigir no
    // painel, não algo a acomodar em silêncio: a rodada ec86b37 mostrou o que
    // acontece quando um lado tolera o espaço e o outro não — portão verde,
    // adaptador de mentira, casa de verdade cobrando (CRITICAL-1). Todos os
    // leitores normalizam hoje; ainda assim, o certo é o valor estar certo.
    valor = det && typeof det.value === 'string' ? det.value : null;
  }
  if (valor !== esperado) {
    const comEspaco = typeof valor === 'string' && valor.trim() === esperado;
    process.stderr.write(`\n✗ ${chave} em production está ${valor === null ? 'AUSENTE' : `"${valor}"`}, e precisa ser "${esperado}"${comEspaco ? ' — há ESPAÇO sobrando no valor colado' : ''} — deploy ABORTADO.\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${chave}=${esperado} em production\n`);
}

// O CANÁRIO DO ESQUEMA — "migração primeiro" deixa de ser uma frase.
//
// O teto de cobranças mora numa RPC (`claim_slots`, migração 0033) e o store
// falha FECHADO sem ela: com o código novo no ar e a 0033 não aplicada, todo
// `/api/pay`, `/api/pay/stripe-intent` e `/api/house/load` devolve 500 e
// NINGUÉM PAGA. Isso está certo — degradar aberto foi o que mascarou doze dias
// de falha na Seatable (inegociável #7) —, mas quem ouvia era o restaurante.
//
// A primeira versão fazia UMA pergunta ("a função existe?"), e as duas revisões
// de 2026-09-15 mostraram as outras duas que faltavam:
//
//  1. o banco sondado é o de PRODUÇÃO? O endereço vinha do `.env`, e um `.env`
//     apontando pra staging passava a sonda enquanto produção não tinha a RPC.
//     Agora o host do `.env` tem de ser o do `SUPABASE_URL` de produção na
//     Vercel, lido pelo id da variável (só ela é decifrada, não o resto);
//  2. a versão aplicada é ESTA? A 0033 foi editada no lugar, e um banco com a
//     versão anterior respondia à mesma sonda. A segunda sonda pedia um
//     COMPORTAMENTO (limite nulo recusado com 22023) que a versão anterior
//     também tinha: a revisão de segurança de 7a65e93 aplicou a 0033 velha e a
//     sonda passou (M2). Agora ela lê a IMPRESSÃO DIGITAL do texto das funções
//     do teto (`charge_slots_fingerprint`) e exige a de
//     `api/_lib/store/impressao-0033.js` — que o `sql-teto-vivo` recalcula;
//  3. e o PUSH só depois das duas — antes, um "deploy ABORTADO" deixava o `main`
//     remoto já carregando o código que exige a 0033.
const envLocal = (() => {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(repoRoot, '.env'), 'utf8').split(/\r?\n/)
      .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  } catch { return {}; }
})();
const SB_URL = process.env.SUPABASE_URL || envLocal.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || envLocal.SUPABASE_SERVICE_ROLE_KEY;
const aborta = (msg) => { process.stderr.write(`\n✗ ${msg}\n  Deploy ABORTADO — nada foi publicado nem empurrado.\n`); process.exit(1); };
if (!SB_URL || !SB_KEY) aborta('sem SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ambiente ou .env): não dá pra conferir a migração 0033.');
const hostDe = (u) => { try { return new URL(u).host; } catch { return null; } };
const hostSondado = hostDe(SB_URL);
const envSupa = (envs.envs || []).find((e) => e.key === 'SUPABASE_URL' && (e.target || []).includes('production'));
let hostProducao = null;
if (envSupa && envSupa.id) {
  const det = await fetch(`https://api.vercel.com/v1/projects/${PROJECT_ID}/env/${envSupa.id}?teamId=${TEAM_ID}`, { headers })
    .then((r) => r.json()).catch(() => ({}));
  hostProducao = hostDe(det && det.value);
}
if (!hostProducao) aborta('não deu pra ler o SUPABASE_URL de PRODUÇÃO na Vercel — sem ele não dá pra saber se o .env aponta pro banco certo.');
if (hostProducao !== hostSondado) aborta(`o .env aponta pra ${hostSondado}, mas produção é ${hostProducao}.`);
const { IMPRESSAO_0033 } = impressao0033;
const sonda = await fetch(`${SB_URL}/rest/v1/rpc/charge_slots_fingerprint`, {
  method: 'POST',
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
}).catch((e) => ({ status: 0, text: async () => String(e && e.message) }));
const corpoSonda = String(await sonda.text()).trim();
let impressaoSondada = null;
try { impressaoSondada = JSON.parse(corpoSonda); } catch { /* corpo não-JSON */ }
if (sonda.status !== 200 || impressaoSondada !== IMPRESSAO_0033) {
  aborta(`a migração 0033 ATUAL não está aplicada em ${hostSondado} (impressão → ${sonda.status} ${corpoSonda.slice(0, 140)}; esperada "${IMPRESSAO_0033}").\n`
    + '  Aplique supabase/migrations/0033_charge_slots.sql PRIMEIRO, pelo arquivo, com psql -f — o supabase db push pula uma versão já\n'
    + '  registrada, e esta migração foi editada no lugar. Sem ela todo pagamento devolve 500; com uma versão anterior o expurgo e as\n'
    + '  guardas são os de antes. Editor que mexe em espaço em branco muda a impressão (o .gitattributes fixa LF nas migrações).');
}
process.stdout.write(`✓ migração 0033 atual aplicada em ${hostSondado}, que é o banco de produção (impressão ${IMPRESSAO_0033.slice(0, 8)})\n`);

// O gitSource deploya o que está no GitHub — então garante que o commit local
// já subiu (evita o tropeço de "commit && deploy" sem push no meio, que deploya
// o commit ANTERIOR). Push é no-op se já estiver em dia.
execFileSync('git', ['-C', repoRoot, 'push', 'origin', 'HEAD:main'], { stdio: 'inherit' });
const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'origin/main']).toString().trim();
console.log(`deployando ${REPO}@${sha.slice(0, 8)}`);

const createRes = await fetch(`https://api.vercel.com/v13/deployments?teamId=${TEAM_ID}&skipAutoDetectionConfirmation=1`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'racha',
    project: PROJECT_ID,
    target: 'production',
    gitSource: { type: 'github', repoId, ref: 'main', sha },
  }),
});
if (!createRes.ok) {
  console.error(`create falhou: ${createRes.status} ${(await createRes.text()).slice(0, 400)}`);
  process.exit(1);
}
const created = await createRes.json();
console.log(`deploy: ${created.id}`);

const start = Date.now();
let lastState = '';
while (Date.now() - start < 5 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await (await fetch(`https://api.vercel.com/v13/deployments/${created.id}?teamId=${TEAM_ID}`, { headers })).json();
  if (st.readyState !== lastState) { console.log(`state: ${st.readyState}`); lastState = st.readyState; }
  if (st.readyState === 'READY') { console.log(`✅ READY https://${st.url}`); process.exit(0); }
  if (st.readyState === 'ERROR' || st.readyState === 'CANCELED') {
    console.error(`❌ ${st.readyState}: ${st.errorMessage || ''}`); process.exit(1);
  }
}
console.error('timeout aguardando READY');
process.exit(1);
