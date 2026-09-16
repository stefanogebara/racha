
import { LangToggle, useT } from './lang';
import { Campo } from './Campo';
import PrivacyNotice from './PrivacyNotice';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, parseBrlToCents, HouseAccountView, HouseConfig, HouseLedgerEntry, HouseLoadResult } from './api';
import { storeWallet } from './house';

/**
 * Carteira do cliente — saldo da casa de UM restaurante. Sem login: o
 * accountToken é a credencial (como o QR da mesa).
 *   /carteira?t=<accountToken>   → saldo, recarga via Pix, extrato
 *   /carteira?new=<tableQrToken> → criar a carteira (nome + telefone)
 * Cópia legal obrigatória (CDC): saldo pago não expira e é reembolsável;
 * bônus promocional expira; válido somente no restaurante emissor.
 */

const PRESETS_CENTS = [5000, 10000, 20000];

// A API manda type curto ('load' | 'redeem' | 'refund') + label humano.
/** Tipo de lançamento → chave do dicionário. O texto sai traduzido na hora de
    renderizar, não aqui: um mapa de strings fixas volta a ser uma língua só. */
const LEDGER_KEY = {
  load: 'ledger.load', redeem: 'ledger.redeem', refund: 'ledger.refund',
} as const;

export default function Wallet() {
  const { t } = useT();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const accountToken = params.get('t');
  const newToken = params.get('new');
  if (newToken) return <OpenWallet tableToken={newToken} />;
  if (accountToken) return <WalletView accountToken={accountToken} />;
  return <Shell><p className="muted center">{t('wallet.badLink')}</p></Shell>;
}

// ------------------------------------------------------------------ carteira
function WalletView({ accountToken }: { accountToken: string }) {
  const { t, brl, dmy, tErr } = useT();
  const [view, setView] = useState<HouseAccountView | null>(null);
  const [dead, setDead] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [chip, setChip] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [charge, setCharge] = useState<HouseLoadResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // TOQUE DUPLO na recarga gastava duas das vagas da conta — o mesmo defeito do
  // botão de pagar, consertado só lá. Revisão de compliance de 2026-09-15.
  const [busy, setBusy] = useState(false);
  const [demoGone, setDemoGone] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const v = await api.houseAccount(accountToken);
      setView(v);
      setDead(false);
      setLoadFailed(false);
      storeWallet(accountToken, v.venue.name); // liga esta carteira ao aparelho (ver house.ts)
    } catch (e) {
      // Só o 404 significa token morto (girado no balcão). Rede/5xx viram um
      // estado de retry — nunca "link inválido" por causa de um soluço de wifi.
      if ((e as ApiError).status === 404) setDead(true);
      else setLoadFailed(true);
    }
  }, [accountToken]);

  useEffect(() => { void refresh(); }, [refresh]);

  // null = entrada inválida no campo livre → CTA desarmado.
  const amountCents = chip ?? parseBrlToCents(custom);

  async function onLoad() {
    if (amountCents == null || amountCents === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api.houseLoad(accountToken, amountCents);
      setCharge(c);
      setCopied(false);
    } catch (e) {
      setError(tErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!charge) return;
    // COPIADO SÓ QUANDO COPIOU. `writeText` falha no navegador embutido do
    // WhatsApp e do Instagram, fora de HTTPS ou sem permissão — e a tela dizia
    // "copiado" assim mesmo: a pessoa abria o banco e colava nada, e o código na
    // tela vinha cortado em 64 caracteres (auditoria de UI, C1).
    try {
      await navigator.clipboard.writeText(charge.copiaECola);
      setCopied(true); setCopyFailed(false);
    } catch {
      setCopied(false); setCopyFailed(true);
    }
  }

  // Demo affordance: stands in for the diner's bank app (mesmo padrão do App).
  async function onDevConfirm() {
    if (!charge) return;
    setConfirming(true);
    try {
      await api.devConfirm(charge.txid);
      setCharge(null); setChip(null); setCustom('');
      await refresh();
    } catch (e) {
      // Fora do modo demo /api/dev/confirm não existe (404) — some o botão.
      if ((e as ApiError).status === 404) setDemoGone(true);
      else setError(tErr(e));
    } finally {
      setConfirming(false);
    }
  }

  if (dead) return <Shell><p className="muted center">{t('wallet.badLink')}</p></Shell>;
  if (!view && loadFailed) {
    return (
      <Shell>
        <p className="muted center">
          não deu para carregar sua carteira —{' '}
          <button className="linklike" onClick={refresh}>tentar de novo</button>
        </p>
      </Shell>
    );
  }
  if (!view) return <Shell><p className="muted center">{t('wallet.loading')}</p></Shell>;

  const { venue, account, config } = view;

  if (charge) {
    return (
      <Shell>
        <header className="head">
          <span className="venue">{venue.name}</span>
          <span className="mesa">{t('wallet.header')}</span>
        </header>
        <section className="pixcard">
          <p className="label">{t('wallet.topUpPix')}</p>
          <p className="bigmoney">{brl(charge.amountCents)}</p>
          {charge.bonusCents > 0 && (
            <>
              <p className="small pos">{t('wallet.bonusOnConfirm', { amount: brl(charge.bonusCents) })}</p>
              <p className="muted small">{t('wallet.bonusDays', { days: config.validityDays })}</p>
            </>
          )}
          <p className="muted small">{t('wallet.refundable')}</p>
          <div className="codebox selectable" aria-label={t('pix.aria')}>
            {charge.copiaECola}
          </div>
          <button className="cta" onClick={onCopy}>
            {copied ? t('pix.copied') : t('pix.copy')}
          </button>
          {copyFailed && <p className="muted small center" role="status">{t('pix.copyFailed')}</p>}
          <p className="muted small center">
            {t('pix.how')}
          </p>
          {/* SIMULAR só na casa de demonstração (auditorias de fluxo H2 e de UI H3). */}
          {venue.demo === true && !demoGone && (
            <button className="ghost" onClick={onDevConfirm} disabled={confirming}>
              {confirming ? t('pix.simulating') : t('pix.simulate')}
            </button>
          )}
          {error && <p className="muted small" style={{ color: 'var(--erro)' }}>{error}</p>}
          <p className="muted small">{t('wallet.onlyAt', { venue: venue.name })}</p>
          <button className="linklike" onClick={() => { setCharge(null); void refresh(); }}>{t('common.backWallet')}</button>
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="head">
        <span className="venue">{venue.name}</span>
        <span className="mesa">{t('wallet.header')}</span>
      </header>

      <section className="card">
        <p className="label">{t('wallet.balance')}</p>
        <p className="bigmoney center">{brl(account.totalCents)}</p>
        <p className="muted small center">{t('wallet.onlyAt', { venue: venue.name })}</p>
        <div className="checkrow">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
            <span>{t('wallet.paidBal')}</span>
            <span className="muted small">{t('wallet.neverExp')}</span>
          </div>
          <span className="mono">{brl(account.principalCents)}</span>
        </div>
        {account.lots.map((lot, i) => (
          <div className="checkrow" key={i}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <span>{t('wallet.bonus')}</span>
              <span className="muted small">{t('wallet.expires', { date: dmy(lot.expiresAt) })}</span>
            </div>
            <span className="mono pos">{brl(lot.remainingCents)}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <p className="label">{t('wallet.topUp')}</p>
        <div className="chips">
          {PRESETS_CENTS.map((c) => (
            <button
              key={c}
              className={chip === c ? 'mode on' : 'mode'}
              onClick={() => { setChip(c); setCustom(''); }}
            >
              {brl(c)}
            </button>
          ))}
        </div>
        <div className="customrow">
          <label htmlFor="recarga">R$</label>
          <input
            id="recarga" inputMode="decimal" placeholder={t('wallet.otherAmt')}
            value={custom}
            onChange={(e) => { setCustom(e.target.value); setChip(null); }}
          />
        </div>
        {error && <p className="muted small" style={{ color: 'var(--erro)' }}>{error}</p>}
        <button className="cta" disabled={amountCents == null || amountCents === 0 || busy} onClick={onLoad}>
          {t('wallet.doTopUp', { amount: brl(amountCents ?? 0) })}
        </button>
        <p className="muted small">
          {t('wallet.refundable')}
          {config.bonusBp > 0
            ? ' ' + t('wallet.bonusDays', { days: config.validityDays })
            : ''}
        </p>
      </section>

      <section className="card">
        <p className="label">{t('wallet.statement')}</p>
        {account.ledger.length === 0 && <p className="muted small">{t('wallet.noMoves')}</p>}
        {[...account.ledger]
          .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')) // mais recente primeiro
          .map((e, i) => <LedgerRow key={i} entry={e} />)}
      </section>

      <footer className="foot">
        <span>{t('wallet.brand')}</span>
        <PrivacyNotice venue={venue.name} />
        <LangToggle compact />
      </footer>
    </Shell>
  );
}

function LedgerRow({ entry }: { entry: HouseLedgerEntry }) {
  const { t, brl, dmy } = useT();
  const key = LEDGER_KEY[entry.type as keyof typeof LEDGER_KEY];
  const title = key ? t(key) : entry.label;
  const sign = entry.type === 'load' ? '+' : '−';
  // Recarga com bônus: mostra o bônus como sublinha.
  const detail = entry.type === 'load' && (entry.bonusCents ?? 0) > 0
    ? t('wallet.bonusLine', { amount: brl(entry.bonusCents!) })
    : entry.label && entry.label !== title ? ` · ${entry.label}` : '';
  return (
    <div className="checkrow">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        <span>{title}</span>
        <span className="muted small">{entry.at ? dmy(entry.at) : ''}{detail}</span>
      </div>
      {entry.amountCents !== 0 && (
        <span className={sign === '+' ? 'mono pos' : 'mono'}>
          {sign}{brl(Math.abs(entry.amountCents))}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------ abrir carteira
function OpenWallet({ tableToken }: { tableToken: string }) {
  const { t, pct, tErr } = useT();
  const [config, setConfig] = useState<HouseConfig | null>(null);
  const [dead, setDead] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.houseConfig(tableToken).then(setConfig).catch(() => setDead(true));
  }, [tableToken]);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api.houseOpen(tableToken, phone, name.trim());
      storeWallet(r.accountToken, r.venueName);
      window.location.href = `/carteira?t=${encodeURIComponent(r.accountToken)}`;
    } catch (e) {
      // 409 "Conta já existe — peça seu link no balcão" chega aqui, verbatim.
      setError(tErr(e));
      setBusy(false);
    }
  }

  if (dead) return <Shell><p className="muted center">{t('wallet.badLink')}</p></Shell>;
  if (!config) return <Shell><p className="muted center">{t('common.loading')}</p></Shell>;
  if (!config.enabled) {
    return <Shell><p className="muted center">{t('wallet.noHouse', { venue: config.venueName })}</p></Shell>;
  }

  const bonusPct = pct(config.bonusBp);

  return (
    <Shell>
      <header className="head">
        <span className="venue">{config.venueName}</span>
        <span className="mesa">{t('home.houseBalance')}</span>
      </header>
      <section className="card">
        <p className="label">{t('wallet.open')}</p>
        <p className="small">
          {config.bonusBp > 0
            ? t('wallet.pitchBonus', { pct: bonusPct })
            : t('wallet.pitch')}
        </p>
        <Campo
          rotulo={t('wallet.yourName')} maxLength={60} autoComplete="name"
          value={name} onChange={(e) => setName(e.target.value)}
        />
        {/* `autoComplete="tel"`: o telefone É a chave da carteira do cliente, e
            digitar treze dígitos à mão num bar é onde a pessoa desiste. */}
        <Campo
          rotulo={t('wallet.phone')} type="tel" inputMode="numeric" autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 13))}
        />
        {error && <p className="muted small" style={{ color: 'var(--erro)' }}>{error}</p>}
        <button className="cta" disabled={busy || !name.trim() || phone.length < 10} onClick={submit}>
          {busy ? t('wallet.creating') : t('wallet.create')}
        </button>
        <p className="muted small">
          {t('wallet.refundable')}{' '}
          {t('wallet.bonusTerms', { days: config.validityDays, venue: config.venueName })}
        </p>
      </section>
      <footer className="foot">
        <span>{t('wallet.brand')}</span>
        {/* Esta é a tela que pede NOME e TELEFONE — o dado mais identificável
            que o produto recebe, e preso a um saldo. O aviso do art. 9º foi
            primeiro pra tela da conta; o caso mais forte sempre foi aqui. */}
        <PrivacyNotice venue={config.venueName} />
        <LangToggle compact />
      </footer>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="shell">{children}</main>;
}
