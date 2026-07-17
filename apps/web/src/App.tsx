import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, brl, CheckView, ChargeResult } from './api';

/**
 * Racha diner flow — one screen, three acts:
 *   1. a conta (live check: items, total, quanto falta)
 *   2. sua parte (dividir igual / outro valor) + serviço opcional
 *   3. Pix (copia-e-cola) → confirmação
 * No login, no app. Centavo-exact math mirrors the backend split engine
 * (largest-remainder); the backend re-validates everything — this UI is
 * advisory, the API is the gate.
 */

type Step = 'conta' | 'pagar' | 'pago';

function splitEqualLocal(totalCents: number, parts: number, index: number): number {
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents % parts;
  return base + (index < remainder ? 1 : 0);
}

export default function App() {
  const token = useMemo(
    () => new URLSearchParams(window.location.search).get('t') ?? '',
    [],
  );
  const [view, setView] = useState<CheckView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<'igual' | 'valor'>('igual');
  const [people, setPeople] = useState(2);
  const [customValue, setCustomValue] = useState('');
  const [servicoOn, setServicoOn] = useState(true);
  const [payerLabel, setPayerLabel] = useState('');

  const [step, setStep] = useState<Step>('conta');
  const [charge, setCharge] = useState<ChargeResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setView(await api.getCheck(token));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!token) return <Shell><p className="muted center">Escaneie o QR da sua mesa para ver a conta.</p></Shell>;
  if (error) return <Shell><p className="muted center">{error}</p></Shell>;
  if (!view) return <Shell><p className="muted center">carregando a conta…</p></Shell>;

  const { venue, table, state } = view;
  const remaining = Math.max(0, state.totalCents - state.paidCents);
  const progress = state.totalCents > 0 ? Math.min(100, (state.paidCents / state.totalCents) * 100) : 0;

  const baseCents =
    mode === 'igual'
      ? splitEqualLocal(remaining, Math.max(people, 1), 0)
      : Math.max(0, Math.round(parseFloat(customValue.replace(',', '.') || '0') * 100));
  const cappedBase = Math.min(baseCents, remaining);
  const servicoCents = servicoOn
    ? Math.floor((cappedBase * venue.servicoBp + 5000) / 10000)
    : 0;
  const totalToPay = cappedBase + servicoCents;

  async function onPay() {
    try {
      const result = await api.pay(token, cappedBase, servicoCents, payerLabel.trim() || null);
      setCharge(result);
      setStep('pagar');
      setCopied(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onCopy() {
    if (!charge) return;
    await navigator.clipboard.writeText(charge.copiaECola).catch(() => {});
    setCopied(true);
  }

  // Demo affordance: stands in for the diner's bank app.
  async function onDevConfirm() {
    if (!charge) return;
    setConfirming(true);
    try {
      await api.devConfirm(charge.txid);
      await refresh();
      setStep('pago');
    } finally {
      setConfirming(false);
    }
  }

  if (step === 'pagar' && charge) {
    return (
      <Shell>
        <header className="head">
          <span className="venue">{venue.name}</span>
          <span className="mesa">{table.label}</span>
        </header>
        <section className="pixcard">
          <p className="label">Pague com Pix</p>
          <p className="bigmoney">{brl(charge.amountCents + charge.tipCents)}</p>
          {charge.tipCents > 0 && (
            <p className="muted small">inclui {brl(charge.tipCents)} de serviço para a equipe</p>
          )}
          <div className="codebox" aria-label="Pix copia e cola">
            {charge.copiaECola.slice(0, 64)}…
          </div>
          <button className="cta" onClick={onCopy}>
            {copied ? 'Código copiado ✓' : 'Copiar código Pix'}
          </button>
          <p className="muted small center">
            Abra o app do seu banco, escolha Pix copia-e-cola e cole o código.
          </p>
          <button className="ghost" onClick={onDevConfirm} disabled={confirming}>
            {confirming ? 'confirmando…' : '✓ Simular confirmação do banco (demo)'}
          </button>
          <button className="linklike" onClick={() => setStep('conta')}>← voltar pra conta</button>
        </section>
      </Shell>
    );
  }

  if (step === 'pago') {
    return (
      <Shell>
        <section className="paid">
          <div className="paidmark">✓</div>
          <h2>Pagamento confirmado</h2>
          <p className="muted">
            {payerLabel ? `Valeu, ${payerLabel}! ` : ''}Sua parte está paga.
          </p>
          <div className="progresswrap">
            <div className="progressbar"><span style={{ width: `${progress}%` }} /></div>
            <p className="muted small">
              {brl(state.paidCents)} de {brl(state.totalCents)} pagos
              {remaining > 0 ? ` — falta ${brl(remaining)}` : ' — conta fechada 🎉'}
            </p>
          </div>
          {remaining > 0 && (
            <button className="cta" onClick={() => { setStep('conta'); refresh(); }}>
              Pagar mais uma parte
            </button>
          )}
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="head">
        <span className="venue">{venue.name}</span>
        <span className="mesa">{table.label}</span>
      </header>

      <section className="card">
        <p className="label">Sua conta</p>
        <ul className="items">
          {view.check.items.map((i) => (
            <li key={i.id}>
              <span>{i.name}</span>
              <span className="mono">{brl(i.priceCents)}</span>
            </li>
          ))}
        </ul>
        <div className="totalrow">
          <span>Total</span>
          <span className="mono">{brl(state.totalCents)}</span>
        </div>
        {state.paidCents > 0 && (
          <div className="progresswrap">
            <div className="progressbar"><span style={{ width: `${progress}%` }} /></div>
            <p className="muted small">{brl(state.paidCents)} já pagos — falta {brl(remaining)}</p>
          </div>
        )}
      </section>

      {remaining === 0 ? (
        <section className="card center">
          <p className="bigmoney">🎉</p>
          <p>Conta paga por completo. Boa noite!</p>
        </section>
      ) : (
        <section className="card">
          <p className="label">Sua parte</p>
          <div className="modes" role="tablist">
            <button role="tab" aria-selected={mode === 'igual'} className={mode === 'igual' ? 'mode on' : 'mode'} onClick={() => setMode('igual')}>
              Dividir igual
            </button>
            <button role="tab" aria-selected={mode === 'valor'} className={mode === 'valor' ? 'mode on' : 'mode'} onClick={() => setMode('valor')}>
              Outro valor
            </button>
          </div>

          {mode === 'igual' ? (
            <div className="stepperrow">
              <span>Dividir entre</span>
              <div className="stepper">
                <button aria-label="menos pessoas" onClick={() => setPeople(Math.max(1, people - 1))}>−</button>
                <strong>{people}</strong>
                <button aria-label="mais pessoas" onClick={() => setPeople(Math.min(20, people + 1))}>+</button>
              </div>
              <span>pessoas</span>
            </div>
          ) : (
            <div className="customrow">
              <label htmlFor="valor">R$</label>
              <input
                id="valor" inputMode="decimal" placeholder="0,00"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
              />
            </div>
          )}

          <label className="servico">
            <input type="checkbox" checked={servicoOn} onChange={(e) => setServicoOn(e.target.checked)} />
            <span>
              Serviço da equipe ({(venue.servicoBp / 100).toFixed(0)}%) — opcional
              <em>{servicoOn && servicoCents > 0 ? ` +${brl(servicoCents)}` : ''}</em>
            </span>
          </label>

          <input
            className="namefield" maxLength={60} placeholder="Seu nome (opcional)"
            value={payerLabel} onChange={(e) => setPayerLabel(e.target.value)}
          />

          <button className="cta" disabled={totalToPay === 0} onClick={onPay}>
            Pagar {brl(totalToPay)} com Pix
          </button>
        </section>
      )}

      <footer className="foot">
        <span>racha · sem app, sem cadastro</span>
      </footer>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="shell">{children}</main>;
}
