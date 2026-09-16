'use strict';

/**
 * "NÃO CONSEGUI PERGUNTAR" NÃO É "A RESPOSTA É NÃO".
 *
 * `requireUser` colapsava toda falha do `getUser` num 401. Desde que o cliente
 * do Supabase ganhou prazo (10 s), um GoTrue lento virou desfecho comum — e o
 * cliente (`auth.ts`) faz `signOut()` em QUALQUER 401, com o painel recarregando
 * a cada 4 s. Uma lentidão de dez segundos não derrubava uma requisição:
 * derrubava a SESSÃO de todo dono com o painel aberto, no meio do turno. E
 * cegava o monitoramento junto — queda de plataforma virava pico de 401,
 * indistinguível de ataque de credencial.
 *
 * Achado pela revisão de segurança de 2026-09-16 (MEDIUM-2).
 */

const { createAuth, naoDeuPraPerguntar } = require('../_lib/auth');
/**
 * AS CLASSES DE VERDADE, e não objetos literais.
 *
 * Três rodadas seguidas este arquivo afirmou formas que o auth-js não constrói
 * — `{name:'AuthApiError', status:500}`, depois `{status:401}` pra token
 * inválido, depois `{code:'session_not_found'}` — e das três vezes o CÓDIGO foi
 * escrito pra casar com a ficção. A única forma de parar é construir o erro com
 * a biblioteca que a produção usa.
 */
const AuthJs = require('@supabase/auth-js');
const { createMemoryStore } = require('../_lib/store/memory');

const pedido = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const comErro = (error) => ({ auth: { getUser: async () => ({ data: null, error }) } });

/** O erro REAL do auth-js quando a ida não volta — medido contra um servidor mudo. */
const abortado = Object.assign(new Error('This operation was aborted'), {
  name: 'AuthRetryableFetchError', status: 0,
});
/** Token inválido: 403 `bad_jwt` — medido contra a produção, montado pela classe. */
const tokenRecusado = new AuthJs.AuthApiError('invalid JWT', 403, 'bad_jwt');
/** `apikey` errada (rotação de chave): 401 do Kong, SEM código. MEDIDO. */
const apikeyErrada = new AuthJs.AuthApiError('Invalid API key', 401, undefined);
/** Sessão REVOGADA: o auth-js não usa `AuthApiError` aqui — é outra classe. */
const sessaoRevogada = new AuthJs.AuthSessionMissingError();

describe('o login indisponível não desloga ninguém', () => {
  const store = createMemoryStore();

  test('um abort do GoTrue vira 503 com código, não 401', async () => {
    const auth = createAuth({ authClient: comErro(abortado), store });
    await expect(auth.requireUser(pedido('t'))).rejects.toMatchObject({
      statusCode: 503, code: 'auth_unavailable',
    });
  });

  test('o 429 do GoTrue NÃO desloga — é o furo que a lista de recusa tinha', async () => {
    const limitado = Object.assign(new Error('rate limit exceeded'), { name: 'AuthApiError', status: 429 });
    const auth = createAuth({ authClient: comErro(limitado), store });
    await expect(auth.requireUser(pedido('t'))).rejects.toMatchObject({
      statusCode: 503, code: 'auth_unavailable',
    });
  });

  test('um token RECUSADO continua 401 — senão a guarda some junto', async () => {
    // Esta é a metade que uma correção apressada quebra, e ela JÁ FOI QUEBRADA:
    // a versão anterior decidia por status, e como o GoTrue recusa com 403 (não
    // 401), o ramo de deslogar virou código morto em produção — quem tinha a
    // sessão revogada lia "o login não respondeu" e nunca era convidado a
    // entrar. A forma abaixo é a MEDIDA contra a produção.
    const auth = createAuth({ authClient: comErro(tokenRecusado), store });
    await expect(auth.requireUser(pedido('t'))).rejects.toMatchObject({ statusCode: 401 });
    expect(await auth.requireUser(pedido('t')).catch((e) => e.code)).toBeUndefined();
  });

  test('a sessão REVOGADA desloga — é o único evento em que "entre de novo" é a resposta certa', async () => {
    // O auth-js não entrega isto como `AuthApiError` com código: ele intercepta
    // `session_not_found` e lança `AuthSessionMissingError`, que não tem `code`
    // nenhum. Uma lista só de códigos classificava a revogação como "não deu
    // pra perguntar", e o dono lia uma revogação como queda de plataforma.
    const auth = createAuth({ authClient: comErro(sessaoRevogada), store });
    await expect(auth.requireUser(pedido('t'))).rejects.toMatchObject({ statusCode: 401 });
  });

  test('a APIKEY ERRADA não desloga ninguém — 401 do Kong, não recusa de token', async () => {
    // O cenário: rotação de chave no Supabase com a env da Vercel atrasada —
    // esta casa já viu duas vezes. A versão anterior chamava isto de "token
    // ruim" e deslogava TODO dono com o painel aberto: exatamente o dano que o
    // portão existe pra impedir, disparado pela falha de configuração mais
    // provável que existe.
    const auth = createAuth({ authClient: comErro(apikeyErrada), store });
    await expect(auth.requireUser(pedido('t'))).rejects.toMatchObject({
      statusCode: 503, code: 'auth_unavailable',
    });
  });

  test('sem token nenhum continua 401 — nem chega a perguntar', async () => {
    const auth = createAuth({ authClient: comErro(abortado), store });
    await expect(auth.requireUser({ headers: {} })).rejects.toMatchObject({ statusCode: 401 });
  });

  test('um usuário ausente sem erro continua 401', async () => {
    const auth = createAuth({ authClient: { auth: { getUser: async () => ({ data: {}, error: null }) } }, store });
    await expect(auth.requireUser(pedido('t'))).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('o predicado, medido caso a caso', () => {
  /**
   * AS FORMAS MEDIDAS, e nao as imaginadas.
   *
   * As duas versoes anteriores deste caso afirmavam objetos que o GoTrue nunca
   * produz — primeiro `{name:'AuthApiError', status:500}` (o auth-js converte
   * 5xx em `AuthRetryableFetchError`), depois `{status:401}` pra token
   * invalido. O segundo fez o teste documentar o CONTRARIO do runtime, e o
   * codigo foi escrito pra casar com ele.
   *
   * Isto aqui e o que a producao devolveu em 2026-09-16, medido com curl contra
   * `/auth/v1/user` do projeto real:
   *
   *   token lixo, apikey certa → 403 {"error_code":"bad_jwt", ...}
   *   JWT expirado             → 403 {"error_code":"bad_jwt", ...}
   *   apikey errada (rotacao)  → 401 {"message":"Invalid API key"}  (sem codigo)
   *
   * O auth-js levanta `error_code` do corpo pra `error.code` (`lib/fetch.js`).
   */
  test.each([
    // ── o GoTrue DECIDIU sobre o token: 401, e o cliente desloga ────────────
    ['bad_jwt (403) — token lixo ou expirado, MEDIDO', tokenRecusado, false],
    ['sessao REVOGADA — classe de verdade, sem `code` nenhum', sessaoRevogada, false],
    ['user_banned', new AuthJs.AuthApiError('banned', 403, 'user_banned'), false],
    // ── nao deu pra perguntar: 503, e NINGUEM desloga ──────────────────────
    ['401 do Kong, apikey errada — MEDIDO, e e o caso da rotacao de chave', apikeyErrada, true],
    ['429 — limite de taxa, atingivel DE PROPOSITO por quem nao tem sessao',
      { name: 'AuthApiError', status: 429 }, true],
    ['500 → o auth-js chama de Retryable', new AuthJs.AuthRetryableFetchError('500', 500), true],
    ['520 da Cloudflare', new AuthJs.AuthRetryableFetchError('520', 520), true],
    ['corpo que nao e JSON → AuthUnknownError, sem status', new AuthJs.AuthUnknownError('html', new Error('x')), true],
    ['abort (sem resposta)', abortado, true],
    ['403 de WAF, sem codigo', { name: 'AuthApiError', status: 403 }, true],
    ['codigo que esta casa nao conhece', { name: 'AuthApiError', status: 403, code: 'algo_novo' }, true],
    ['erro sem forma', { name: 'Sei la' }, true],
    ['nulo', null, false],
  ])('%s → e falha de transporte? %p', (_nome, erro, esperado) => {
    expect(naoDeuPraPerguntar(erro)).toBe(esperado);
  });
});
