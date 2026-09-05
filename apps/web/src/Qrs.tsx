import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from './lang';
import { QRCodeSVG } from 'qrcode.react';
import type { TablesView, VenueTable } from './api';
import { authedReq as req } from './auth';

/**
 * /qrs?v=<venueId> — folha de QRs das mesas, pronta para a gráfica. Warm Glass
 * na tela; no papel vira preto no branco (ver @media print em styles.css).
 * Atrás do login do dono (Gate.tsx), como /admin e /painel.
 *
 * O QR aponta SEMPRE para produção: o cartão vive na mesa por meses e não pode
 * depender de onde o dono abriu esta página (localhost/preview).
 * Mesas inativas e de treino ficam de fora da impressão.
 */

const PROD_ORIGIN = 'https://racha-gray.vercel.app';

/** "12" → "Mesa 12"; labels que já vêm como "Mesa 12" não viram "Mesa Mesa 12". */
const mesaTitle = (label: string) =>
  /^mesa\b/i.test(label.trim()) ? label.trim() : `Mesa ${label.trim()}`;

export default function Qrs() {
  const { t } = useT();
  const venueId = useMemo(() => new URLSearchParams(window.location.search).get('v') ?? '', []);
  const [data, setData] = useState<TablesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await req<TablesView>(`/api/tables?v=${encodeURIComponent(venueId)}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [venueId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (error) return <main className="shell"><p className="muted center">{error}</p></main>;
  if (!data) return <main className="shell"><p className="muted center">preparando os QRs…</p></main>;

  const printable = data.tables.filter((t) => t.active && !t.training);

  return (
    <main className="shell wide qrspage">
      <header className="head noprint">
        <span className="venue">{data.venue.name}</span>
        <a className="linklike" href={`/admin?v=${encodeURIComponent(venueId)}`}>← mesas</a>
      </header>

      <section className="card noprint">
        <p className="label">QRs das mesas ({printable.length})</p>
        <p className="muted small">
          Um cartão por mesa ativa — mesas desativadas e de treino ficam de fora.
          Dica: salve como PDF na caixa de impressão para mandar à gráfica.
        </p>
        <button className="cta" disabled={printable.length === 0} onClick={() => window.print()}>
          Imprimir
        </button>
      </section>

      {printable.length === 0 ? (
        <p className="muted center noprint">nenhuma mesa ativa para imprimir.</p>
      ) : (
        <section className="qrgrid">
          {printable.map((t) => <QrCard key={t.id} venueName={data.venue.name} table={t} />)}
        </section>
      )}

      <footer className="foot noprint"><span>{t('qr.sheetNote')}</span></footer>
    </main>
  );
}

function QrCard({ venueName, table }: { venueName: string; table: VenueTable }) {
  const { t } = useT();
  return (
    <article className="qrcard">
      <p className="qrvenue">{venueName}</p>
      <div className="qrbox">
        <QRCodeSVG value={`${PROD_ORIGIN}/?t=${table.qrToken}`} size={190} level="M" marginSize={2} />
      </div>
      <h2 className="qrmesa">{mesaTitle(table.label)}</h2>
      <p className="qrhint">{t('qr.scanToPay')}</p>
      <p className="qrperks">💳 Google Pay · 💰 Saldo da casa com bônus</p>
      <span className="qrbrand">racha</span>
    </article>
  );
}
