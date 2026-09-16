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
const { createMemoryStore } = require('../_lib/store/memory');

const pedido = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const comErro = (error) => ({ auth: { getUser: async () => ({ data: null, error }) } });

/** O erro REAL do auth-js quando a ida não volta — medido contra um servidor mudo. */
const abortado = Object.assign(new Error('This operation was aborted'), {
  name: 'AuthRetryableFetchError', status: 0,
});

describe('o login indisponível não desloga ninguém', () => {
  const store = createMemoryStore();

  test('um abort do GoTrue vira 503 com código, não 401', async () => {
    const auth = createAuth({ authClient: comErro(abortado), store });
    await expect(auth.requireUser(pedido('t'))).rejects.toMatchObject({
      statusCode: 503, code: 'auth_unavailable',
    });
  });

  test('um token RECUSADO continua 401 — senão a guarda some junto', async () => {
    // Esta é a metade que uma correção apressada quebra: alargar o ramo de
    // transporte até ele engolir a recusa de verdade transforma um portão de
    // autenticação num aviso.
    const recusado = Object.assign(new Error('invalid JWT'), { name: 'AuthApiError', status: 401 });
    const auth = createAuth({ authClient: comErro(recusado), store });
    await expect(auth.requireUser(pedido('t'))).rejects.toMatchObject({ statusCode: 401 });
    expect(await auth.requireUser(pedido('t')).catch((e) => e.code)).toBeUndefined();
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
  test.each([
    ['abort do auth-js', abortado, true],
    ['status 0 sem nome conhecido', { status: 0, message: 'socket hang up' }, true],
    ['nome conhecido sem status', { name: 'AuthRetryableFetchError' }, true],
    ['JWT inválido', { name: 'AuthApiError', status: 401 }, false],
    ['proibido', { name: 'AuthApiError', status: 403 }, false],
    ['erro 500 do GoTrue (ele RESPONDEU)', { name: 'AuthApiError', status: 500 }, false],
    ['nulo', null, false],
  ])('%s → é falha de transporte? %p', (_nome, erro, esperado) => {
    expect(naoDeuPraPerguntar(erro)).toBe(esperado);
  });
});
