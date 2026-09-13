import { useCallback, useEffect, useState } from 'react';
import { authedReq as req } from './auth';
import { useT } from './lang';

/**
 * "Cartão / Apple Pay (Stripe)" — o 2º rail, por venue. O Pix (Pagar.me) segue
 * no AdminRecipient; aqui o dono conecta uma conta Stripe (Connect) pra também
 * aceitar cartão/Apple Pay/Google Pay. Diferente do recebedor Pagar.me, NÃO há
 * formulário bancário: o KYC/dados da conta são preenchidos na hosted page da
 * Stripe (nada disso passa pelo Racha). O POST cria/reusa a conta conectada e
 * devolve o link de onboarding; o GET reflete se já dá pra cobrar.
 *
 * Inerte enquanto o backend não tiver STRIPE_SECRET_KEY: o POST responde 503 e
 * o botão mostra o motivo. Só aparece dinheiro real depois de conta Connect +
 * KYC aprovado + parecer jurídico (regra nº4).
 */

interface StripeStatus {
  /** false = Stripe nem está ligado no ambiente → a seção some (sem botão morto). */
  available?: boolean;
  accountId: string | null;
  status: string | null; // 'active' | 'pending' | 'registration' | null
  chargesEnabled: boolean;
}

export default function AdminStripe({ venueId }: { venueId: string }) {
  const { t, tErr } = useT();
  const [info, setInfo] = useState<StripeStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await req<StripeStatus>(`/api/psp/stripe-connect?v=${encodeURIComponent(venueId)}`));
      setLoadError(null);
    } catch (e) {
      setLoadError(tErr(e));
      setInfo((prev) => prev ?? { accountId: null, status: null, chargesEnabled: false });
    }
  }, [venueId, tErr]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function connect() {
    setBusy(true); setErr(null);
    try {
      const r = await req<{ accountId: string; onboardingUrl: string }>('/api/psp/stripe-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId }),
      });
      // Manda o dono pra hosted page de KYC da Stripe — dados bancários lá, não aqui.
      window.location.href = r.onboardingUrl;
    } catch (e) {
      setErr(tErr(e));
      setBusy(false);
    }
  }

  if (!info) {
    return (
      <section className="panel">
        <p className="label">{t('stripe.title')}</p>
        <p className="muted small">{loadError ?? 'carregando…'}</p>
      </section>
    );
  }

  // Stripe não ligado no ambiente → não mostra a seção (evita botão que só 503).
  if (info.available === false) return null;

  const active = info.chargesEnabled;
  const pending = Boolean(info.accountId) && !active;

  return (
    <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="label">{t('stripe.title')}</p>
      <p className="muted small">{t('stripe.blurb')}</p>

      {active && <span className="pill paga" style={{ alignSelf: 'flex-start' }}>{t('stripe.active')}</span>}
      {pending && <span className="pill parcial" style={{ alignSelf: 'flex-start' }}>{t('stripe.pending')}</span>}

      {err && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{err}</p>}
      {loadError && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{loadError}</p>}

      {!active && (
        <button className="cta" style={{ padding: '12px 20px', alignSelf: 'flex-start' }} disabled={busy} onClick={connect}>
          {busy ? t('stripe.opening') : (pending ? t('stripe.continue') : t('stripe.connect'))}
        </button>
      )}
      {active && (
        <button className="linklike" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={connect}>
          reabrir configurações na Stripe
        </button>
      )}
    </section>
  );
}
