import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, parseBrlToCents, CheckView, ChargeResult } from './api';
import { LangToggle, money, tError, useT, type Key } from './lang';
import { dishFor, dishMask } from './dish';
import Home from './Home';
import HousePay from './HousePay';
import PrivacyNotice from './PrivacyNotice';
import WalletButtons from './WalletPay';

/** Sem chave publicável não há elemento da Stripe pra montar. */
const STRIPE_READY = !!(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

/**
 * OS TRILHOS DA STRIPE CARREGAM SOB DEMANDA — e não em toda conta de Pix.
 *
 * `import` estático de `StripeWalletPay`/`BizumPay` traz junto o
 * `@stripe/stripe-js`, e importar esse módulo INJETA o `js.stripe.com` na
 * página — o componente devolver `null` não desfaz isso. Medido em 2026-09-10
 * numa conta brasileira de Pix, SEM chave publicável configurada: carregavam
 * `js.stripe.com/dahlia/stripe.js`, dois scripts `m-outer` de impressão
 * digital, o `m.stripe.network/inner.html` e um `POST m.stripe.com/6`.
 *
 * Ou seja: um destinatário de dados a mais (Stripe, EUA) recebendo sinal do
 * navegador de todo cliente que abre a conta — inclusive quem paga por Pix via
 * Pagar.me e nunca encosta na Stripe. O `docs/markets/README.md` já discute
 * mapa de destinatários pro Bizum/Open Bank; este caso não estava lá. LGPD
 * art. 6º III (necessidade) e o inegociável #10.
 *
 * Com `lazy`, o módulo — e o script — só entram quando a casa de fato oferece
 * o trilho.
 */
const StripeWalletPay = lazy(() => import('./StripeWalletPay'));
const BizumPay = lazy(() => import('./BizumPay'));
import { clearStoredWallet, readStoredWallet } from './house';
import { computeShare, splitEqualLocal, type SplitMode } from './split';
import { formatTaxId, isValidCPF, maskCpfCnpj } from './br';
import { Campo } from './Campo';
import { refDoPagamento } from './pagamento-ref';

import { lembrarToken, tokenDaVolta, voltandoDePagamento } from './payReturn';

/**
 * Racha diner flow — one screen, three acts:
 *   1. a conta (live check: items, total, quanto falta)
 *   2. sua parte (dividir igual / outro valor) + serviço opcional
 *   3. Pix (copia-e-cola) → confirmação
 * No login, no app. Centavo-exact math mirrors the backend split engine
 * (largest-remainder); the backend re-validates everything — this UI is
 * advisory, the API is the gate.
 */

type Step = 'conta' | 'pagar' | 'pago' | 'saldo';

/**
 * Código do servidor → chave de tradução. Mapa, não ternário: o `else` de um
 * ternário transforma qualquer código desconhecido na frase do vizinho, e aqui
 * a frase do vizinho diz ao cliente que ele tem dinheiro a receber.
 */
const NOTICE_KEY: Record<string, Key> = {
  overpaid_pending_restitution: 'notice.overpaid_pending_restitution',
  refund_reversed: 'notice.refund_reversed',
};

/**
 * O ritmo do poll da conta. Cresce até um minuto quando a conta não existe
 * (mesa ainda não aberta, ou já fechada) e volta aqui em qualquer leitura boa.
 */
const POLL_BASE_MS = 4000;

/**
 * As recusas que significam "A CONTA MUDOU DEBAIXO DE VOCÊ" — as únicas em que
 * "confira o valor e tente de novo" é conselho e não ruído. Todas nascem de
 * outra pessoa da mesma mesa ter pago primeiro, ou de o garçom ter mexido na
 * conta enquanto esta tela estava aberta.
 */
const CONTA_MUDOU = new Set(['amount_over', 'zero_charge', 'check_closed', 'check_not_found']);

export default function App() {
  const { t, lang, pct, adotarPadraoDaCasa, dmy, hm, tErr } = useT();
  // O `?t=` da mesa, ou — na volta de um trilho que redireciona (Bizum) — o
  // token que a própria aba guardou. A volta não traz o token na URL: ver
  // `payReturn.ts` pro motivo.
  const token = useMemo(() => {
    const daUrl = new URLSearchParams(window.location.search).get('t') ?? '';
    if (daUrl) { lembrarToken(daUrl); return daUrl; }
    return tokenDaVolta(window.location.search);
  }, []);
  // Beacon da prospecção: o link que a Olímpia manda carrega `pl` (token do
  // lead, opaco pra nós). Reporta abertura e pagamento same-origin — o backend
  // repassa pra ela. Best-effort com dedup por sessionStorage: telemetria
  // jamais pode quebrar o demo, nem repetir a cada reload.
  const prospectPl = useMemo(
    () => new URLSearchParams(window.location.search).get('pl'),
    [],
  );
  const sendBeacon = useCallback((event: 'opened' | 'paid') => {
    if (!prospectPl) return;
    try {
      const key = `racha-beacon:${event}:${prospectPl.slice(-16)}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch { /* storage indisponível → manda assim mesmo */ }
    fetch('/api/demo/beacon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pl: prospectPl, event }),
    }).catch(() => {});
  }, [prospectPl]);
  useEffect(() => { sendBeacon('opened'); }, [sendBeacon]);

  /**
   * "Alguém abriu a conta nesta mesa" — o primeiro degrau do funil de adoção.
   *
   * Separado do `sendBeacon` de propósito: aquele é o radar de VENDAS e só
   * dispara com `?pl=` na URL (o token de prospecção da Olímpia). Um cliente na
   * mesa de verdade abre `/?t=<token>` e não gerava nada — então sete semanas
   * de piloto não sabiam dizer se as pessoas viam a tela e desistiam, ou se
   * nunca chegavam nela. As duas coisas pedem correções opostas.
   *
   * `session` é aleatório e vive na aba: existe pra não contar o mesmo telefone
   * a cada consulta de 4 segundos. Não é IP, não é impressão digital, e não
   * identifica ninguém. Best-effort silencioso: nada aqui pode atrapalhar quem
   * está pagando.
   */
  useEffect(() => {
    if (!token) return;
    let sessao: string;
    try {
      const chave = 'racha-sess';
      sessao = sessionStorage.getItem(chave) || '';
      if (!sessao) {
        sessao = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem(chave, sessao);
      }
      // Uma vez por conta por aba.
      const marca = `racha-open:${token.slice(-12)}`;
      if (sessionStorage.getItem(marca)) return;
      sessionStorage.setItem(marca, '1');
    } catch {
      return;   // storage bloqueado → não conta, e não insiste
    }
    fetch('/api/check/opened', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, session: sessao }),
    }).catch(() => {});
  }, [token]);
  const [view, setView] = useState<CheckView | null>(null);

  // Dois eixos, e confundi-los é o defeito: a MOEDA vem da casa (uma conta em
  // Madrid é em euro), a SEPARAÇÃO vem do leitor. Um leitor de inglês lê
  // "R$ 1.234,56" errado por uma ordem de grandeza; um espanhol lê "1234,56 €"
  // certo, sem ponto de milhar (regra da RAE).
  //
  // `currency` sai do `view` quando ele chega; antes disso o default é BRL,
  // que é o que um servidor sem mercado quer dizer.
  const currency = view?.venue?.currency ?? 'BRL';
  // As regras do mercado, como o servidor as declarou. Os defaults são os
  // brasileiros — é o que um servidor sem `market` está dizendo.
  const serviceMode = view?.venue?.serviceCharge?.mode ?? 'preselected';
  const hasServiceLine = serviceMode !== 'none';
  const taxIdRequired = view?.venue?.payerTaxId?.required ?? true;
  // O bp que a conta REALMENTE cobra: o mercado já zerou o que não se aplica.
  const serviceBpEffective = view?.venue?.serviceCharge?.bp ?? view?.venue?.servicoBp ?? 0;
  const rails = view?.venue?.rails ?? ['pix', 'card'];
  const primaryRail = rails[0] ?? 'pix';
  const brl = useCallback((c: number) => money(c, lang, currency), [lang, currency]);
  // `error` é fatal: a conta não carrega, não há tela pra mostrar. `payError` é
  // recuperável e NUNCA pode substituir a tela — a corrida mais comum da mesa é
  // duas pessoas tocando "Pagar R$50" ao mesmo tempo: uma ganha, a outra leva
  // 400 do servidor ("valor acima do que falta"). Isso é um aviso pra tentar de
  // novo com o valor novo, não um beco sem saída.
  const [error, setError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  /**
   * O CÓDIGO da recusa, ao lado da frase — porque nem toda recusa se conserta
   * tentando de novo.
   *
   * A tela colava "— a conta foi atualizada, confira o valor e tente de novo"
   * em TODA recusa. Numa casa com o pagamento desligado
   * (`platform_misconfigured`) o cliente lia "pague no caixa" e, na mesma
   * linha, "confira o valor e tente de novo": duas instruções opostas, e a
   * segunda manda a pessoa insistir num botão que não vai funcionar.
   *
   * A lista é de quem PODE tentar de novo, não de quem não pode: um código novo
   * entra no lado seguro sozinho — mostra o erro e cala a boca sobre repetir.
   */
  const [payErrorCode, setPayErrorCode] = useState<string | null>(null);
  // TOQUE DUPLO. O botão só desligava com o total zerado, então dois toques
  // numa rede lenta mandavam dois POSTs: dois pedidos na Pagar.me e duas vagas
  // do teto por conta. Revisão de compliance de 2026-09-15 (MEDIUM-4).
  const [paying, setPaying] = useState(false);
  // A última atualização falhou, mas ainda temos a conta em mãos.
  const [stale, setStale] = useState(false);

  const [mode, setMode] = useState<SplitMode>('igual');
  const [people, setPeople] = useState(2);
  const [customValue, setCustomValue] = useState('');
  // Modo "Por item": ids dos itens que o diner marcou como seus.
  const [selectedItems, setSelectedItems] = useState<Set<string>>(() => new Set());
  const [servicoOn, setServicoOn] = useState(true);
  const [payerLabel, setPayerLabel] = useState('');
  // CPF do pagador: o adquirente exige o documento do customer em TODO
  // método (Pix e cartão) — padrão de checkout brasileiro. Um campo só,
  // compartilhado com o Google Pay.
  const [cpf, setCpf] = useState('');
  const cpfDigits = cpf.replace(/\D/g, '');
  /**
   * ONZE DÍGITOS NÃO É UM CPF.
   *
   * A tela conferia só o COMPRIMENTO: `00000000000` passava, a cobrança ia pro
   * gateway, o gateway recusava, e a pessoa levava um erro genérico do outro
   * lado do botão de pagar — com a mesa esperando. O dígito verificador é
   * aritmética que cabe aqui, e o repositório já tem a função (`isValidCPF`,
   * a mesma que o cadastro do dono usa). Conferir no campo é o único jeito de
   * dizer QUAL campo está errado.
   */
  const cpfOk = isValidCPF(cpfDigits);
  // Antes o botão de pagar exigia CPF pra HABILITAR — ficava cinza em silêncio e
  // parecia "quebrado" (diner toca e nada acontece). Agora é tocável e, sem CPF,
  // dá feedback + foca o campo.
  const [cpfHint, setCpfHint] = useState(false);

  const [step, setStep] = useState<Step>('conta');
  const [charge, setCharge] = useState<ChargeResult | null>(null);
  // Quanto já estava pago no instante em que criei MINHA cobrança — quando o
  // pago passar disso, é a minha que caiu → avança pro ✓ sozinho.
  // A MARCA da minha cobrança na conta pública (ver `pagamento-ref.ts`). O ✓
  // espera ESTA marca cair — não o total da mesa subir.
  const [ownRef, setOwnRef] = useState<string | null>(null);
  /** Quando o pagamento foi confirmado NESTA sessão — o carimbo do comprovante.
   *  Fixado na transição, não no render: no render ele andaria a cada poll. */
  const [paidAt, setPaidAt] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [demoGone, setDemoGone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Para de fazer polling quando a conta some no meio do redeem (fechou/girou).
  const [polling, setPolling] = useState(true);
  // O intervalo do poll, que cresce no 404 e volta ao normal no acerto.
  const [esperaMs, setEsperaMs] = useState(POLL_BASE_MS);

  // Saldo da casa: carteira pré-paga do restaurante (docs/house-accounts).
  const [house, setHouse] = useState<{ token: string; balanceCents: number } | null>(null);
  const [houseBonusBp, setHouseBonusBp] = useState<number | null>(null);
  const [houseChecked, setHouseChecked] = useState(false);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const fresco = await api.getCheck(token);
      setView(fresco);
      // O IDIOMA DA CASA, quando ninguém escolheu nada. O servidor mandava
      // `defaultLang` em toda conta e o cliente só declarava o tipo dele.
      adotarPadraoDaCasa(fresco.venue.defaultLang);
      setError(null);
      setStale(false);
      setEsperaMs(POLL_BASE_MS);   // acertou: volta pro ritmo normal
    } catch (e) {
      // Um blip de sinal NÃO pode apagar a tela. O caso real: o diner copia o
      // código Pix, troca pro app do banco, o 4G do bar oscila, ele volta — e o
      // poll de 4s já trocou o código por "Failed to fetch". Se já existe uma
      // conta carregada, a falha vira um aviso discreto e a tela fica de pé;
      // só a PRIMEIRA carga pode falhar em tela cheia, porque aí não há tela.
      setStale(true);
      const err = e as ApiError;
      // CONTA QUE NÃO EXISTE DESACELERA O RELÓGIO. Não o para.
      //
      // O poll de 4s não parava nunca: depois que a mesa terminava de pagar, a
      // conta some da leitura (`status <> 'fechada'`) e TODO poll seguinte
      // virava 404 — 15 por minuto, por telefone, de cada aparelho ainda com a
      // tela aberta.
      //
      // A primeira correção foi PARAR no 404, e estava errada — terceira volta
      // da mesma forma no mesmo controle. "404 é estado estável" é verdade do
      // ramo que eu estava olhando (a conta acabou de fechar) e falsa do outro:
      // quem escaneia o QR ANTES de o garçom abrir a conta também recebe 404, e
      // esse é o fluxo principal do produto. O telefone parava pra sempre, numa
      // tela sem botão nenhum, e a conta abria noventa segundos depois sem que
      // ele jamais soubesse. As duas situações são indistinguíveis na resposta.
      //
      // Recuo exponencial resolve as duas: o desperdício some (de 15/min pra
      // 1/min) e a mesa que ainda vai abrir continua viva. Qualquer 200 volta
      // pros 4 segundos. Achado da revisão de segurança de 2026-09-12.
      if (err.code === 'check_not_found') {
        setEsperaMs((ms) => Math.min(ms * 2, 60_000));
      }
      setError(tError(lang, err.code, err.message));
    }
  }, [token, lang, adotarPadraoDaCasa]);

  // A PRIMEIRA leitura, uma vez só. Ela morava no efeito do intervalo, que
  // depende de `esperaMs` — então cada dobra do recuo re-rodava o efeito e
  // disparava uma leitura imediata junto: cinco requisições em rajada antes de
  // assentar. Convergia certo e parecia bug em qualquer log.
  useEffect(() => {
    if (polling) void refresh();
  }, [refresh, polling]);

  useEffect(() => {
    if (!polling) return;
    const id = setInterval(refresh, esperaMs);
    return () => clearInterval(id);
  }, [refresh, polling, esperaMs]);

  // VOLTAR PRA TELA acelera de novo.
  //
  // Um teto só serve duas pessoas com necessidades opostas: o telefone
  // esquecido na mesa não tem pressa, e quem está olhando a tela esperando o
  // garçom abrir a conta tem. `visibilitychange` separa os dois exatamente —
  // o esquecido está com a tela apagada ou a aba no fundo, quem espera não.
  useEffect(() => {
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') setEsperaMs(POLL_BASE_MS);
    };
    document.addEventListener('visibilitychange', aoVoltar);
    return () => document.removeEventListener('visibilitychange', aoVoltar);
  }, []);

  // Detecta a carteira do cliente uma vez, depois que a conta carrega.
  // V1 pragmático: as respostas públicas não expõem venueId, então o vínculo
  // carteira↔restaurante é por venueName (ver house.ts).
  useEffect(() => {
    if (!view || houseChecked) return;
    setHouseChecked(true);
    const stored = readStoredWallet();
    if (stored && stored.venueName === view.venue.name) {
      api.houseAccount(stored.token)
        .then((a) => setHouse({ token: stored.token, balanceCents: a.account.totalCents }))
        .catch((e) => {
          // Só um 404 prova que o token morreu (girado no balcão). Qualquer outra
          // falha (rede, 5xx) NÃO pode apagar a única credencial do saldo do
          // cliente — só esconde o botão nesta sessão e mantém o storage.
          if ((e as ApiError).status === 404) clearStoredWallet();
        });
    } else {
      api.houseConfig(token)
        .then((c) => { if (c.enabled) setHouseBonusBp(c.bonusBp); })
        .catch(() => {}); // sem saldo da casa neste restaurante — segue só o Pix
    }
  }, [view, houseChecked, token]);

  // Auto-avança pro ✓ quando o MEU pagamento cai — webhook real OU Simulador da
  // demo, sem depender de botão. Comparava o `paidCents` da MESA com o de antes
  // da minha cobrança: qualquer pagamento servia, e numa mesa em que quatro
  // pessoas pagam juntas, o telefone de quem ainda não tinha pago dizia
  // "Pagamento confirmado — você pagou" (auditoria de fluxo, CRITICAL-1). Agora
  // espera a marca da PRÓPRIA cobrança aparecer entre os pagamentos da conta.
  useEffect(() => {
    if (step === 'pagar' && charge && ownRef && view
        && Object.values(view.state.payments || {}).some((p) => p.ref === ownRef)) {
      setPaidAt(new Date().toISOString()); setStep('pago');
    }
  }, [view, step, charge, ownRef]);

  // O ✓ é o momento-prova do demo de prospecção: o lead PAGOU a conta de
  // mentira. Cobre os dois caminhos até 'pago' (webhook e redeem de saldo).
  useEffect(() => {
    if (step === 'pago') sendBeacon('paid');
  }, [step, sendBeacon]);

  // Sem token de mesa = visita direta (desktop/prospect/KYC) → landing.
  //
  // MENOS quando a pessoa está VOLTANDO de um pagamento: aí a landing é a
  // resposta errada — ela acabou de autorizar dinheiro e a tela diz "conheça o
  // Racha". Aba nova ou armazenamento bloqueado tiram o token guardado, e o
  // caminho é alcançável no Brasil (3DS de cartão que a Stripe não resolve em
  // modal). Melhor mandar de volta pro QR do que deixar pagar duas vezes.
  if (!token && voltandoDePagamento(window.location.search)) {
    return (
      <Shell>
        <section className="card center">
          <h2>{t('ret.title')}</h2>
          <p className="muted">{t('ret.body')}</p>
          <LangToggle />
        </section>
      </Shell>
    );
  }
  if (!token) return <Home />;
  /**
   * A CONTA QUE NÃO CARREGOU — o beco mais comum do produto.
   *
   * QR vencido, mesa que o garçom ainda não abriu, link truncado por um app de
   * mensagem: tudo cai aqui. A tela devolvia dois parágrafos cinzas no meio do
   * papel, sem marca, sem contorno e sem seletor de idioma — o que parece erro
   * de carregamento, não resposta.
   *
   * O conserto já estava escrito na carteira (`SemCarteira`) e não tinha
   * atravessado pra cá, que é onde ele é mais usado. Agora é um estado do
   * produto: moldura, marca, o que aconteceu, e o que a pessoa faz (a tela
   * continua tentando sozinha, e isso é dito).
   */
  if (error && !view) {
    return (
      <Shell>
        {/* Sem o slogan aqui: ele já está no rodapé desta mesma tela, e repetido
            duas vezes numa tela de três linhas ele vira ruído. */}
        <header className="head">
          <span className="venue">Racha</span>
        </header>
        <section className="card">
          <p className="label">{t('check.notLoadedTitle')}</p>
          <p className="muted">{error}</p>
          {polling && <p className="muted small">{t('check.stillChecking')}</p>}
        </section>
        <footer className="foot"><span>{t('app.tagline')}</span><LangToggle compact /></footer>
      </Shell>
    );
  }
  if (!view) return <Shell><p className="muted center">{t('common.loading')}</p></Shell>;

  const { venue, table, state } = view;
  const remaining = Math.max(0, state.totalCents - state.paidCents);
  const progress = state.totalCents > 0 ? Math.min(100, (state.paidCents / state.totalCents) * 100) : 0;

  // parseBrlToCents devolve null para entrada inválida ('R$ 47,50' colado com
  // lixo, '1.234,56', etc. resolvem certo; 'abc' → null) — null desarma o CTA.
  const customCents = parseBrlToCents(customValue);
  const selectedCents = view.check.items
    .filter((i) => selectedItems.has(i.id))
    .reduce((s, i) => s + i.priceCents, 0);
  // Split proporcional em TODO modo: o serviço é sempre % da SUA parte
  // (split.ts espelha o backend). Quem paga mais, paga mais serviço.
  // A parte igual sai do TOTAL da conta, não do que falta — senão cada pessoa
  // que paga depois paga menos que a anterior e a mesa nunca fecha (ver split.ts).
  // `serviceBpEffective` vem do MERCADO, não do cadastro: uma casa espanhola
  // pode ter 1000bp gravados (o formulário é brasileiro) e a conta em Madrid
  // ainda assim não cobra serviço.
  const share = computeShare({
    mode, totalCents: state.totalCents, remaining, people, customCents, selectedCents,
    servicoOn: servicoOn && hasServiceLine, servicoBp: serviceBpEffective,
  });
  const cappedBase = share.base;
  const servicoCents = share.servico;
  const totalToPay = share.total;

  function toggleItem(id: string) {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function onPayOnce() {
    if (paying) return;
    setPaying(true);
    try { await onPay(); } finally { setPaying(false); }
  }

  async function onPay() {
    // Só barra onde o documento é exigido pelo trilho. Barrar em Espanha
    // travaria o pagamento num campo que a tela nem mostra.
    if (taxIdRequired && !cpfOk) {
      setCpfHint(true);
      document.getElementById('cpf-field')?.focus();
      return;
    }
    setCpfHint(false);
    setPayError(null);
    setPayErrorCode(null);
    try {
      setOwnRef(null); // a marca da cobrança NOVA chega com ela, abaixo
      // `undefined`, não '' — não pedimos documento neste mercado, então não
      // mandamos um campo vazio pra ser validado como se tivesse sido pedido.
      const result = await api.pay(token, cappedBase, servicoCents, payerLabel.trim() || null,
                                   taxIdRequired ? cpfDigits : undefined,
                                   primaryRail === 'bizum' ? 'bizum' : 'pix');
      setCharge(result);
      // A MARCA que faz esta tela reconhecer o PRÓPRIO pagamento. Sem
      // `crypto.subtle` (contexto não-seguro, WebView velha) ela não existe, e
      // aí NENHUM caminho leva de `pagar` a `pago` numa casa de verdade: a
      // pessoa paga e a tela continua mostrando o copia-e-cola, o que convida a
      // pagar de novo (CDC art. 42 § único) e não dá comprovante nenhum
      // (art. 6º III). O aviso abaixo cobre isso — e o `.catch` existe porque
      // uma promessa rejeitada aqui deixava `ownRef` nulo em silêncio
      // (compliance MEDIUM-6 de ec86b37).
      void refDoPagamento(result.txid).then(setOwnRef).catch(() => setOwnRef(null));
      setStep('pagar');
      setCopied(false);
    } catch (e) {
      // Alguém pagou primeiro (ou a conta mudou): recarrega e deixa o diner na
      // mesma tela, com o número já atualizado, pra tocar de novo.
      const err = e as ApiError;
      // Os valores vêm do servidor em centavos crus; quem formata é quem sabe
      // o idioma. Ver o comentário do amount_over no router.
      setPayErrorCode(err.code || null);
      setPayError(tError(lang, err.code, err.message,
        // Todos os limites que o servidor manda em CENTAVOS, formatados aqui na
        // moeda da casa. Antes só `leftCents` era mapeado, então a mensagem do
        // teto do Bizum — a única que uma mesa grande em Espanha vai ver de
        // verdade — chegava com "{max}" literal na tela.
        err.vars ? {
          left: brl(Number(err.vars.leftCents ?? 0)),
          min: brl(Number(err.vars.minCents ?? 0)),
          max: brl(Number(err.vars.maxCents ?? 0)),
          // `limit` e `windowMinutes` NÃO são dinheiro — são contagem e
          // minutos. Faltavam aqui, e o resultado era o teto de cobranças
          // chegando com `{limit}` e `{windowMinutes}` LITERAIS na tela, que é
          // a mesma regressão que o comentário acima já registra pro `{max}`.
          // Um censo de marcadores agora impede a terceira. Achado pela
          // revisão de compliance de 2026-09-15 (HIGH-3).
          limit: String(err.vars.limit ?? ''),
          windowMinutes: String(err.vars.windowMinutes ?? ''),
        } : undefined));
      void refresh();
    }
  }

  async function onCopy() {
    if (!charge || !charge.copiaECola) return;
    // COPIADO SÓ QUANDO COPIOU. `writeText` falha no navegador embutido do
    // WhatsApp e do Instagram, fora de HTTPS ou sem permissão — e a tela dizia
    // "copiado" assim mesmo: a pessoa abria o banco e colava nada, e o código na
    // tela vinha cortado em 64 caracteres (auditoria de UI, C1).
    try {
      await navigator.clipboard.writeText(charge.copiaECola);
      setCopied(true); setCopyFailed(false);
    } catch {
      setCopied(false); setCopyFailed(true);
    }
  }

  // Demo affordance: stands in for the diner's bank app.
  async function onDevConfirm() {
    if (!charge) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await api.devConfirm(charge.txid);
      await refresh();
      setPaidAt(new Date().toISOString()); setStep('pago');
    } catch (e) {
      // Fora do modo demo /api/dev/confirm não existe (404) — some o botão.
      if ((e as ApiError).status === 404) setDemoGone(true);
      else setConfirmError(tErr(e));
    } finally {
      setConfirming(false);
    }
  }

  // O trilho desta cobrança. Vem do `method` que o servidor devolveu, não do
  // mercado: o que a tela precisa dizer é o que ESTA cobrança é.
  const isBizumCharge = charge?.method === 'bizum';

  if (step === 'pagar' && charge) {
    return (
      <Shell>
        <header className="head">
          <span className="venue">{venue.name}</span>
          <span className="mesa">{table.label}</span>
        </header>
        {stale && <p className="muted small center">{t('pix.stillValid')}</p>}
        <section className="pixcard">
          {/* O trilho da COBRANÇA, não do mercado: é o que esta cobrança é.
              A tela dizia "Paga con Pix" e oferecia "Copiar código Pix" numa
              cobrança Bizum — que não TEM código copia-e-cola, então a caixa
              vinha vazia com um "…" dentro. Nomear o trilho errado e oferecer
              um código inexistente na tela onde a pessoa está pagando. */}
          <p className="label">{isBizumCharge ? t('bizum.title') : t('pix.title')}</p>
          <p className="bigmoney">{brl(charge.amountCents + charge.tipCents)}</p>
          {charge.tipCents > 0 && (
            <p className="muted small">{t('pix.includesTip', { amount: brl(charge.tipCents) })}</p>
          )}
          {isBizumCharge ? (
            // Bizum: quem autoriza é o banco do pagador, no app dele. Não há
            // nada pra copiar, então não há botão de copiar.
            <p className="muted small center">{t('bizum.how')}</p>
          ) : (
            <>
              <div className="codebox selectable" aria-label={t('pix.aria')}>
                {charge.copiaECola ?? ''}
              </div>
              <button className="cta" onClick={onCopy}>
                {copied ? t('pix.copied') : t('pix.copy')}
              </button>
              {copyFailed && <p className="muted small center" role="status">{t('pix.copyFailed')}</p>}
              <p className="muted small center">
                {t('pix.how')}
              </p>
            </>
          )}
          {/* O botão de SIMULAR só na casa de demonstração. Aparecia pra todo
              cliente de verdade, embaixo do Pix de verdade, até um toque devolver
              404 (auditorias de fluxo H2 e de UI H3). */}
          {venue.demo === true && !demoGone && (
            <button className="ghost" onClick={onDevConfirm} disabled={confirming}>
              {confirming ? t('pix.simulating') : t('pix.simulate')}
            </button>
          )}
          {confirmError && <p className="muted small" style={{ color: 'var(--erro)' }}>{confirmError}</p>}
          {/* Este telefone não consegue calcular a própria marca: avisa, em vez
              de esperar por um ✓ que não vem. */}
          {ownRef === null && <p className="muted small center">{t('pix.noAutoConfirm')}</p>}
          <button className="linklike" onClick={() => setStep('conta')}>{t('common.back')}</button>
        </section>
      </Shell>
    );
  }

  if (step === 'pago') {
    return (
      <Shell>
        <section className="paid">
          <div className="paidmark">✓</div>
          <h2>{t('paid.title')}</h2>
          <p className="muted">
            {payerLabel ? t('paid.thanks', { name: payerLabel }) : ''}{t('paid.yours')}
          </p>
          <div className="progresswrap">
            <div className="progressbar"><span style={{ width: `${progress}%` }} /></div>
            <p className="muted small">
              {t('paid.progress', { paid: brl(state.paidCents), total: brl(state.totalCents) })}
              {remaining > 0 ? t('paid.left', { left: brl(remaining) }) : t('paid.closed')}
            </p>
          </div>
          {remaining > 0 && (
            <button className="cta" onClick={() => {
              setSelectedItems(new Set());
              // LIMPA o comprovante anterior. Sem isto: paga a 1ª parte no Pix
              // (recibo certo), toca aqui, paga a 2ª na carteira — e a tela
              // mostrava a quantia da PRIMEIRA com a data da SEGUNDA. Valor
              // afirmativamente errado num comprovante é pior que valor
              // ausente.
              setCharge(null);
              setPaidAt(null);
              setStep('conta');
              void refresh();
            }}>
              {t('paid.payMore')}
            </button>
          )}
          {/* O QUE ELE PAGOU. A barra acima é o progresso da CONTA — consumo —
              e o comprovante mostrava só esse número: o cliente pagava
              R$ 117,21 e lia R$ 106,55, sem nenhuma menção ao serviço. Um
              comprovante cujo valor não bate com o extrato do cartão não serve
              de comprovante. O serviço sai em linha própria porque é a parte
              que a casa distribui à equipe por obrigação legal (Lei
              13.419/2017, e a CLT 457 §6º ainda deixa reter encargos), e a
              hora entra porque
              recibo sem data é prova fraca. Medido no e2e de 2026-09-10. */}
          {charge && (
            <>
              <p className="center" style={{ marginBottom: 0 }}>
                <strong>{t('paid.youPaid', { amount: brl(charge.amountCents + charge.tipCents) })}</strong>
              </p>
              {charge.tipCents > 0 && (
                <p className="muted small center" style={{ marginTop: 2 }}>
                  {t('paid.ofWhichTip', { amount: brl(charge.tipCents) })}
                </p>
              )}
              {paidAt && (
                <p className="muted small center" style={{ marginTop: 2 }}>
                  {t('paid.at', { when: `${dmy(paidAt)} ${hm(paidAt)}` })}
                </p>
              )}
            </>
          )}
          {/* Quem cobrou, e o que esta tela é. Antes ela não nomeava
              comerciante nenhum — e uma tela de "pago" sem comerciante lê como
              recibo da Racha, que não foi quem vendeu nada. Ver o comentário
              de `paid.receipt` no dicionário: comprovante, nunca fatura. */}
          <p className="muted small center">{t('paid.receipt', { venue: venue.name })}</p>
          {/* O documento da casa. Sem ele o comprovante não identifica quem
              vendeu, e a coluna existe desde a primeira migração justamente
              porque "receipts must show it". Nulo é normal e a linha
              simplesmente não aparece — um documento de mentira num recibo de
              verdade é pior que a ausência dele (migração 0002). */}
          {venue.taxId && (
            <p className="muted small center">
              {t(venue.market === 'es' ? 'rcpt.taxIdNif' : 'rcpt.taxIdCnpj')}{' '}{formatTaxId(venue.taxId, venue.market)}
            </p>
          )}
          {/* AVISOS DE DINHEIRO do cliente. Código estável + centavos vêm do
              servidor; a frase é daqui. Pagou a mais, ou um estorno que
              falhou: nos dois a casa deve, e ficar calado é o problema — o
              cliente vai embora sem saber que tem valor a receber. */}
          {(state.notices || []).map((n, i) => (
            <p key={`${n.code}:${i}`} className="muted small center" style={{ color: 'var(--erro)' }}>
              {/* Um `switch`, não um ternário: um código novo que o servidor
                  inventar renderizaria a frase do ESTORNO — uma cobrança de
                  dinheiro falsa pro cliente. Desconhecido não aparece. */}
              {NOTICE_KEY[n.code] ? t(NOTICE_KEY[n.code], { amount: brl(n.amountCents) }) : null}
            </p>
          ))}
          <p className="muted small center">{t('paid.notInvoice')}</p>
        </section>
      </Shell>
    );
  }

  if (step === 'saldo' && house) {
    return (
      <Shell>
        <header className="head">
          <span className="venue">{venue.name}</span>
          <span className="mesa">{table.label}</span>
        </header>
        <HousePay
          accountToken={house.token}
          tableToken={token}
          availableCents={house.balanceCents}
          defaultCents={Math.min(cappedBase, house.balanceCents)}
          onPaid={(r) => {
            if (r.check) {
              setView(r.check); // o redeem devolve o check view fresco
            } else {
              // Conta fechou/girou no meio do redeem — o débito ACONTECEU.
              // Mantém a tela de sucesso do HousePay e para o polling, que só
              // acharia 404 e trocaria o sucesso por "Conta não encontrada".
              setPolling(false);
            }
            setHouse({
              token: house.token,
              balanceCents: Math.max(0, house.balanceCents - r.principalUsedCents - r.bonusUsedCents),
            });
          }}
          onBack={() => setStep('conta')}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="head">
        <span className="venue">{venue.name}</span>
        <span className="mesa">{table.label}</span>
      </header>

      {stale && <p className="muted small center">{t('check.offline')}</p>}
      {/* A comanda. O único objeto claro da tela, porque é o único papel de uma
          mesa de verdade — e é ela que carrega o que a casa vai cobrar. */}
      <section className="card slip">
        <p className="label">
          {t('check.yours')}
          {mode === 'item' && remaining > 0 && <span className="muted small">{t('check.tapYours')}</span>}
        </p>
        <ul className={mode === 'item' && remaining > 0 ? 'items pickable' : 'items'}>
          {view.check.items.map((i) => {
            if (mode !== 'item' || remaining === 0) {
              return (
                <li key={i.id}>
                  <span className="iwrap">
                    <Dish name={i.name} />
                    <span>{i.name}</span>
                  </span>
                  <span className="mono">{brl(i.priceCents)}</span>
                </li>
              );
            }
            const picked = selectedItems.has(i.id);
            return (
              <li key={i.id}>
                <button
                  type="button"
                  className={picked ? 'itempick on' : 'itempick'}
                  aria-pressed={picked}
                  onClick={() => toggleItem(i.id)}
                >
                  <span className="tick" aria-hidden="true">{picked ? '✓' : '+'}</span>
                  <Dish name={i.name} />
                  <span className="iname">{i.name}</span>
                  <span className="mono">{brl(i.priceCents)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="totalrow">
          <span>{t('check.total')}</span>
          <span className="mono">{brl(state.totalCents)}</span>
        </div>
        {state.paidCents > 0 && (
          <div className="progresswrap">
            <div className="progressbar"><span style={{ width: `${progress}%` }} /></div>
            <p className="muted small">{t('check.paidSoFar', { paid: brl(state.paidCents), left: brl(remaining) })}</p>
          </div>
        )}
      </section>

      {remaining === 0 ? (
        <section className="card center">
          <p className="bigmoney">🎉</p>
          <p>{t('check.allPaid')}</p>
        </section>
      ) : (
        <section className="card">
          <p className="label">{t('share.title')}</p>
          <div className="modes modes3" role="tablist">
            <button role="tab" aria-selected={mode === 'igual'} className={mode === 'igual' ? 'mode on' : 'mode'} onClick={() => setMode('igual')}>
              {t('share.equal')}
            </button>
            <button role="tab" aria-selected={mode === 'item'} className={mode === 'item' ? 'mode on' : 'mode'} onClick={() => setMode('item')}>
              {t('share.byItem')}
            </button>
            <button role="tab" aria-selected={mode === 'valor'} className={mode === 'valor' ? 'mode on' : 'mode'} onClick={() => setMode('valor')}>
              {t('share.custom')}
            </button>
          </div>

          {mode === 'igual' && (
            <div className="stepperrow">
              <span>{t('share.splitAmong')}</span>
              <div className="stepper">
                <button aria-label={t('share.fewer')} onClick={() => setPeople(Math.max(1, people - 1))}>−</button>
                <strong>{people}</strong>
                <button aria-label={t('share.more')} onClick={() => setPeople(Math.min(20, people + 1))}>+</button>
              </div>
              <span>{t('share.people')}</span>
            </div>
          )}
          {mode === 'igual' && (
            <p className="muted small itemhint">
              {t('share.each', { amount: brl(splitEqualLocal(state.totalCents, people, 0)) })}
              {state.paidCents > 0 ? t('share.overTotal') : ''}
            </p>
          )}
          {mode === 'item' && (
            <p className="muted small itemhint">
              {selectedItems.size === 0
                ? t('share.pickItems')
                : t('share.picked', {
                    n: selectedItems.size,
                    noun: t(selectedItems.size === 1 ? 'share.item' : 'share.items'),
                    amount: brl(cappedBase),
                  })}
            </p>
          )}
          {/* O RÓTULO é o nome do campo; o cifrão é prefixo. Era um `<label>`
              cujo texto inteiro era "R$": o nome acessível do campo que decide
              quanto dinheiro sai era o símbolo da moeda. */}
          {mode === 'valor' && (
            <label className="customrow" htmlFor="valor">
              <span>{t('share.custom')}</span>
              <span className="linha">
              {/* O símbolo vem da MOEDA da casa, não de um literal — era "R$"
                  fixo, inclusive numa conta em euro. */}
              <span className="cifra" aria-hidden="true">{currency === 'EUR' ? '€' : 'R$'}</span>
              <input
                id="valor" inputMode="decimal" placeholder="0,00"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
              />
              </span>
            </label>
          )}

          {/* Em Espanha a conta NÃO tem linha de serviço: o preço já inclui o
              serviço e a gorjeta é discricionária, quase nunca lançada. Somar
              uma linha que o cliente não pediu, num mercado onde ela não é
              costume, é o padrão errado na UE. Quem decide é o mercado, no
              servidor — não uma condição de tela. */}
          {hasServiceLine && (
            <label className="servico">
              <input type="checkbox" checked={servicoOn} onChange={(e) => setServicoOn(e.target.checked)} />
              <span>
                {t('servico.label', { pct: (serviceBpEffective / 100).toFixed(0) })}
                <em>{servicoOn && servicoCents > 0 ? ` +${brl(servicoCents)}` : ''}</em>
              </span>
            </label>
          )}

          {share.capped && cappedBase > 0 && (
            <p className="muted small">{t('share.capped', { left: brl(remaining) })}</p>
          )}

          {/* aria-label, não só placeholder: um placeholder some no foco e não
              é rótulo pra leitor de tela. Numa tela de pagamento, o campo tem
              que continuar dizendo o que é depois que a pessoa começa a digitar. */}
          <Campo
            rotulo={t('payer.name')} maxLength={60} placeholder={t('payer.namePlaceholder')}
            // `name`: o teclado do telefone oferece o que a pessoa já tem
            // guardado. Num fluxo de pagamento, cada campo digitado à mão é uma
            // chance de desistir.
            autoComplete="name" enterKeyHint="next"
            value={payerLabel} onChange={(e) => setPayerLabel(e.target.value)}
          />
          {/* O documento do pagador só existe onde o TRILHO precisa dele. No
              Bizum quem autentica é o banco do pagador, no app dele, então
              pedir NIF aqui seria coletar dado sem necessidade — GDPR art.
              5(1)(c), a mesma regra do art. 6º III da LGPD. No Pix o gateway
              exige `customer.document` pra emitir a cobrança, e é essa
              necessidade que sustenta o campo. */}
          {taxIdRequired && (
          <Campo
            id="cpf-field"
            rotulo={t('payer.cpf')} inputMode="numeric" maxLength={14}
            // A FORMA sai do FORMATADOR, nao de uma string pontuada a mao: o censo
            // do `taxid.test.ts` existe porque toda pontuacao escrita a mao acaba
            // divergindo do formatador, e um placeholder e pontuacao escrita a mao.
            placeholder={maskCpfCnpj('00000000000')}
            aria-describedby="cpf-why"
            // A PONTUAÇÃO que um humano escreve, enquanto ele digita: o mesmo
            // `maskCpfCnpj` do cadastro do dono. Sem isso a pessoa conferia
            // onze dígitos colados num campo de pagamento.
            ruim={cpfHint && !cpfOk}
            recado={cpfHint && !cpfOk ? t('payer.cpfHint') : undefined}
            value={cpf}
            onChange={(e) => { setCpf(maskCpfCnpj(e.target.value)); if (isValidCPF(e.target.value)) setCpfHint(false); }}
          />
          )}
          {/* Por que o CPF. Um número de documento pedido numa tela de pagamento
              sem dizer pra quê é coleta sem transparência (LGPD art. 9º) — e,
              num bar, é também o motivo de alguém desistir de pagar. O destino
              é verdade conferida: `create-charge.js` manda pro PSP e o
              `registerCharge` NÃO guarda; webhook que traz CPF passa pelo
              `maskTaxId`. */}
          {taxIdRequired && <p className="muted small" id="cpf-why">{t('payer.cpfWhy')}</p>}

          {payError && (
            // `role="alert"`: a frase aparece depois de um toque, e quem usa
            // leitor de tela não vê nada aparecer.
            <p className="small" role="alert" style={{ color: 'var(--erro)' }}>
              {CONTA_MUDOU.has(payErrorCode || '') ? t('pay.retry', { error: payError }) : payError}
            </p>
          )}
          {/* O trilho decide a TELA, não só o rótulo. Em Espanha o Bizum tem o
              seu próprio elemento (o Express Checkout não suporta Bizum) e o
              caminho do Pix não existe — deixar o botão do Pix aqui chamaria o
              adaptador brasileiro numa conta em euro.

              Sem chave da Stripe o elemento não renderiza, e uma conta sem
              nenhuma forma de pagar é pior que um botão feio: cai no MESMO
              trilho pelo servidor, que na demo é o MockPsp. Um caminho, dois
              jeitos de chegar nele. */}
          {primaryRail === 'bizum' && STRIPE_READY ? (
            <>
              <Suspense fallback={null}>
              <BizumPay
                token={token}
                amountCents={cappedBase}
                tipCents={servicoCents}
                payerLabel={payerLabel.trim() || null}
                amountLabel={brl(totalToPay)}
                disabled={totalToPay === 0}
                onAuthorized={() => { /* o ✓ do Bizum depende da marca da cobrança — Espanha desligada; ver o backlog */ }}
              />
              </Suspense>
              {!STRIPE_READY && (
                <button className="cta" disabled={totalToPay === 0 || paying} onClick={onPayOnce}>
                  {t('pay.ctaBizum', { amount: brl(totalToPay) })}
                </button>
              )}
            </>
          ) : (
            <button className="cta" disabled={totalToPay === 0 || paying} onClick={onPayOnce}>
              {t('pay.cta', { amount: brl(totalToPay) })}
            </button>
          )}
          {/* Na mesa de demonstração a carteira é SIMULADA, mesmo com chave de
              produção configurada: a folha oficial do Google Pay tokeniza um
              cartão de verdade e pede CPF de verdade, e aqui não existe conta
              nenhuma pra pagar. Autorização sob premissa falsa (CDC) e CPF sem
              base legal (LGPD). O servidor é quem declara `venue.demo`. */}
          {/* A carteira do Pagar.me pede BRL ao Google Pay pelo gateway
              `pagarme` — numa mesa em euro seria a moeda errada pelo adquirente
              errado. Só aparece onde o mercado tem esse trilho. */}
          {rails.includes('pix') && (
          <WalletButtons
            token={token}
            amountCents={cappedBase}
            tipCents={servicoCents}
            payerLabel={payerLabel.trim() || null}
            payerDocument={cpfDigits}
            disabled={totalToPay === 0}
            venueName={venue.name}
            simulated={venue.demo === true}
            acceptsWallet={venue.acceptsWallet === true}
            onPaid={async (c) => {
              await refresh();
              // A COBRANÇA, não só o aviso: sem ela o comprovante deste trilho
              // sai sem quantia, sem serviço e sem data — e o `setPaidAt`
              // abaixo fica morto, porque a data só renderiza junto da quantia.
              setCharge((antes) => ({ ...(antes ?? {} as ChargeResult), ...c }));
              setPaidAt(new Date().toISOString());
              setStep('pago');
            }}
          />
          )}
          {/* `STRIPE_READY` E `acceptsCard`. O servidor liga `acceptsCard` quando
              ELE tem Stripe configurada; a chave publicável do BUILD é outra
              env, e este repositório já se queimou duas vezes com as duas
              divergindo. Sem a chave o elemento devolve `null` — e antes disto
              carregava a Stripe assim mesmo: rastreamento de terceiro com zero
              capacidade de cobrar. */}
          {STRIPE_READY && venue.acceptsCard && (
            <Suspense fallback={null}>
            <StripeWalletPay
              token={token}
              amountCents={cappedBase}
              tipCents={servicoCents}
              payerLabel={payerLabel.trim() || null}
              payerDocument={cpfDigits}
              disabled={totalToPay === 0}
              currency={currency}
              onPaid={async (c) => {
              await refresh();
              // A COBRANÇA, não só o aviso: sem ela o comprovante deste trilho
              // sai sem quantia, sem serviço e sem data — e o `setPaidAt`
              // abaixo fica morto, porque a data só renderiza junto da quantia.
              setCharge((antes) => ({ ...(antes ?? {} as ChargeResult), ...c }));
              setPaidAt(new Date().toISOString());
              setStep('pago');
            }}
            />
            </Suspense>
          )}
          {house && house.balanceCents > 0 && (
            <button className="ghost" onClick={() => setStep('saldo')}>
              {t('house.pay', { amount: brl(house.balanceCents) })}
            </button>
          )}
          {!house && houseBonusBp !== null && (
            <button
              className="linklike"
              onClick={() => { window.location.href = `/carteira?new=${encodeURIComponent(token)}`; }}
            >
              {houseBonusBp > 0
                ? t('house.bonus', { pct: pct(houseBonusBp) })
                : t('house.discover')}
            </button>
          )}
        </section>
      )}

      {/* `foot-aviso`: tres filhos, e o do meio e uma frase inteira. Em
          `space-between` o slogan virava quatro linhas de uma palavra. */}
      <footer className="foot foot-aviso">
        <span>{t('app.tagline')}</span>
        {/* O aviso do art. 9º vive AQUI, na tela da conta — ver PrivacyNotice.
            Leva o nome e o documento da CASA porque é ela a controladora, e um
            aviso que não identifica o controlador não cumpre o art. 9º III. */}
        <PrivacyNotice venue={venue.name} taxId={venue.taxId} market={venue.market} />
        <LangToggle compact />
      </footer>
    </Shell>
  );
}

/**
 * O bloco entalhado da linha (decisão #33). Máscara alfa aplicada por CSS mask,
 * então a tinta vem do `currentColor` de onde a linha estiver — o mesmo arquivo
 * imprime quase-preto na comanda e creme na mesa, sem uma segunda cópia.
 * Linha sem figura honesta (serviço, taxa) simplesmente não ganha uma.
 */
function Dish({ name }: { name: string }) {
  const cat = dishFor(name);
  if (!cat) return null;
  return <i className="dish" style={dishMask(cat)} aria-hidden="true" />;
}

/**
 * `?embed=1` — a landing mostra a conta ao vivo como um ESTADO, não como o app
 * inteiro: fica a comanda, a divisão e o valor do Pix; somem campos, carteiras
 * e rodapé (CSS `.shell.embed`). Nada muda no comportamento; só no que aparece.
 */
const EMBED = new URLSearchParams(window.location.search).get('embed') === '1';
function Shell({ children }: { children: React.ReactNode }) {
  return <main className={EMBED ? 'shell embed' : 'shell'}>{children}</main>;
}
