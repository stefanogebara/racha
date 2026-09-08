import { useEffect, useMemo, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { api, ApiError } from './api';
import { useT } from './lang';
import { tError, STRIPE_LOCALE } from './i18n';
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
  /** A espera passou do razoável e a tela oferece uma saída. */
  const [stalled, setStalled] = useState(false);

  // 45 s. Autorizar no app do banco leva segundos; recusar leva menos. Passado
  // isso, o silêncio provavelmente é uma recusa que ninguém nos contou — e uma
  // pessoa em pé numa mesa merece uma saída antes de desistir do produto.
  useEffect(() => {
    if (!waiting) return;
    const id = window.setTimeout(() => setStalled(true), 45_000);
    return () => window.clearTimeout(id);
  }, [waiting]);

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
        {/* A espera precisa TER FIM.
            Antes esta tela era terminal: uma vez em `waiting`, ela só desenhava
            "esperando o teu banco" pra sempre. Quem recusasse no app do banco
            ficava ali, na mesa, com o garçom esperando — e o Bizum é o trilho
            PRINCIPAL da Espanha, então era o caminho comum.
            A causa é que o servidor não sabe da recusa: o adaptador não
            interpreta `payment_intent.payment_failed`, então nada avisa a tela.
            Consertar o servidor é a resposta longa; dar uma saída é a curta, e
            é a que tira a pessoa do beco.
            E a saída não AFIRMA nada: o pagamento pode estar a caminho, então a
            cópia diz só o que se sabe — que nada chegou ainda. Voltar não
            cancela nada, e o poll da conta continua: se o dinheiro cair, a
            tela avança pro ✓ de qualquer forma. */}
        {stalled && (
          <>
            <p className="muted small center">{t('bizum.stalled')}</p>
            <p className="muted small center">{t('bizum.stalledHow')}</p>
            <button className="ghost" onClick={() => { setWaiting(false); setStalled(false); setBusy(false); }}>
              {t('bizum.backToBill')}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="bizum">
      <p className="label">{t('bizum.title')}</p>
      {/* Nada de instrução nossa aqui. Visto na tela (2026-09-07): o próprio
          elemento da Stripe já desenha "autoriza el pago en tu aplicación
          bancaria del móvil", no idioma do leitor, logo acima — a nossa frase
          aparecia colada embaixo dizendo o mesmo com outras palavras. Duas
          instruções seguidas na hora de pagar fazem a pessoa reler pra
          descobrir se são a mesma coisa. A explicação continua no `App`, na
          tela de cobrança criada, onde o elemento NÃO existe. */}
      <PaymentElement options={{ layout: 'tabs' }} />
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
  const { lang } = useT();
  const total = amountCents + tipCents;

  // O elemento é montado no modo deferred, com o valor e a moeda do mercado.
  //
  // `locale` não é enfeite aqui. Visto na tela (2026-09-07) contra a Stripe de
  // verdade: sem ele o elemento do Bizum desenhava "Phone number", a lista de
  // países e o aviso legal do Open Bank em INGLÊS dentro de uma conta espanhola
  // com a tela em espanhol. É a única parte da tela de pagar que o seletor não
  // alcançava — e é a parte que PEDE UM DADO PESSOAL e nomeia um segundo
  // responsável pelo tratamento. Um aviso de privacidade que a pessoa não lê
  // não é um aviso (GDPR art. 12: linguagem clara e acessível).
  const options = useMemo(() => ({
    mode: 'payment' as const,
    amount: Math.max(1, total),
    currency: 'eur',
    paymentMethodTypes: ['bizum'],
    locale: STRIPE_LOCALE[lang],
  }), [total, lang]);

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
