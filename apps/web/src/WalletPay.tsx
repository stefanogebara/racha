
import { useT } from './lang';import { useEffect, useState } from 'react';
import { api, ApiError, type ChargeResult } from './api';

/**
 * Apple Pay / Google Pay — cobrança de CARTÃO tokenizada pelo mesmo portão de
 * dinheiro do Pix (POST /api/pay com wallet + paymentToken).
 *
 * Dois modos, decididos por env:
 * - REAL (VITE_PAGARME_PUBLIC_KEY + VITE_PAGARME_ACCOUNT_ID presentes):
 *   botão oficial do Google Pay (pay.js), tokenization PAYMENT_GATEWAY com
 *   gateway "pagarme" — o token da sheet vai direto pro adapter como
 *   card_token (docs.pagar.me/docs/google-pay-tm-guide). pk_test_ roda no
 *   environment TEST do Google. Apple Pay fica OCULTO no modo real: o
 *   Pagar.me não tem Apple Pay web hoje (decisão em docs/psp/README.md) —
 *   botão morto que recusa todo tap é pior que não ter botão.
 * - DEMO (sem as envs): sheet simulada claramente rotulada, token de teste,
 *   confirmação via /api/dev/confirm — o caminho do mock PSP.
 */

type Wallet = 'apple_pay' | 'google_pay';
const WALLET_LABEL: Record<Wallet, string> = { apple_pay: 'Apple Pay', google_pay: 'Google Pay' };

const PK = (import.meta.env.VITE_PAGARME_PUBLIC_KEY) || '';
const ACC = (import.meta.env.VITE_PAGARME_ACCOUNT_ID) || '';
const REAL = Boolean(PK && ACC);
// merchantId do Google (BCR2DN...) — exigido pelo Google Pay em PRODUCTION,
// dispensável em TEST. Diferente do acc_ do Pagar.me (gatewayMerchantId).
const GPAY_MERCHANT_ID = (import.meta.env.VITE_GOOGLE_PAY_MERCHANT_ID) || '';

/// An error thrown from module scope carries a dictionary key; anything else
/// is already a sentence from the wallet SDK and is shown as it came. The two
/// keys are listed rather than matched by prefix so the dictionary's Key union
/// still checks the lookup — a renamed key becomes a compile error here instead
/// of a raw "card.gpayFail" on someone's screen.
function asMessage(t: (k: 'card.gpayFail' | 'card.gpayOut') => string, e: unknown): string {
  const raw = (e as Error).message || '';
  if (raw === 'card.gpayFail' || raw === 'card.gpayOut') return t(raw);
  return raw;
}

// pay.js é singleton — carrega uma vez por página.
let gpayLoader: Promise<void> | null = null;
function loadGPayJs(): Promise<void> {
  if (!gpayLoader) {
    gpayLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://pay.google.com/gp/p/js/pay.js';
      s.async = true;
      s.onload = () => resolve();
      // A code, not a sentence: this helper runs outside React and has no
      // reader. Same rule the server follows (CLAUDE.md) — the side that knows
      // the language does the translating.
      s.onerror = () => reject(new Error('card.gpayFail'));
      document.head.appendChild(s);
    });
  }
  return gpayLoader;
}

const GPAY_CARD_METHOD = {
  type: 'CARD',
  parameters: {
    allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
    // Bandeiras compatíveis com o gateway Pagar.me (guia Google Pay deles).
    allowedCardNetworks: ['MASTERCARD', 'VISA'],
  },
  tokenizationSpecification: {
    type: 'PAYMENT_GATEWAY',
    parameters: { gateway: 'pagarme', gatewayMerchantId: ACC },
  },
};

function gpayClient() {
  const g = (window as unknown as { google?: { payments: { api: { PaymentsClient: new (o: object) => GPayClient } } } }).google;
  if (!g) throw new Error('card.gpayOut');
  return new g.payments.api.PaymentsClient({
    environment: PK.startsWith('pk_test_') ? 'TEST' : 'PRODUCTION',
  });
}
interface GPayClient {
  isReadyToPay(req: object): Promise<{ result: boolean }>;
  loadPaymentData(req: object): Promise<{ paymentMethodData: { tokenizationData: { token: string } } }>;
}

export default function WalletButtons({
  token, amountCents, tipCents, payerLabel, payerDocument, disabled, venueName, simulated = false, acceptsWallet = false, onPaid,
}: {
  token: string;
  amountCents: number;
  tipCents: number;
  payerLabel: string | null;
  /** CPF (só dígitos) vindo do campo único da tela da conta — o adquirente
   *  exige documento do customer em todo método. */
  payerDocument: string;
  disabled: boolean;
  venueName: string;
  /** Mesa de demonstração: força a folha SIMULADA mesmo com chave real
   *  configurada. Sem isto, a demo abriria a folha oficial do Google Pay em
   *  PRODUCTION e tokenizaria um cartão de verdade pra uma conta que não
   *  existe — achado CRÍTICO da revisão de compliance. */
  simulated?: boolean;
  /**
   * A casa tem recebedor de verdade, declarado PELO SERVIDOR.
   *
   * Sem isto o portão era só a chave de build, que é do deploy e não da casa:
   * toda conta brasileira baixava o `pay.google.com/gp/p/js/pay.js` e rodava
   * `isReadyToPay` — sondagem de aparelho e carteira — antes de a pessoa
   * tocar em nada. Mesmo contrato do `acceptsCard` do trilho Stripe.
   */
  acceptsWallet?: boolean;
  /**
   * O COMPROVANTE precisa da cobrança, não de um aviso de que houve uma.
   *
   * Isto era `() => void`: a carteira tinha a `ChargeResult` na mão (`settle`)
   * e a jogava fora, então a tela de pago não sabia o valor e o comprovante
   * saía sem quantia, sem linha de serviço e sem data — justo no trilho em que
   * o cliente tem uma FATURA de cartão pra conferir contra.
   */
  onPaid: (charge: ChargeResult) => void;
}) {
  const { t, brl } = useT();
  const real = REAL && !simulated && acceptsWallet;
  const [sheet, setSheet] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gpayReady, setGpayReady] = useState(false);
  const cpfDigits = payerDocument.replace(/\D/g, '');

  const total = amountCents + tipCents;

  useEffect(() => {
    if (!real) return;
    let alive = true;
    loadGPayJs()
      .then(() => gpayClient().isReadyToPay({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: [GPAY_CARD_METHOD] }))
      .then((r) => { if (alive) setGpayReady(r.result === true); })
      .catch(() => { if (alive) setGpayReady(false); }); // sem GPay no device → só Pix
    return () => { alive = false; };
  }, [real]);

  async function settle(wallet: Wallet, paymentToken: string, payerDocument?: string) {
    const charge = await api.payWallet(token, amountCents, tipCents, payerLabel, wallet, paymentToken, payerDocument);
    try {
      await api.devConfirm(charge.txid); // demo: confirma na hora
    } catch (e) {
      // PSP real: /api/dev/confirm não existe (404) — a confirmação chega
      // pelo webhook charge.paid e o polling da conta atualiza o progresso.
      if ((e as ApiError).status !== 404) throw e;
    }
    onPaid(charge);
  }

  // --- modo REAL: sheet oficial do Google -----------------------------------
  async function realGooglePay() {
    setBusy(true); setError(null);
    try {
      const data = await gpayClient().loadPaymentData({
        apiVersion: 2,
        apiVersionMinor: 0,
        allowedPaymentMethods: [GPAY_CARD_METHOD],
        transactionInfo: {
          totalPriceStatus: 'FINAL',
          totalPrice: (total / 100).toFixed(2),
          currencyCode: 'BRL',
          countryCode: 'BR',
        },
        merchantInfo: {
          merchantName: `Racha · ${venueName}`.slice(0, 60),
          // PRODUCTION exige o merchantId (BCR2DN...) do Wallet Console; em
          // TEST é dispensável. Omitido quando não setado (segue no TEST).
          ...(GPAY_MERCHANT_ID ? { merchantId: GPAY_MERCHANT_ID } : {}),
        },
      });
      await settle('google_pay', data.paymentMethodData.tokenizationData.token, cpfDigits);
    } catch (e) {
      const status = (e as { statusCode?: string }).statusCode;
      if (status !== 'CANCELED') setError(asMessage(t, e)); // fechar a sheet não é erro
    } finally {
      setBusy(false);
    }
  }

  // --- modo DEMO: sheet simulada -------------------------------------------
  async function demoAuthorize(wallet: Wallet) {
    setBusy(true); setError(null);
    try {
      // PSP real: este token viria da sheet nativa.
      const paymentToken = `tok_demo_${crypto.randomUUID().replace(/-/g, '')}`;
      await settle(wallet, paymentToken);
      setSheet(null);
    } catch (e) {
      setError(asMessage(t, e));
    } finally {
      setBusy(false);
    }
  }

  if (real) {
    if (!gpayReady) return null; // device sem Google Pay → fica o Pix (e o saldo)
    return (
      <>
        {/* O BOTÃO NÃO FICA CINZA EM SILÊNCIO.
            Sem CPF ele era desabilitado sem uma palavra — o modo de falha que a
            tela da conta já tinha consertado pro Pix ("ficava cinza em silêncio
            e parecia quebrado"), repetido aqui. Agora ele é tocável e DIZ o que
            falta, com a mesma frase do Pix, e leva o foco pro campo. */}
        <button
          type="button" className="walletbtn gpay"
          disabled={disabled || busy}
          onClick={() => {
            if (cpfDigits.length !== 11) {
              setError(t('payer.cpfHint'));
              document.getElementById('cpf-field')?.focus();
              return;
            }
            setError(null);
            void realGooglePay();
          }}
        >
          {busy ? t('wallet.authorizing') : 'G Pay'}
        </button>
        <p className="muted small" role="alert" style={{ margin: 0 }}>
          {error && <span style={{ color: 'var(--erro)' }}>{error}</span>}
        </p>
      </>
    );
  }

  // Os botões de DEMONSTRAÇÃO só na casa de demonstração. Em qualquer outra —
  // casa sem recebedor de verdade, build sem as chaves — o componente caía aqui e
  // mostrava Apple Pay e Google Pay que abriam uma folha "simulação (demo)" com
  // "•••• 4242" pra um cliente de verdade (auditoria de UI, C2).
  if (!simulated) return null;

  // Ordem por plataforma no demo: Apple primeiro em iOS/macOS.
  const isApple = typeof (window as unknown as { ApplePaySession?: unknown }).ApplePaySession !== 'undefined'
    || /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  const wallets: Wallet[] = isApple ? ['apple_pay', 'google_pay'] : ['google_pay', 'apple_pay'];

  return (
    <>
      <div className="walletrow">
        {wallets.map((w) => (
          <button
            key={w}
            type="button"
            className={`walletbtn ${w === 'apple_pay' ? 'apple' : 'gpay'}`}
            disabled={disabled}
            onClick={() => { setError(null); setSheet(w); }}
          >
            {w === 'apple_pay' ? ' Pay' : 'G Pay'}
          </button>
        ))}
      </div>
      {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}

      {sheet && (
        <div className="sheetoverlay" role="dialog" aria-modal="true" aria-label={t('wallet.payWith', { wallet: WALLET_LABEL[sheet] })}>
          <div className="sheet">
            <p className="label">{WALLET_LABEL[sheet]}</p>
            <div className="checkrow">
              <span>Racha · {venueName}</span>
              <span className="mono">{brl(total)}</span>
            </div>
            {/* A divulgação do SERVIÇO no momento de autorizar — era português
                cru, e quem não lê português autorizava sem saber que parte do
                valor é serviço (CDC art. 6º III / art. 31). A chave já existia. */}
            {tipCents > 0 && (
              <p className="muted small">{t('pix.includesTip', { amount: brl(tipCents) })}</p>
            )}
            <div className="checkrow">
              <span className="muted small">{t('card.word')}</span>
              <span className="mono muted small">{t('card.demoCard')}</span>
            </div>
            <button className="cta" disabled={busy} onClick={() => demoAuthorize(sheet)}>
              {busy ? t('wallet.authorizing') : t('wallet.payAmount', { amount: brl(total) })}
            </button>
            <button className="linklike" disabled={busy} onClick={() => setSheet(null)}>{t('wallet.cancel')}</button>
            <p className="muted small center">{t('card.demoNote')}</p>
          </div>
        </div>
      )}
    </>
  );
}
