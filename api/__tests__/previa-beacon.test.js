'use strict';

/**
 * Beacon da prévia de prospecção (Racha → Olímpia).
 *
 * POR QUE (13/08/2026). O link do demo que a Olímpia manda é fixo — dos 5
 * demos já enviados, ninguém soube se algum foi aberto. O `pl` no link é um
 * token que ELA cunhou; o Racha só repassa server-side pro /api/previa-event
 * (o CORS dela não abre pro browser do diner).
 *
 * Contratos:
 *  1. O repasse vai pro endpoint certo, com {token, event} — e SEM
 *     RACHA_NOTIFY_SECRET: previa-event é público de propósito, e vazar o
 *     secret dos avisos autenticados aqui seria dá-lo a um endpoint que não
 *     precisa dele.
 *  2. Falha de rede não lança — telemetria jamais derruba o demo.
 */

const ENV_ORIGINAL = process.env.RACHA_NOTIFY_URL;

afterEach(() => {
  if (ENV_ORIGINAL === undefined) delete process.env.RACHA_NOTIFY_URL;
  else process.env.RACHA_NOTIFY_URL = ENV_ORIGINAL;
  delete global.fetch;
  jest.resetModules();
});

function carregar() {
  jest.resetModules();
  return require('../_lib/notify');
}

describe('notifyPreviaBeacon — repasse do pl pra Olímpia', () => {
  test('POSTa {token, event} no /api/previa-event, sem authorization', async () => {
    process.env.RACHA_NOTIFY_URL = 'https://olimpia.example';
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    const { notifyPreviaBeacon } = carregar();

    const r = await notifyPreviaBeacon({ pl: 'lead.exp.assinatura', event: 'opened' });
    expect(r).toEqual({ ok: true, status: 200 });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://olimpia.example/api/previa-event');
    expect(JSON.parse(init.body)).toEqual({ token: 'lead.exp.assinatura', event: 'opened' });
    expect(init.headers.authorization).toBeUndefined();
  });

  test('falha de rede não lança — devolve {ok:false} e o demo segue', async () => {
    global.fetch = jest.fn(async () => { throw new Error('rede caiu'); });
    const { notifyPreviaBeacon } = carregar();
    await expect(notifyPreviaBeacon({ pl: 'x.y.z', event: 'paid' })).resolves.toEqual({ ok: false, error: 'rede caiu' });
  });
});
