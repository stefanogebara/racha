'use strict';

/**
 * O DOMÍNIO NÃO PODE VENCER EM SILÊNCIO.
 *
 * `useracha.app` está impresso nos QR de cima das mesas. Vencido, quem o
 * registrar depois recebe o tráfego dos QR de pagamento e pode servir uma
 * página de Pix falsa com o nome da Racha (compliance, PR #27, HIGH). Uma frase
 * no `docs/domains.md` dizendo "renovar é obrigação" não impede nada; este
 * vigia, pendurado na conciliação diária, pagina.
 *
 * Lê o RDAP do registro (público, sem segredo). A auto-renovação da Vercel não
 * aparece no RDAP — mas, se ela falhar, o vencimento para de andar e o aviso de
 * `DIAS_DE_AVISO` dispara com tempo de sobra pra renovar à mão.
 *
 * A decisão (`avaliarDominio`) é pura; o vigia (`vigiarDominio`) lê, decide E
 * avisa no mesmo lugar — a lição do `retention-watch.js`: guarda separado da
 * linha que age sobre ele é guarda que ninguém vê quebrar.
 */

const DOMINIO = 'useracha.app';
const RDAP_URL = `https://pubapi.registry.google/rdap/domain/${DOMINIO}`;
const DIAS_DE_AVISO = 60;
const DIA_MS = 24 * 60 * 60 * 1000;
const PRAZO_DA_LEITURA_MS = 8000;

// Estados do EPP que querem dizer "o domínio está saindo do ar ou já saiu".
const ESTADOS_RUINS = new Set([
  'client hold', 'server hold', 'redemption period', 'pending delete', 'pending restore',
]);

/**
 * Decide, a partir do JSON do RDAP, se há o que avisar. Nunca lança.
 * Devolve `{ avisar, codigo, dias, linha }`.
 */
function avaliarDominio(rdap, { agoraMs = Date.now(), erro = null } = {}) {
  if (erro || !rdap || typeof rdap !== 'object') {
    return {
      avisar: true, codigo: 'domain_read_failed', dias: null,
      linha: `domínio ${DOMINIO}: não foi possível ler o vencimento no RDAP (${erro || 'resposta vazia'}) — conferir à mão`,
    };
  }
  const estados = (Array.isArray(rdap.status) ? rdap.status : []).map((s) => String(s).toLowerCase());
  const ruim = estados.find((s) => ESTADOS_RUINS.has(s));
  const evento = (Array.isArray(rdap.events) ? rdap.events : []).find((e) => e && e.eventAction === 'expiration');
  const vence = evento ? Date.parse(evento.eventDate) : NaN;
  if (!Number.isFinite(vence)) {
    return {
      avisar: true, codigo: 'domain_read_failed', dias: null,
      linha: `domínio ${DOMINIO}: o RDAP não trouxe a data de vencimento — conferir à mão`,
    };
  }
  const dias = Math.floor((vence - agoraMs) / DIA_MS);
  const data = new Date(vence).toISOString().slice(0, 10);
  if (ruim) {
    return {
      avisar: true, codigo: 'domain_status_bad', dias,
      linha: `domínio ${DOMINIO}: estado "${ruim}" no registro (vence ${data}) — o QR das mesas pode parar; renovar/restaurar AGORA`,
    };
  }
  if (dias < DIAS_DE_AVISO) {
    return {
      avisar: true, codigo: 'domain_expiring', dias,
      linha: `domínio ${DOMINIO} vence em ${dias} dia(s) (${data}) — a auto-renovação não andou; renovar na Vercel`,
    };
  }
  return { avisar: false, codigo: 'domain_ok', dias, linha: `domínio ${DOMINIO}: vence em ${dias} dias (${data})` };
}

/** Lê o RDAP com prazo. Devolve `{ rdap }` ou `{ erro }` — nunca lança. */
async function lerRdap(buscar = fetch) {
  try {
    const res = await buscar(RDAP_URL, {
      headers: { accept: 'application/rdap+json' },
      signal: AbortSignal.timeout(PRAZO_DA_LEITURA_MS),
    });
    if (!res.ok) return { erro: `HTTP ${res.status}` };
    return { rdap: await res.json() };
  } catch (e) {
    return { erro: String((e && e.name) || 'erro') };
  }
}

/**
 * Lê, decide e avisa. `notificar` é o `notifyFounderMoneyEvent`; o kind é
 * `account_alert` (a conta do registrador), que a ponte já entrega por e-mail
 * e WhatsApp com o texto no `detail`. `seco` (o `?dry=1` do cron) só cala o aviso.
 */
async function vigiarDominio(notificar, { buscar = fetch, agoraMs = Date.now(), seco = false } = {}) {
  const { rdap, erro } = await lerRdap(buscar);
  const resultado = avaliarDominio(rdap, { agoraMs, erro });
  process.stderr.write(`[dominio] ${resultado.codigo} ${resultado.linha}\n`);
  if (resultado.avisar && !seco) {
    await notificar({ kind: 'account_alert', detail: `${resultado.codigo}: ${resultado.linha}` });
  }
  return resultado;
}

module.exports = { avaliarDominio, vigiarDominio, DOMINIO, RDAP_URL, DIAS_DE_AVISO };
