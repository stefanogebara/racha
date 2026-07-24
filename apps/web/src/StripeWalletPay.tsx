import { useMemo, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, ExpressCheckoutElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { api } from './api';

/**
 * Apple Pay / Google Pay / cartão via STRIPE (2º rail) — o Express Checkout
 * Element. Aparece só quando o restaurante tem conta Stripe conectada
 * (view.venue.acceptsCard) E a VITE_STRIPE_PUBLISHABLE_KEY existe. O Pix segue
 * no Pagar.me; este é o caminho de cartão/carteira.
 *
 * Fluxo deferred (recomendado): monta o Element com mode:'payment'+amount, e no
 * onConfirm: elements.submit() → cria o PaymentIntent no backend (destination
 * charge pro restaurante) → stripe.confirmPayment com o clientSecret. A
 * confirmação de verdade chega pelo /api/webhooks/stripe; o polling da conta
 * (App) pega e avança pro ✓ — mesmo caminho do Pix.
 */

const PK = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined) || '';

// loadStripe é singleton — carrega uma vez por página.
let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> | null {
  if (!stripePromise && PK) stripePromise = loadStripe(PK);
  return stripePromise;
}

interface InnerProps {
  token: string;
  amountCents: number;
  tipCents: number;
  payerLabel: string | null;
  payerDocument: string;
  onPaid: () => void;
  onError: (msg: string) => void;
}

function ExpressInner({ token, amountCents, tipCents, payerLabel, payerDocument, onPaid, onError }: InnerProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  async function onConfirm() {
    if (!stripe || !elements || busy) return;
    setBusy(true);
    onError('');
    try {
      // 1) valida/coleta os dados do Element (exigência do deferred flow).
      const { error: submitError } = await elements.submit();
      if (submitError) { onError(submitError.message || 'não deu para validar o pagamento'); setBusy(false); return; }
      // 2) cria o PaymentIntent no backend (destination charge pro restaurante).
      const intent = await api.stripeIntent(token, amountCents, tipCents, payerLabel, payerDocument || undefined);
      // 3) confirma com a carteira (Apple/Google Pay) ou cartão.
      const { error } = await stripe.confirmPayment({
        elements,
        clientSecret: intent.clientSecret,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required', // carteira confirma sem sair da página
      });
      if (error) { onError(error.message || 'pagamento não concluído'); setBusy(false); return; }
      onPaid(); // sucesso — o webhook confirma no ledger, o poll mostra o ✓
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  }

  return <ExpressCheckoutElement onConfirm={onConfirm} options={{ paymentMethods: { link: 'never' } }} />;
}

export default function StripeWalletPay({
  token, amountCents, tipCents, payerLabel, payerDocument, disabled, onPaid,
}: {
  token: string;
  amountCents: number;
  tipCents: number;
  payerLabel: string | null;
  payerDocument: string;
  disabled: boolean;
  onPaid: () => void;
}) {
  const stripe = getStripe();
  const [error, setError] = useState<string>('');
  const total = amountCents + tipCents;

  const options = useMemo(() => ({
    mode: 'payment' as const,
    amount: Math.max(1, total),
    currency: 'brl',
  }), [total]);

  // Sem chave publicável, desabilitado, ou valor zero → não renderiza nada.
  if (!PK || !stripe || disabled || total === 0) return null;

  return (
    <div className="stripewallet">
      <Elements stripe={stripe} options={options}>
        <ExpressInner
          token={token}
          amountCents={amountCents}
          tipCents={tipCents}
          payerLabel={payerLabel}
          payerDocument={payerDocument}
          onPaid={onPaid}
          onError={setError}
        />
      </Elements>
      {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
    </div>
  );
}
