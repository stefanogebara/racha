import { useEffect, useState } from 'react';
import { api, ApiError, brl } from './api';

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

const PK = (import.meta.env.VITE_PAGARME_PUBLIC_KEY as string | undefined) || '';
const ACC = (import.meta.env.VITE_PAGARME_ACCOUNT_ID as string | undefined) || '';
const REAL = Boolean(PK && ACC);
// merchantId do Google (BCR2DN...) — exigido pelo Google Pay em PRODUCTION,
// dispensável em TEST. Diferente do acc_ do Pagar.me (gatewayMerchantId).
const GPAY_MERCHANT_ID = (import.meta.env.VITE_GOOGLE_PAY_MERCHANT_ID as string | undefined) || '';

// pay.js é singleton — carrega uma vez por página.
let gpayLoader: Promise<void> | null = null;
function loadGPayJs(): Promise<void> {
  if (!gpayLoader) {
    gpayLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://pay.google.com/gp/p/js/pay.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('não deu para carregar o Google Pay'));
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
  if (!g) throw new Error('Google Pay indisponível');
  return new g.payments.api.PaymentsClient({
    environment: PK.startsWith('pk_test_') ? 'TEST' : 'PRODUCTION',
  });
}
interface GPayClient {
  isReadyToPay(req: object): Promise<{ result: boolean }>;
  loadPaymentData(req: object): Promise<{ paymentMethodData: { tokenizationData: { token: string } } }>;
}

export default function WalletButtons({
  token, amountCents, tipCents, payerLabel, payerDocument, disabled, venueName, onPaid,
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
  onPaid: () => void;
}) {
  const [sheet, setSheet] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gpayReady, setGpayReady] = useState(false);
  const cpfDigits = payerDocument.replace(/\D/g, '');

  const total = amountCents + tipCents;

  useEffect(() => {
    if (!REAL) return;
    let alive = true;
    loadGPayJs()
      .then(() => gpayClient().isReadyToPay({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: [GPAY_CARD_METHOD] }))
      .then((r) => { if (alive) setGpayReady(r.result === true); })
      .catch(() => { if (alive) setGpayReady(false); }); // sem GPay no device → só Pix
    return () => { alive = false; };
  }, []);

  async function settle(wallet: Wallet, paymentToken: string, payerDocument?: string) {
    const charge = await api.payWallet(token, amountCents, tipCents, payerLabel, wallet, paymentToken, payerDocument);
    try {
      await api.devConfirm(charge.txid); // demo: confirma na hora
    } catch (e) {
      // PSP real: /api/dev/confirm não existe (404) — a confirmação chega
      // pelo webhook charge.paid e o polling da conta atualiza o progresso.
      if ((e as ApiError).status !== 404) throw e;
    }
    onPaid();
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
      if (status !== 'CANCELED') setError((e as Error).message); // fechar a sheet não é erro
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
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (REAL) {
    if (!gpayReady) return null; // device sem Google Pay → fica o Pix (e o saldo)
    return (
      <>
        <button
          type="button" className="walletbtn gpay"
          disabled={disabled || busy || cpfDigits.length !== 11}
          onClick={realGooglePay}
        >
          {busy ? 'autorizando…' : 'G Pay'}
        </button>
        {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
      </>
    );
  }

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
        <div className="sheetoverlay" role="dialog" aria-modal="true" aria-label={`Pagar com ${WALLET_LABEL[sheet]}`}>
          <div className="sheet">
            <p className="label">{WALLET_LABEL[sheet]}</p>
            <div className="checkrow">
              <span>Racha · {venueName}</span>
              <span className="mono">{brl(total)}</span>
            </div>
            {tipCents > 0 && (
              <p className="muted small">inclui {brl(tipCents)} de serviço para a equipe</p>
            )}
            <div className="checkrow">
              <span className="muted small">cartão</span>
              <span className="mono muted small">•••• 4242 (demo)</span>
            </div>
            <button className="cta" disabled={busy} onClick={() => demoAuthorize(sheet)}>
              {busy ? 'autorizando…' : `Pagar ${brl(total)}`}
            </button>
            <button className="linklike" disabled={busy} onClick={() => setSheet(null)}>cancelar</button>
            <p className="muted small center">simulação (demo) — nenhuma cobrança real é feita</p>
          </div>
        </div>
      )}
    </>
  );
}
