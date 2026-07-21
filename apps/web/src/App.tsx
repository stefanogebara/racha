import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, brl, parseBrlToCents, CheckView, ChargeResult } from './api';
import Home from './Home';
import HousePay from './HousePay';
import WalletButtons from './WalletPay';
import { clearStoredWallet, readStoredWallet } from './house';

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
  // CPF do pagador: o adquirente exige o documento do customer em TODO
  // método (Pix e cartão) — padrão de checkout brasileiro. Um campo só,
  // compartilhado com o Google Pay.
  const [cpf, setCpf] = useState('');
  const cpfDigits = cpf.replace(/\D/g, '');

  const [step, setStep] = useState<Step>('conta');
  const [charge, setCharge] = useState<ChargeResult | null>(null);
  // Quanto já estava pago no instante em que criei MINHA cobrança — quando o
  // pago passar disso, é a minha que caiu → avança pro ✓ sozinho.
  const [paidBaseline, setPaidBaseline] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [demoGone, setDemoGone] = useState(false);
  const [copied, setCopied] = useState(false);
  // Para de fazer polling quando a conta some no meio do redeem (fechou/girou).
  const [polling, setPolling] = useState(true);

  // Saldo da casa: carteira pré-paga do restaurante (docs/house-accounts).
  const [house, setHouse] = useState<{ token: string; balanceCents: number } | null>(null);
  const [houseBonusBp, setHouseBonusBp] = useState<number | null>(null);
  const [houseChecked, setHouseChecked] = useState(false);

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
    if (!polling) return;
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh, polling]);

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

  // Auto-avança pro ✓ quando o pagamento cai — webhook real OU Simulador da
  // demo, sem depender de botão. Vale pro diner REAL: paguei no banco → vejo a
  // confirmação sozinho (antes ficava travado na tela do código Pix).
  useEffect(() => {
    if (step === 'pagar' && charge && paidBaseline !== null && view && view.state.paidCents > paidBaseline) {
      setStep('pago');
    }
  }, [view, step, charge, paidBaseline]);

  // Sem token de mesa = visita direta (desktop/prospect/KYC) → landing.
  if (!token) return <Home />;
  if (error) return <Shell><p className="muted center">{error}</p></Shell>;
  if (!view) return <Shell><p className="muted center">carregando a conta…</p></Shell>;

  const { venue, table, state } = view;
  const remaining = Math.max(0, state.totalCents - state.paidCents);
  const progress = state.totalCents > 0 ? Math.min(100, (state.paidCents / state.totalCents) * 100) : 0;

  // parseBrlToCents devolve null para entrada inválida ('R$ 47,50' colado com
  // lixo, '1.234,56', etc. resolvem certo; 'abc' → null) — null desarma o CTA.
  const customCents = parseBrlToCents(customValue);
  const baseCents =
    mode === 'igual'
      ? splitEqualLocal(remaining, Math.max(people, 1), 0)
      : Math.max(0, customCents ?? 0);
  const cappedBase = Math.min(baseCents, remaining);
  const servicoCents = servicoOn
    ? Math.floor((cappedBase * venue.servicoBp + 5000) / 10000)
    : 0;
  const totalToPay = cappedBase + servicoCents;

  async function onPay() {
    try {
      setPaidBaseline(state.paidCents); // baseline ANTES da minha cobrança cair
      const result = await api.pay(token, cappedBase, servicoCents, payerLabel.trim() || null, cpfDigits);
      setCharge(result);
      setStep('pagar');
      setCopied(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onCopy() {
    if (!charge || !charge.copiaECola) return;
    await navigator.clipboard.writeText(charge.copiaECola).catch(() => {});
    setCopied(true);
  }

  // Demo affordance: stands in for the diner's bank app.
  async function onDevConfirm() {
    if (!charge) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await api.devConfirm(charge.txid);
      await refresh();
      setStep('pago');
    } catch (e) {
      // Fora do modo demo /api/dev/confirm não existe (404) — some o botão.
      if ((e as ApiError).status === 404) setDemoGone(true);
      else setConfirmError((e as Error).message);
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
            {(charge.copiaECola ?? '').slice(0, 64)}…
          </div>
          <button className="cta" onClick={onCopy}>
            {copied ? 'Código copiado ✓' : 'Copiar código Pix'}
          </button>
          <p className="muted small center">
            Abra o app do seu banco, escolha Pix copia-e-cola e cole o código.
          </p>
          {!demoGone && (
            <button className="ghost" onClick={onDevConfirm} disabled={confirming}>
              {confirming ? 'confirmando…' : '✓ Simular confirmação do banco (demo)'}
            </button>
          )}
          {confirmError && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{confirmError}</p>}
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
          <input
            className="namefield" inputMode="numeric" maxLength={14}
            placeholder="Seu CPF (a operadora de pagamento exige)"
            value={cpf} onChange={(e) => setCpf(e.target.value)}
          />

          <button className="cta" disabled={totalToPay === 0 || cpfDigits.length !== 11} onClick={onPay}>
            Pagar {brl(totalToPay)} com Pix
          </button>
          <WalletButtons
            token={token}
            amountCents={cappedBase}
            tipCents={servicoCents}
            payerLabel={payerLabel.trim() || null}
            payerDocument={cpfDigits}
            disabled={totalToPay === 0}
            venueName={venue.name}
            onPaid={async () => { await refresh(); setStep('pago'); }}
          />
          {house && house.balanceCents > 0 && (
            <button className="ghost" onClick={() => setStep('saldo')}>
              Pagar com saldo ({brl(house.balanceCents)} disponível)
            </button>
          )}
          {!house && houseBonusBp !== null && (
            <button
              className="linklike"
              onClick={() => { window.location.href = `/carteira?new=${encodeURIComponent(token)}`; }}
            >
              {houseBonusBp > 0
                ? `Conheça o saldo da casa — ganhe ${(houseBonusBp / 100).toLocaleString('pt-BR')}% de bônus`
                : 'Conheça o saldo da casa'}
            </button>
          )}
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
