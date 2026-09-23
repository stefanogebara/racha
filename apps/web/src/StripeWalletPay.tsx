import { useMemo, useState } from 'react';
/**
 * `/pure` — o import NÃO injeta o script.
 *
 * O entrypoint normal do `@stripe/stripe-js` tem um `loadScript(null)` no corpo
 * do módulo (9.12.0, `dist/index.mjs`): IMPORTAR já injeta o `js.stripe.com` e
 * dispara a impressão digital, mesmo que o componente devolva `null`. Foi o que
 * fez uma conta de Pix brasileira chamar a Stripe. Pôr o componente atrás de
 * `lazy` resolveu o caso medido; isto resolve a CLASSE, porque o script passa a
 * depender de alguém chamar `loadStripe(PK)` — e essa chamada já exige a chave.
 * Um refactor que mova a renderização não derruba mais a garantia.
 */
import { loadStripe } from '@stripe/stripe-js/pure';
// O TIPO vem do entrypoint normal — `import type` é apagado na compilação, não
// sobra `require`/`import` nenhum no bundle e portanto não injeta script.
import type { Stripe } from '@stripe/stripe-js';
import { Elements, ExpressCheckoutElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { api } from './api';
import { urlDeVolta } from './payReturn';
import { useT } from './lang';
import { STRIPE_LOCALE, type CurrencyCode } from './i18n';

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

const PK = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY) || '';

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
  /** O comprovante precisa do valor cobrado — ver `WalletPay`. */
  onPaid: (charge: { txid: string; method: 'card' | 'bizum'; amountCents: number; tipCents: number; checkId?: string }) => void;
  onError: (msg: string) => void;
}

function ExpressInner({ token, amountCents, tipCents, payerLabel, payerDocument, onPaid, onError }: InnerProps) {
  const stripe = useStripe();
  const elements = useElements();
  const { t, tErr } = useT();
  const [busy, setBusy] = useState(false);

  async function onConfirm() {
    if (!stripe || !elements || busy) return;
    setBusy(true);
    onError('');
    try {
      // 1) valida/coleta os dados do Element (exigência do deferred flow).
      const { error: submitError } = await elements.submit();
      // A MENSAGEM DA STRIPE É EM INGLÊS, SEMPRE. `error.message` vem do SDK
      // dela — "Your card was declined", "Amount must be no less than 0.50
      // EUR" — e ia crua pra tela de quem está jantando no Brasil. É
      // exatamente a falha que o `lang.tsx` diz que a conversão de vinte e uma
      // telas resolveu, sobrevivendo na tela de PAGAMENTO, que é a de maior
      // aposta do produto. A frase da Stripe fica de RESERVA do nosso código,
      // não no lugar dele. Achado pela revisão de segurança de 2026-09-13.
      if (submitError) { onError(t('card.validateFail')); setBusy(false); return; }
      // 2) cria o PaymentIntent no backend (destination charge pro restaurante).
      const intent = await api.stripeIntent(token, amountCents, tipCents, payerLabel, payerDocument || undefined);
      // 3) confirma com a carteira (Apple/Google Pay) ou cartão.
      const { error } = await stripe.confirmPayment({
        elements,
        clientSecret: intent.clientSecret,
        // NÃO `window.location.href`: ele carrega o `?t=` da mesa, e a
        // Stripe guarda o `return_url` no PaymentIntent. Ver `payReturn.ts`.
        confirmParams: { return_url: urlDeVolta() },
        redirect: 'if_required', // carteira confirma sem sair da página
      });
      if (error) { onError(t('card.incomplete')); setBusy(false); return; }
      // Os centavos vêm do que foi MANDADO pro intent, não recomputados do
      // elemento: é o valor que a Stripe autorizou.
      // `checkId` vem do INTENT, não é reconstruído: é a conta em que a
      // cobrança nasceu, e é a ela que o recibo se prende. A primeira versão
      // deste conserto acrescentou o campo no servidor e este objeto montado à
      // mão o jogava fora — no trilho de cartão o recibo continuaria preso à
      // conta que o poll trouxesse.
      // A COBRANÇA INTEIRA DESTE TRILHO, e não um pedaço: o `App` monta o
      // comprovante a partir disto, do zero. Mandando só os centavos, ele
      // completava com os campos da cobrança ANTERIOR — um Pix gerado e
      // abandonado deixava o `txid`, o copia-e-cola e o `method: 'pix'` dele
      // num comprovante de cartão (compliance, terceira rodada).
      onPaid({ txid: intent.txid, method: intent.method, amountCents, tipCents, checkId: intent.checkId }); // o webhook confirma no ledger, o poll mostra o ✓
    } catch (e) {
      onError(tErr(e));
      setBusy(false);
    }
  }

  return <ExpressCheckoutElement onConfirm={onConfirm} options={{ paymentMethods: { link: 'never' } }} />;
}

export default function StripeWalletPay({
  token, amountCents, tipCents, payerLabel, payerDocument, disabled, onPaid, currency,
}: {
  token: string;
  amountCents: number;
  tipCents: number;
  payerLabel: string | null;
  payerDocument: string;
  disabled: boolean;
  /** O comprovante precisa do valor cobrado — ver `WalletPay`. */
  onPaid: (charge: { txid: string; method: 'card' | 'bizum'; amountCents: number; tipCents: number; checkId?: string }) => void;
  /** A moeda da CASA, vinda do servidor (`view.venue.currency`). Sem padrão. */
  currency: CurrencyCode;
}) {
  const stripe = getStripe();
  const { lang } = useT();
  const [error, setError] = useState<string>('');
  const total = amountCents + tipCents;

  // `locale` faz o elemento da Stripe obedecer ao seletor de idioma. Sem ele a
  // folha cai no idioma do NAVEGADOR — o telefone de um turista mostra a folha
  // de pagamento numa língua que a conta ao lado não fala. Ver `STRIPE_LOCALE`.
  const options = useMemo(() => ({
    mode: 'payment' as const,
    amount: Math.max(1, total),
    // A moeda vem da CASA, não de um literal.
    //
    // Era `'brl'` fixo, e este componente aparece pra qualquer venue com
    // `acceptsCard` — inclusive espanhola, porque `MARKETS.es.rails` inclui
    // 'card'. O servidor agora cria o intent em EURO certo, então a folha do
    // Apple/Google Pay ou cotava a moeda errada pro pagador, ou o
    // `confirmPayment` estourava com um erro de integração da Stripe em inglês
    // cru na tela. Nos dois casos é autorização obtida sobre um valor que não
    // é o valor. Achado da revisão de compliance de 2026-09-07.
    currency: currency.toLowerCase(),
    locale: STRIPE_LOCALE[lang],
  }), [total, lang, currency]);

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
      {error && <p className="muted small" style={{ color: 'var(--erro)' }}>{error}</p>}
    </div>
  );
}
