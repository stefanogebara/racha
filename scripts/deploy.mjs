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
// O gitSource deploya o que está no GitHub — então garante que o commit local
// já subiu (evita o tropeço de "commit && deploy" sem push no meio, que deploya
// o commit ANTERIOR). Push é no-op se já estiver em dia.
execFileSync('git', ['-C', repoRoot, 'push', 'origin', 'HEAD:main'], { stdio: 'inherit' });
const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'origin/main']).toString().trim();
console.log(`deployando ${REPO}@${sha.slice(0, 8)}`);

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

// O CANÁRIO DO ESQUEMA — "migração primeiro" deixa de ser uma frase.
//
// O teto de cobranças mora numa RPC (`claim_slots`, migração 0033) e o store
// falha FECHADO sem ela: com o código novo no ar e a 0033 não aplicada, todo
// `/api/pay`, `/api/pay/stripe-intent` e `/api/house/load` devolve 500 e
// NINGUÉM PAGA. Isso está certo — degradar aberto foi o que mascarou doze dias
// de falha na Seatable (inegociável #7) —, mas quem ouvia a falha era o
// restaurante com uma mesa que não fecha. A única coisa que impunha a ordem
// era a mensagem de um commit. As duas revisões de 2026-09-15 pediram isto.
//
// A sonda é `release_slots` com um id que não existe: não escreve nada e
// devolve 0. Qualquer outra resposta — função ausente (PGRST202), 404,
// credencial errada — ABORTA antes do deploy, igual ao canário do
// `CRON_SECRET` logo acima. Ela lê o projeto do `.env` (mesmo caminho do
// `scripts/preflight-live.mjs`) e IMPRIME o host sondado: se o `.env` apontar
// pra outro projeto que não o de produção, é aqui que dá pra ver.
const envLocal = (() => {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(repoRoot, '.env'), 'utf8').split(/\r?\n/)
      .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  } catch { return {}; }
})();
const SB_URL = process.env.SUPABASE_URL || envLocal.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || envLocal.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  process.stderr.write('\n✗ sem SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ambiente ou .env) — não dá pra conferir\n'
    + '  que a migração 0033 está aplicada. Deploy ABORTADO: com o código novo e sem a RPC, ninguém paga.\n');
  process.exit(1);
}
const sonda = await fetch(`${SB_URL}/rest/v1/rpc/release_slots`, {
  method: 'POST',
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_claim_id: '00000000-0000-0000-0000-000000000000' }),
}).catch((e) => ({ ok: false, status: 0, text: async () => String(e && e.message) }));
const corpoSonda = String(await sonda.text()).trim();
const hostSondado = (() => { try { return new URL(SB_URL).host; } catch { return SB_URL; } })();
if (!sonda.ok || corpoSonda !== '0') {
  process.stderr.write(`\n✗ migração 0033 NÃO está aplicada em ${hostSondado} (release_slots → ${sonda.status} ${corpoSonda.slice(0, 160)}).\n`
    + '  Deploy ABORTADO. Aplique supabase/migrations/0033_charge_slots.sql PRIMEIRO:\n'
    + '  com o código novo e sem a RPC, todo pagamento devolve 500.\n');
  process.exit(1);
}
process.stdout.write(`✓ migração 0033 aplicada em ${hostSondado} (release_slots responde 0)\n`);

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
