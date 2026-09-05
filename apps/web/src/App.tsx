import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, parseBrlToCents, CheckView, ChargeResult } from './api';
import { LangToggle, money, tError, useT } from './lang';
import { dishFor, dishMask } from './dish';
import Home from './Home';
import HousePay from './HousePay';
import WalletButtons from './WalletPay';
import StripeWalletPay from './StripeWalletPay';
import { clearStoredWallet, readStoredWallet } from './house';
import { computeShare, splitEqualLocal, type SplitMode } from './split';

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

export default function App() {
  const { t, lang } = useT();
  // A moeda não muda com o idioma — a conta é em reais nos dois casos. O que
  // muda é a separação de milhar e decimal, senão um leitor de inglês lê
  // "R$ 1.234,56" errado por uma ordem de grandeza.
  const brl = useCallback((c: number) => money(c, lang), [lang]);
  const token = useMemo(
    () => new URLSearchParams(window.location.search).get('t') ?? '',
    [],
  );
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
  const [view, setView] = useState<CheckView | null>(null);
  // `error` é fatal: a conta não carrega, não há tela pra mostrar. `payError` é
  // recuperável e NUNCA pode substituir a tela — a corrida mais comum da mesa é
  // duas pessoas tocando "Pagar R$50" ao mesmo tempo: uma ganha, a outra leva
  // 400 do servidor ("valor acima do que falta"). Isso é um aviso pra tentar de
  // novo com o valor novo, não um beco sem saída.
  const [error, setError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
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
  // Antes o botão de pagar exigia CPF pra HABILITAR — ficava cinza em silêncio e
  // parecia "quebrado" (diner toca e nada acontece). Agora é tocável e, sem CPF,
  // dá feedback + foca o campo.
  const [cpfHint, setCpfHint] = useState(false);

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
      setStale(false);
    } catch (e) {
      // Um blip de sinal NÃO pode apagar a tela. O caso real: o diner copia o
      // código Pix, troca pro app do banco, o 4G do bar oscila, ele volta — e o
      // poll de 4s já trocou o código por "Failed to fetch". Se já existe uma
      // conta carregada, a falha vira um aviso discreto e a tela fica de pé;
      // só a PRIMEIRA carga pode falhar em tela cheia, porque aí não há tela.
      setStale(true);
      const err = e as ApiError;
      setError(tError(lang, err.code, err.message));
    }
  }, [token, lang]);

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

  // O ✓ é o momento-prova do demo de prospecção: o lead PAGOU a conta de
  // mentira. Cobre os dois caminhos até 'pago' (webhook e redeem de saldo).
  useEffect(() => {
    if (step === 'pago') sendBeacon('paid');
  }, [step, sendBeacon]);

  // Sem token de mesa = visita direta (desktop/prospect/KYC) → landing.
  if (!token) return <Home />;
  if (error && !view) return <Shell><p className="muted center">{error}</p></Shell>;
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
  const share = computeShare({
    mode, totalCents: state.totalCents, remaining, people, customCents, selectedCents,
    servicoOn, servicoBp: venue.servicoBp,
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

  async function onPay() {
    if (cpfDigits.length !== 11) {
      setCpfHint(true);
      document.getElementById('cpf-field')?.focus();
      return;
    }
    setCpfHint(false);
    setPayError(null);
    try {
      setPaidBaseline(state.paidCents); // baseline ANTES da minha cobrança cair
      const result = await api.pay(token, cappedBase, servicoCents, payerLabel.trim() || null, cpfDigits);
      setCharge(result);
      setStep('pagar');
      setCopied(false);
    } catch (e) {
      // Alguém pagou primeiro (ou a conta mudou): recarrega e deixa o diner na
      // mesma tela, com o número já atualizado, pra tocar de novo.
      const err = e as ApiError;
      // Os valores vêm do servidor em centavos crus; quem formata é quem sabe
      // o idioma. Ver o comentário do amount_over no router.
      setPayError(tError(lang, err.code, err.message,
        err.vars ? { left: brl(Number(err.vars.leftCents ?? 0)) } : undefined));
      refresh();
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
        {stale && <p className="muted small center">{t('pix.stillValid')}</p>}
        <section className="pixcard">
          <p className="label">{t('pix.title')}</p>
          <p className="bigmoney">{brl(charge.amountCents + charge.tipCents)}</p>
          {charge.tipCents > 0 && (
            <p className="muted small">{t('pix.includesTip', { amount: brl(charge.tipCents) })}</p>
          )}
          <div className="codebox" aria-label={t('pix.aria')}>
            {(charge.copiaECola ?? '').slice(0, 64)}…
          </div>
          <button className="cta" onClick={onCopy}>
            {copied ? t('pix.copied') : t('pix.copy')}
          </button>
          <p className="muted small center">
            {t('pix.how')}
          </p>
          {!demoGone && (
            <button className="ghost" onClick={onDevConfirm} disabled={confirming}>
              {confirming ? t('pix.simulating') : t('pix.simulate')}
            </button>
          )}
          {confirmError && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{confirmError}</p>}
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
            <button className="cta" onClick={() => { setSelectedItems(new Set()); setStep('conta'); refresh(); }}>
              {t('paid.payMore')}
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
          {mode === 'valor' && (
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
              {t('servico.label', { pct: (venue.servicoBp / 100).toFixed(0) })}
              <em>{servicoOn && servicoCents > 0 ? ` +${brl(servicoCents)}` : ''}</em>
            </span>
          </label>

          {share.capped && cappedBase > 0 && (
            <p className="muted small">{t('share.capped', { left: brl(remaining) })}</p>
          )}

          <input
            className="namefield" maxLength={60} placeholder={t('payer.name')}
            value={payerLabel} onChange={(e) => setPayerLabel(e.target.value)}
          />
          <input
            id="cpf-field"
            className="namefield" inputMode="numeric" maxLength={14}
            placeholder={t('payer.cpf')}
            style={cpfHint && cpfDigits.length !== 11 ? { borderColor: 'var(--burgundy)' } : undefined}
            value={cpf}
            onChange={(e) => { setCpf(e.target.value); if (e.target.value.replace(/\D/g, '').length === 11) setCpfHint(false); }}
          />
          {cpfHint && cpfDigits.length !== 11 && (
            <p className="small" style={{ color: 'var(--burgundy)' }}>{t('payer.cpfHint')}</p>
          )}

          {payError && (
            <p className="small" style={{ color: 'var(--burgundy)' }}>
              {t('pay.retry', { error: payError })}
            </p>
          )}
          <button className="cta" disabled={totalToPay === 0} onClick={onPay}>
            {t('pay.cta', { amount: brl(totalToPay) })}
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
          {venue.acceptsCard && (
            <StripeWalletPay
              token={token}
              amountCents={cappedBase}
              tipCents={servicoCents}
              payerLabel={payerLabel.trim() || null}
              payerDocument={cpfDigits}
              disabled={totalToPay === 0}
              onPaid={async () => { await refresh(); setStep('pago'); }}
            />
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
                ? t('house.bonus', { pct: (houseBonusBp / 100).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US') })
                : t('house.discover')}
            </button>
          )}
        </section>
      )}

      <footer className="foot">
        <span>{t('app.tagline')}</span>
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

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="shell">{children}</main>;
}
