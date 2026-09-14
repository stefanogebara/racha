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
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PROJECT_ID = 'prj_9g4oNf6HoNUnJFAPD53NJ0CH08O1';
const TEAM_ID = 'team_0OAVq8O0WIyi5FXT8Bgoxvnx';
const OAUTH_CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp'; // público (bundle do CLI)
const REPO = 'stefanogebara/racha';

const authPath = path.join(process.env.APPDATA || '', 'com.vercel.cli/Data/auth.json');

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

// O CANÁRIO DO `CRON_SECRET` MORA AQUI, e não na rota.
//
// A rota `/api/cron/reconcile` fecha sem o segredo e grita no log, mas quem
// PAGINAVA era ela — do ramo em que, por definição, não há autenticação: o ramo
// do segredo ausente. Um `curl` anônimo em N conexões forçava N cold starts e
// rendia N avisos, porque o throttle era estado de módulo numa função
// serverless. Aqui a pergunta é feita por quem está fazendo o deploy, com o
// token do projeto, e ninguém de fora pode acioná-la.
// Apontado pela revisão de segurança de 2026-09-14.
const envs = await (await fetch(
  `https://api.vercel.com/v9/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}`, { headers },
)).json();
const temCronSecret = (envs.envs || []).some(
  (e) => e.key === 'CRON_SECRET' && (e.target || []).includes('production'),
);
if (!temCronSecret) {
  process.stderr.write(
    '\n✗ CRON_SECRET NÃO ESTÁ CONFIGURADO em production.\n'
    + '  A conciliação diária (inegociável #8) não roda sem ele: a rota fecha em 503.\n'
    + '  Configure em https://vercel.com/dashboard → Settings → Environment Variables.\n',
  );
  process.exit(1);
}
process.stdout.write('✓ CRON_SECRET configurado em production\n');
