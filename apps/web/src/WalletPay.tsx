import { useState } from 'react';
import { api, ApiError, brl } from './api';

/**
 * Apple Pay / Google Pay — cobrança de CARTÃO tokenizada pelo mesmo portão de
 * dinheiro do Pix (POST /api/pay com wallet + paymentToken).
 *
 * No demo (PSP mock) a folha nativa não existe — merchant validation da Apple
 * e o gateway do Google só vêm com o PSP real (RFP). Então a "sheet" aqui é
 * uma simulação claramente rotulada que gera um token de teste; quando o PSP
 * real entrar, authorize() troca a simulação pelo SDK (Payment Request API /
 * botão do PSP) e NADA mais muda — backend, ledger e recibos já falam 'card'.
 */

type Wallet = 'apple_pay' | 'google_pay';
const WALLET_LABEL: Record<Wallet, string> = { apple_pay: 'Apple Pay', google_pay: 'Google Pay' };

export default function WalletButtons({
  token, amountCents, tipCents, payerLabel, disabled, venueName, onPaid,
}: {
  token: string;
  amountCents: number;
  tipCents: number;
  payerLabel: string | null;
  disabled: boolean;
  venueName: string;
  onPaid: () => void;
}) {
  const [sheet, setSheet] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ordem por plataforma: Apple primeiro em iOS/macOS, Google primeiro no resto.
  const isApple = typeof (window as unknown as { ApplePaySession?: unknown }).ApplePaySession !== 'undefined'
    || /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  const wallets: Wallet[] = isApple ? ['apple_pay', 'google_pay'] : ['google_pay', 'apple_pay'];

  const total = amountCents + tipCents;

  async function authorize(wallet: Wallet) {
    setBusy(true); setError(null);
    try {
      // PSP real: este token vem da sheet nativa (Payment Request API).
      const paymentToken = `tok_demo_${crypto.randomUUID().replace(/-/g, '')}`;
      const charge = await api.payWallet(token, amountCents, tipCents, payerLabel, wallet, paymentToken);
      try {
        await api.devConfirm(charge.txid); // demo: banco emissor confirma na hora
      } catch (e) {
        // Produção com PSP real: sem /api/dev/confirm (404) — a confirmação
        // chega pelo webhook do adquirente e o polling da conta atualiza.
        if ((e as ApiError).status !== 404) throw e;
      }
      setSheet(null);
      onPaid();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="walletrow">
        {wallets.map((w) => (
          <button
            key={w}
            type="button"
            className={`walletbtn ${w === 'apple_pay' ? 'apple' : 'gpay'}`}
            disabled={disabled}
            onClick={() => { setError(null); setSheet(w); }}
          >
            {w === 'apple_pay' ? ' Pay' : 'G Pay'}
          </button>
        ))}
      </div>
      {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}

      {sheet && (
        <div className="sheetoverlay" role="dialog" aria-modal="true" aria-label={`Pagar com ${WALLET_LABEL[sheet]}`}>
          <div className="sheet">
            <p className="label">{WALLET_LABEL[sheet]}</p>
            <div className="checkrow">
              <span>Racha · {venueName}</span>
              <span className="mono">{brl(total)}</span>
            </div>
            {tipCents > 0 && (
              <p className="muted small">inclui {brl(tipCents)} de serviço para a equipe</p>
            )}
            <div className="checkrow">
              <span className="muted small">cartão</span>
              <span className="mono muted small">•••• 4242 (demo)</span>
            </div>
            <button className="cta" disabled={busy} onClick={() => authorize(sheet)}>
              {busy ? 'autorizando…' : `Pagar ${brl(total)}`}
            </button>
            <button className="linklike" disabled={busy} onClick={() => setSheet(null)}>cancelar</button>
            <p className="muted small center">simulação (demo) — nenhuma cobrança real é feita</p>
          </div>
        </div>
      )}
    </>
  );
}
