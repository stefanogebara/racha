import { useRef, useState } from 'react';
import { useT } from './lang';
import { api, parseBrlToCents, HouseRedeemResult } from './api';

/**
 * "Pagar com saldo" — redeem do saldo da casa dentro da tela da conta.
 * Sem gorjeta aqui (Lei 13.419: gorjeta nunca sai de crédito pré-pago);
 * o serviço da equipe segue exclusivamente pelo caminho Pix.
 * O backend re-valida tudo (saldo, mesmo restaurante, conta aberta) —
 * como no resto do app, esta UI é consultiva e a API é o portão.
 */
export default function HousePay({
  accountToken, tableToken, availableCents, defaultCents, onPaid, onBack,
}: {
  accountToken: string;
  tableToken: string;
  availableCents: number;
  defaultCents: number;
  onPaid: (r: HouseRedeemResult) => void;
  onBack: () => void;
}) {
  const { t, brl } = useT();
  const [value, setValue] = useState(
    defaultCents > 0 ? (defaultCents / 100).toFixed(2).replace('.', ',') : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HouseRedeemResult | null>(null);

  // Uma chave por TENTATIVA de pagamento: retry de rede reenvia a mesma chave
  // (o servidor dedupa → sem débito duplo). Gira só após sucesso ou quando o
  // valor muda — aí é outra intenção de pagamento.
  const idemKey = useRef<string>(crypto.randomUUID());

  // null = entrada inválida → CTA desarmado (nunca "Pagar R$ NaN").
  const amountCents = parseBrlToCents(value);

  async function onPay() {
    if (amountCents == null || amountCents === 0) return;
    setBusy(true); setError(null);
    try {
      const r = await api.houseRedeem(accountToken, tableToken, amountCents, idemKey.current);
      idemKey.current = crypto.randomUUID(); // próxima tentativa é outro débito
      setResult(r);
      onPaid(r); // entrega o check view fresco pro App (null se a conta fechou no meio)
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const parts = [
      result.bonusUsedCents > 0 ? t('housepay.usedBonus', { amount: brl(result.bonusUsedCents) }) : null,
      result.principalUsedCents > 0 ? t('housepay.usedPaid', { amount: brl(result.principalUsedCents) }) : null,
    ].filter(Boolean);
    return (
      <section className="paid">
        <div className="paidmark">✓</div>
        <h2>{t('housepay.done')}</h2>
        <p className="muted">{parts.join(' + ')}</p>
        <button className="cta" onClick={onBack}>{t('common.back')}</button>
      </section>
    );
  }

  return (
    <section className="card">
      <p className="label">{t('housepay.cta')}</p>
      <p className="muted small">{t('housepay.available', { amount: brl(availableCents) })}</p>
      <div className="customrow">
        <label htmlFor="saldo-valor">R$</label>
        <input
          id="saldo-valor" inputMode="decimal" placeholder="0,00"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            idemKey.current = crypto.randomUUID(); // valor mudou = nova intenção
          }}
        />
      </div>
      {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
      <button
        className="cta"
        disabled={busy || amountCents == null || amountCents === 0 || amountCents > availableCents}
        onClick={onPay}
      >
        {busy ? t('housepay.paying') : t('housepay.payAmount', { amount: brl(amountCents ?? 0) })}
      </button>
      <p className="muted small">{t('housepay.tipApart')}</p>
      <button className="linklike" onClick={onBack}>{t('common.back')}</button>
    </section>
  );
}
