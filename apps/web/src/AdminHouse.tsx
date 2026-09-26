
import { useT } from './lang';import { useCallback, useEffect, useState } from 'react';
import { textoDoAchado } from './i18n';
import { parseBrlToCents } from './api';
import { authedReq as req } from './auth';

/**
 * "Saldo da casa" — administração do house account por restaurante.
 * Config (bônus, validade, limites de recarga), passivo em aberto e a lista
 * de contas com novo link + reembolso. Reembolso no v1 é registro contábil:
 * o dono envia o Pix ao cliente manualmente; o ledger guarda a prova.
 */

interface HouseAdminConfig {
  enabled: boolean;
  bonusBp: number;
  validityDays: number;
  minLoadCents: number;
  maxLoadCents: number;
}

interface HouseAdminAccount {
  id: string;
  name: string;
  phoneMasked: string;
  principalCents: number;
  bonusCents: number;
  createdAt: string;
}

/** Um achado da conciliação da carteira, já projetado: código e centavos, sem frase do servidor. */
interface HouseFinding {
  severity: string;
  code: string;
  amountCents?: number;
  accountId?: string;
}

interface HouseAdminData {
  config: HouseAdminConfig;
  liability: { principalCents: number; bonusCents: number; accountCount: number };
  accounts: HouseAdminAccount[];
  // Opcional: backend antigo ainda no ar não manda — a página segue de pé.
  reconcile?: { ok: boolean; house: { failed: number; findings: HouseFinding[] } };
}

export default function AdminHouse({ venueId }: { venueId: string }) {
  const { t, brl, dmy, tErr } = useT();
  const [data, setData] = useState<HouseAdminData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Campos como string: digitação parcial ("1,5") não pode virar NaN no estado.
  const [enabled, setEnabled] = useState(false);
  const [bonusPct, setBonusPct] = useState('10');
  const [validity, setValidity] = useState('90');
  const [minLoad, setMinLoad] = useState('20');
  const [maxLoad, setMaxLoad] = useState('500');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [freshLink, setFreshLink] = useState<{ accountId: string; url: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await req<HouseAdminData>(`/api/house/admin?v=${encodeURIComponent(venueId)}`);
      setData(d);
      setError(null);
      setEnabled(d.config.enabled);
      // Render SEM separador de milhar: toLocaleString emitia "1.000", que o
      // save() re-parsearia — agora com parseBrlToCents o round-trip é lossless
      // de qualquer forma, mas "1000,00" evita a ambiguidade por completo.
      setBonusPct(String(d.config.bonusBp / 100).replace('.', ','));
      setValidity(String(d.config.validityDays));
      setMinLoad((d.config.minLoadCents / 100).toFixed(2).replace('.', ','));
      setMaxLoad((d.config.maxLoadCents / 100).toFixed(2).replace('.', ','));
    } catch (e) {
      setError(tErr(e));
    }
  }, [venueId, tErr]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save() {
    // parseBrlToCents também serve para % com 2 casas: "1,5"% → 150bp,
    // exatamente a mesma escala ×100 de reais → centavos.
    const bonusBp = parseBrlToCents(bonusPct);
    const minLoadCents = parseBrlToCents(minLoad);
    const maxLoadCents = parseBrlToCents(maxLoad);
    const validityDays = /^\d+$/.test(validity.trim()) ? Number(validity.trim()) : null;
    if (bonusBp == null || minLoadCents == null || maxLoadCents == null || validityDays == null) {
      setError(t('house.badValues'));
      return;
    }
    setSaving(true); setSaved(false); setError(null);
    try {
      await req('/api/house/admin', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId,
          config: { enabled, bonusBp, validityDays, minLoadCents, maxLoadCents },
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await refresh();
    } catch (e) {
      setError(tErr(e));
    } finally {
      setSaving(false);
    }
  }

  async function rotate(a: HouseAdminAccount) {
    if (!confirm(t('house.newLinkAsk', { name: a.name }))) return;
    try {
      const r = await req<{ accountToken: string }>('/api/house/admin/rotate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: a.id }),
      });
      setFreshLink({ accountId: a.id, url: `${window.location.origin}/carteira?t=${r.accountToken}` });
      setLinkCopied(false);
    } catch (e) {
      setError(tErr(e));
    }
  }

  async function copyLink() {
    if (!freshLink) return;
    await navigator.clipboard.writeText(freshLink.url).catch(() => {});
    setLinkCopied(true);
  }

  async function refund(a: HouseAdminAccount) {
    const raw = prompt(t('house.refundAsk', {
      name: a.name, label: t('wallet.paidBal'), balance: brl(a.principalCents),
      // A carteira da casa é fechada fora do Brasil (o `house-service` barra
      // carga e resgate por mercado), então o símbolo é real — mas escrito como
      // parâmetro, não como literal, pra não voltar a ser mentira em silêncio.
      symbol: 'R$',
    }));
    if (raw == null) return;
    const amountCents = parseBrlToCents(raw); // "1.000" = mil reais, nunca R$ 10
    if (amountCents == null || amountCents <= 0) { setError(t('house.badAmount')); return; }
    try {
      const r = await req<{ principalCents: number; bonusCents: number }>('/api/house/admin/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: a.id, amountCents }),
      });
      // Ecoa o valor que o parser entendeu — o dono confere antes de mandar o Pix.
      setNotice(
        t('house.refundNotice', { amount: brl(amountCents) })
        + (r.bonusCents > 0 ? t('house.refundBonus', { amount: brl(r.bonusCents) }) : ''),
      );
      await refresh();
    } catch (e) {
      setError(tErr(e));
    }
  }

  if (!data) {
    return (
      <section className="panel">
        <p className="label">{t('home.houseBalance')}</p>
        <p className="muted small">{error ?? 'carregando…'}</p>
      </section>
    );
  }

  const { liability, accounts } = data;
  // A CONCILIAÇÃO DA CARTEIRA, onde o conserto mora. A rota já calculava e só
  // mandava o crítico pro stderr: um saldo debitado sem pagamento era invisível
  // aqui (compliance, PR #42, M-2). Traduzida, com o valor e o cliente.
  const achados = data.reconcile?.house.findings ?? [];
  const nomeDa = (id?: string) => accounts.find((a) => a.id === id)?.name;

  return (
    <section className="panel">
      <p className="label">{t('home.houseBalance')}</p>

      {achados.length > 0 && (
        <div role="alert">
          <p className="small" style={{ color: 'var(--erro)' }}><strong>{t('house.reconTitle')}</strong></p>
          {achados.map((f, i) => (
            <p className="muted small" key={i}>
              · {nomeDa(f.accountId) ? `${nomeDa(f.accountId)}: ` : ''}{textoDoAchado(f, t, brl)}
            </p>
          ))}
        </div>
      )}

      <label className="servico" style={{ alignItems: 'center' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>{t('admin.houseOn')}</span>
      </label>

      <div className="cfggrid">
        <label>
          {t('house.cfgBonus')}
          <input className="namefield" inputMode="decimal" value={bonusPct}
            onChange={(e) => setBonusPct(e.target.value)} />
        </label>
        <label>
          {t('house.cfgValidity')}
          <input className="namefield" inputMode="numeric" value={validity}
            onChange={(e) => setValidity(e.target.value)} />
        </label>
        <label>
          {t('house.cfgMinLoad', { symbol: 'R$' })}
          <input className="namefield" inputMode="decimal" value={minLoad}
            onChange={(e) => setMinLoad(e.target.value)} />
        </label>
        <label>
          {t('house.cfgMaxLoad', { symbol: 'R$' })}
          <input className="namefield" inputMode="decimal" value={maxLoad}
            onChange={(e) => setMaxLoad(e.target.value)} />
        </label>
      </div>

      {error && <p className="muted small" style={{ color: 'var(--erro)' }}>{error}</p>}
      {saved && <p className="small" style={{ color: 'var(--ok)' }}>{t('admin.saved')}</p>}
      <button className="cta" style={{ padding: '12px 20px' }} disabled={saving} onClick={save}>
        {saving ? t('house.saving') : t('house.saveConfig')}
      </button>

      <div className="stat">
        <b className="mono">{brl(liability.principalCents + liability.bonusCents)}</b>
        {/* FRASE, não rótulo: `.stat span` é o versalete de 10px que o sistema
            reserva pra rótulo de uma a três palavras, e aqui carregava o passivo
            contábil da casa em caixa-alta espaçada — e em português cru. */}
      </div>
      <p className="muted small">
        {t('house.liability', {
          paid: brl(liability.principalCents),
          bonus: brl(liability.bonusCents),
          n: liability.accountCount,
        })}
      </p>
      <p className="muted small">{t('house.liabilityWhy')}</p>

      <p className="label">{t('house.accountsCount', { n: accounts.length })}</p>
      {accounts.length === 0 && <p className="muted small">{t('house.noAccounts')}</p>}
      {accounts.map((a) => (
        <div key={a.id}>
          <div className="checkrow" style={{ flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 150 }}>
              <strong>{a.name}</strong>
              <span className="muted small">{a.phoneMasked} · desde {dmy(a.createdAt)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right' }}>
              <span className="mono">{t('house.paidTag', { amount: brl(a.principalCents) })}</span>
              <span className="mono muted small">{t('house.bonusTag', { amount: brl(a.bonusCents) })}</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="ghost" onClick={() => rotate(a)}>{t('house.newLink')}</button>
              <button className="ghost" onClick={() => refund(a)}>{t('house.refund')}</button>
            </div>
          </div>
          {freshLink?.accountId === a.id && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 4px 12px' }}>
              <div className="codebox">{freshLink.url}</div>
              <button className="ghost" onClick={copyLink}>
                {linkCopied ? t('house.linkCopied') : t('house.copyLink')}
              </button>
            </div>
          )}
        </div>
      ))}
      {notice && <p className="small" style={{ color: 'var(--ok)' }}>{notice}</p>}
    </section>
  );
}
