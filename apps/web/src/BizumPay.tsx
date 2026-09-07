import { useMemo, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { api, ApiError } from './api';
import { useT } from './lang';
import { tError } from './i18n';
import { bizumOutcome } from './bizumStatus';

/**
 * Bizum — o trilho principal da Espanha.
 *
 * **Por que não reusa o `StripeWalletPay`.** Aquele monta o *Express Checkout
 * Element*, e o Express Checkout Element **não suporta Bizum** (está na doc da
 * Stripe, na tabela de suporte por produto). Bizum precisa do *Payment
 * Element*, que é quem desenha o campo de telefone do Bizum. Duas telas, dois
 * elementos — não é duplicação por descuido.
 *
 * **O fluxo, e por que a espera é a parte importante.** O pagador põe o
 * telefone que tem registrado no Bizum e autoriza **no app do banco dele**.
 * Quando o `confirmPayment` volta, o pagamento normalmente está em
 * `processing`, não `succeeded`: quem confirma de verdade é o webhook, minutos
 * ou segundos depois. Então esta tela **não** declara sucesso — ela diz "espera
 * o teu banco" e deixa o poll da conta (`App`) avançar pro ✓ quando o dinheiro
 * chega. É o mesmo desenho do Pix: a tela não sabe que foi pago, o ledger sabe.
 *
 * Declarar sucesso aqui seria mostrar "pago" pra alguém que ainda não pagou —
 * e numa mesa, isso é o garçom liberando a mesa por causa de uma tela.
 */

const PK = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined) || '';

let stripePromise: Promise<Stripe | null> | null = null;
function getStripe(): Promise<Stripe | null> | null {
  if (!stripePromise && PK) stripePromise = loadStripe(PK);
  return stripePromise;
}

interface Props {
  token: string;
  amountCents: number;
  tipCents: number;
  payerLabel: string | null;
  disabled: boolean;
  /** O valor já formatado na moeda da casa — quem formata é quem sabe o idioma. */
  amountLabel: string;
  /** Chamado quando a autorização foi aceita — NÃO quando o dinheiro caiu. */
  onAuthorized: () => void;
}

function BizumInner({ token, amountCents, tipCents, payerLabel, amountLabel, onAuthorized }: Omit<Props, 'disabled'>) {
  const stripe = useStripe();
  const elements = useElements();
  const { t, lang } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [waiting, setWaiting] = useState(false);

  async function onConfirm() {
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setError('');
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) { setError(submitError.message || t('card.validateFail')); setBusy(false); return; }

      const intent = await api.stripeIntent(token, amountCents, tipCents, payerLabel, undefined, 'bizum');

      const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret: intent.clientSecret,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });
      if (confirmError) { setError(confirmError.message || t('card.incomplete')); setBusy(false); return; }

      // Espera é o caso NORMAL, e a lista é de FRACASSO, não de sucesso — ver
      // `bizumStatus.ts`. A API real devolve `requires_action` aqui, e a versão
      // anterior deste código só aceitava `processing`, então quem autorizava
      // no app do banco lia "pagamento não concluído".
      if (bizumOutcome(paymentIntent?.status) === 'waiting') {
        setWaiting(true);
        onAuthorized();
        return;
      }
      setError(t('card.incomplete'));
      setBusy(false);
    } catch (e) {
      // Erro do nosso servidor vem com CÓDIGO (limite do esquema, conta
      // fechada, trilho não atendido) — traduzido aqui, onde se sabe o idioma.
      const err = e as ApiError;
      setError(tError(lang, err.code, (e as Error).message, err.vars));
      setBusy(false);
    }
  }

  if (waiting) {
    return (
      <div className="bizum">
        <p className="muted small center">{t('bizum.waiting')}</p>
      </div>
    );
  }

  return (
    <div className="bizum">
      <p className="label">{t('bizum.title')}</p>
      <PaymentElement options={{ layout: 'tabs' }} />
      <p className="muted small">{t('bizum.how')}</p>
      <button className="cta" disabled={busy} onClick={onConfirm}>
        {busy ? t('pix.simulating') : t('pay.ctaBizum', { amount: amountLabel })}
      </button>
      {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
    </div>
  );
}

export default function BizumPay({
  token, amountCents, tipCents, payerLabel, amountLabel, disabled, onAuthorized,
}: Props) {
  const stripe = getStripe();
  const total = amountCents + tipCents;

  // O elemento é montado no modo deferred, com o valor e a moeda do mercado.
  const options = useMemo(() => ({
    mode: 'payment' as const,
    amount: Math.max(1, total),
    currency: 'eur',
    paymentMethodTypes: ['bizum'],
  }), [total]);

  // Sem chave publicável, desabilitado, ou valor zero → não renderiza nada. Uma
  // tela de pagamento que não pode cobrar não deve aparecer.
  if (!PK || !stripe || disabled || total === 0) return null;

  return (
    <Elements stripe={stripe} options={options}>
      <BizumInner
        token={token}
        amountCents={amountCents}
        tipCents={tipCents}
        payerLabel={payerLabel}
        amountLabel={amountLabel}
        onAuthorized={onAuthorized}
      />
    </Elements>
  );
}
