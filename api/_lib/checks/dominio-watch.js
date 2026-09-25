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
const TETO_DA_RESPOSTA = 64 * 1024;   // um RDAP de domínio tem ~3 KB (segurança, PR #28, LOW-1)
// Os nameservers que a Vercel serve. Trocados, o QR vai pra outro servidor sem
// o vencimento mudar — o sequestro que o vigia do vencimento não vê.
const NAMESERVERS = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'];

// Estados do EPP que querem dizer "o domínio está saindo do ar ou já saiu".
// A CAIXA DE CONTATO (segurança, PR #39, M1). `contato@useracha.app` está
// prometido no aviso de privacidade e no rodapé; a entrega depende de dois
// registros de DNS que nada mais confere. Um MX nulo de volta ou o TXT apagado
// numa edição na Vercel, e todo pedido do art. 18 leva bounce enquanto a tela
// continua prometendo o canal — o `privacidade@racha.com.br` de novo, adiado.
const MX_DA_CAIXA = ['mx1.forwardemail.net', 'mx2.forwardemail.net'];
const PREFIXO_DA_REGRA = 'forward-email=';
const PRAZO_DO_DNS_MS = 4000;

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
  // O SEQUESTRO que deixa o vencimento em paz (compliance, PR #28, MÉDIA-2): a
  // trava de transferência some antes de um domínio ser levado, e o QR segue
  // o nameserver — trocado, o tráfego vai pra outro lugar com a data intacta.
  if (!estados.includes('client transfer prohibited')) {
    return {
      avisar: true, codigo: 'domain_unlocked', dias,
      linha: `domínio ${DOMINIO}: a trava de transferência SUMIU do registro — confirmar na Vercel se foi você; se não, é tentativa de levar o domínio`,
    };
  }
  const ns = (Array.isArray(rdap.nameservers) ? rdap.nameservers : [])
    .map((n) => String((n && n.ldhName) || '').toLowerCase().replace(/\.$/, '')).sort();
  if (ns.join(',') !== NAMESERVERS.join(',')) {
    return {
      avisar: true, codigo: 'domain_nameservers_changed', dias,
      linha: `domínio ${DOMINIO}: os nameservers não são mais os da Vercel — o QR das mesas pode estar indo pra outro servidor; conferir AGORA`,
    };
  }
  if (dias < DIAS_DE_AVISO) {
    return {
      avisar: true, codigo: 'domain_expiring', dias,
      // Sem afirmar que a renovação falhou: a Vercel pode renovar perto do fim,
      // e uma frase falsa todo ano ensina a ignorar o aviso (compliance, LOW-4).
      linha: `domínio ${DOMINIO} vence em ${dias} dia(s) (${data}) — confirmar na Vercel que a renovação andou`,
    };
  }
  return { avisar: false, codigo: 'domain_ok', dias, linha: `domínio ${DOMINIO}: vence em ${dias} dias (${data})` };
}

/**
 * Decide se a caixa de contato ainda recebe, a partir do MX e do TXT da raiz.
 * Nunca lança. `mx` é a forma do `resolveMx` (`[{ exchange, priority }]`); `txt`,
 * a do `resolveTxt` (`[[pedaço, ...], ...]`).
 */
function avaliarCaixa({ mx, txt, erro } = {}) {
  if (erro || !Array.isArray(mx) || !Array.isArray(txt)) {
    return {
      avisar: true, codigo: 'mailbox_read_failed',
      linha: `caixa contato@${DOMINIO}: não foi possível ler o MX/TXT (${erro || 'resposta vazia'}) — conferir à mão`,
    };
  }
  const trocas = mx.map((r) => String((r && r.exchange) || '').toLowerCase().replace(/\.$/, '')).sort();
  if (trocas.join(',') !== MX_DA_CAIXA.join(',')) {
    return {
      avisar: true, codigo: 'mailbox_mx_changed',
      linha: `caixa contato@${DOMINIO}: o MX não é mais o do Forward Email (${trocas.join(', ') || 'nenhum'}) — pedido de titular pode estar levando bounce; conferir AGORA`,
    };
  }
  const registros = txt.map((partes) => (Array.isArray(partes) ? partes.join('') : String(partes)));
  if (!registros.some((r) => r.startsWith(PREFIXO_DA_REGRA))) {
    return {
      avisar: true, codigo: 'mailbox_rule_missing',
      linha: `caixa contato@${DOMINIO}: o TXT "${PREFIXO_DA_REGRA}…" sumiu — o MX recebe e não encaminha pra ninguém; recriar (docs/domains.md)`,
    };
  }
  return { avisar: false, codigo: 'mailbox_ok', linha: `caixa contato@${DOMINIO}: MX e regra no lugar` };
}

/** Lê MX e TXT da raiz com prazo, pelo resolvedor do sistema. Nunca lança. */
async function lerCaixa() {
  try {
    const { Resolver } = require('node:dns').promises;
    const r = new Resolver({ timeout: PRAZO_DO_DNS_MS, tries: 2 });
    const [mx, txt] = await Promise.all([r.resolveMx(DOMINIO), r.resolveTxt(DOMINIO)]);
    return { mx, txt };
  } catch (e) {
    return { erro: String((e && e.code) || (e && e.name) || 'erro') };
  }
}

/** Lê o RDAP com prazo. Devolve `{ rdap }` ou `{ erro }` — nunca lança. */
async function lerRdap(buscar = fetch) {
  try {
    const res = await buscar(RDAP_URL, {
      headers: { accept: 'application/rdap+json' },
      signal: AbortSignal.timeout(PRAZO_DA_LEITURA_MS),
    });
    if (!res.ok) return { erro: `HTTP ${res.status}` };
    const texto = await res.text();
    if (texto.length > TETO_DA_RESPOSTA) return { erro: 'too_large' };
    return { rdap: JSON.parse(texto) };
  } catch (e) {
    return { erro: String((e && e.name) || 'erro') };
  }
}

/**
 * Lê, decide e avisa. `notificar` é o `notifyFounderMoneyEvent`; o kind é
 * `account_alert` (a conta do registrador), que a ponte já entrega por e-mail
 * e WhatsApp com o texto no `detail`. `seco` (o `?dry=1` do cron) só cala o aviso.
 */
async function vigiarDominio(notificar, { buscar = fetch, agoraMs = Date.now(), seco = false, lerDns = lerCaixa } = {}) {
  const { rdap, erro } = await lerRdap(buscar);
  const resultado = avaliarDominio(rdap, { agoraMs, erro });
  process.stderr.write(`[dominio] ${resultado.codigo} ${resultado.linha}\n`);
  if (resultado.avisar && !seco) {
    // O desfecho da entrega fica na resposta do cron: `avisar: true` sozinho
    // não diz se alguém recebeu (segurança, PR #28, LOW-2).
    resultado.envio = await notificar({ kind: 'account_alert', detail: `${resultado.codigo}: ${resultado.linha}` });
  }
  // A caixa é conferida SEMPRE, também quando o domínio já avisou: são dois
  // defeitos independentes, e um aviso não pode esconder o outro.
  const caixa = avaliarCaixa(await lerDns());
  process.stderr.write(`[dominio] ${caixa.codigo} ${caixa.linha}\n`);
  if (caixa.avisar && !seco) {
    caixa.envio = await notificar({ kind: 'account_alert', detail: `${caixa.codigo}: ${caixa.linha}` });
  }
  resultado.caixa = caixa;
  return resultado;
}

module.exports = {
  avaliarDominio, avaliarCaixa, vigiarDominio, DOMINIO, RDAP_URL, DIAS_DE_AVISO, NAMESERVERS, MX_DA_CAIXA,
};
