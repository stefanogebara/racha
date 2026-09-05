
import { LangToggle, useT } from './lang';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, brl, dmy, parseBrlToCents, HouseAccountView, HouseConfig, HouseLedgerEntry, HouseLoadResult } from './api';
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
const LEDGER_LABEL: Record<string, string> = {
  load: 'Recarga',
  redeem: 'Pagamento na mesa',
  refund: 'Reembolso',
};

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
  const { t } = useT();
  const [view, setView] = useState<HouseAccountView | null>(null);
  const [dead, setDead] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [chip, setChip] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [charge, setCharge] = useState<HouseLoadResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
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

  useEffect(() => { refresh(); }, [refresh]);

  // null = entrada inválida no campo livre → CTA desarmado.
  const amountCents = chip ?? parseBrlToCents(custom);

  async function onLoad() {
    if (amountCents == null || amountCents === 0) return;
    setError(null);
    try {
      const c = await api.houseLoad(accountToken, amountCents);
      setCharge(c);
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
      else setError((e as Error).message);
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
  if (!view) return <Shell><p className="muted center">carregando sua carteira…</p></Shell>;

  const { venue, account, config } = view;

  if (charge) {
    return (
      <Shell>
        <header className="head">
          <span className="venue">{venue.name}</span>
          <span className="mesa">carteira</span>
        </header>
        <section className="pixcard">
          <p className="label">{t('wallet.topUpPix')}</p>
          <p className="bigmoney">{brl(charge.amountCents)}</p>
          {charge.bonusCents > 0 && (
            <>
              <p className="small pos">+{brl(charge.bonusCents)} de bônus quando o pagamento confirmar</p>
              <p className="muted small">Bônus válido por {config.validityDays} dias após a confirmação.</p>
            </>
          )}
          <p className="muted small">Saldo pago não expira e é reembolsável.</p>
          <div className="codebox" aria-label={t('pix.aria')}>
            {charge.copiaECola.slice(0, 64)}…
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
          {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
          <p className="muted small">Válido somente no {venue.name}.</p>
          <button className="linklike" onClick={() => { setCharge(null); refresh(); }}>← voltar pra carteira</button>
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="head">
        <span className="venue">{venue.name}</span>
        <span className="mesa">carteira</span>
      </header>

      <section className="card">
        <p className="label">Seu saldo</p>
        <p className="bigmoney center">{brl(account.totalCents)}</p>
        <p className="muted small center">Válido somente no {venue.name}.</p>
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
              <span className="muted small">expira em {dmy(lot.expiresAt)}</span>
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
        {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
        <button className="cta" disabled={amountCents == null || amountCents === 0} onClick={onLoad}>
          Carregar {brl(amountCents ?? 0)}
        </button>
        <p className="muted small">
          Saldo pago não expira e é reembolsável.
          {config.bonusBp > 0
            ? ` Bônus válido por ${config.validityDays} dias após a confirmação.`
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

      <footer className="foot"><span>racha · saldo da casa</span><LangToggle compact /></footer>
    </Shell>
  );
}

function LedgerRow({ entry }: { entry: HouseLedgerEntry }) {
  const title = LEDGER_LABEL[entry.type] ?? entry.label;
  const sign = entry.type === 'load' ? '+' : '−';
  // Recarga com bônus: mostra o bônus como sublinha.
  const detail = entry.type === 'load' && (entry.bonusCents ?? 0) > 0
    ? ` · +${brl(entry.bonusCents!)} de bônus`
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
  const { t } = useT();
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
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (dead) return <Shell><p className="muted center">{t('wallet.badLink')}</p></Shell>;
  if (!config) return <Shell><p className="muted center">carregando…</p></Shell>;
  if (!config.enabled) {
    return <Shell><p className="muted center">O {config.venueName} ainda não oferece saldo da casa.</p></Shell>;
  }

  const pct = (config.bonusBp / 100).toLocaleString('pt-BR');

  return (
    <Shell>
      <header className="head">
        <span className="venue">{config.venueName}</span>
        <span className="mesa">saldo da casa</span>
      </header>
      <section className="card">
        <p className="label">Abrir sua carteira</p>
        <p className="small">
          {config.bonusBp > 0
            ? `Carregue saldo por Pix e ganhe ${pct}% de bônus em cada recarga.`
            : 'Carregue saldo por Pix e pague a conta direto do celular.'}
        </p>
        <input
          className="namefield" maxLength={60} placeholder={t('wallet.yourName')}
          value={name} onChange={(e) => setName(e.target.value)}
        />
        <input
          className="namefield" type="tel" inputMode="numeric"
          placeholder={t('wallet.phone')}
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 13))}
        />
        {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
        <button className="cta" disabled={busy || !name.trim() || phone.length < 10} onClick={submit}>
          {busy ? 'criando…' : 'Criar carteira'}
        </button>
        <p className="muted small">
          Saldo pago não expira e é reembolsável. O bônus promocional vale por{' '}
          {config.validityDays} dias. Válido somente no {config.venueName}.
        </p>
      </section>
      <footer className="foot"><span>racha · saldo da casa</span><LangToggle compact /></footer>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="shell">{children}</main>;
}
