import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT, LangToggle } from './lang';
import { QRCodeSVG } from 'qrcode.react';
import type { TablesView, VenueTable } from './api';
import { authedReq as req } from './auth';
import { tituloDaMesa, trilhoDoCartao, urlDaMesa } from './cartao-qr';

/**
 * /qrs?v=<venueId> — folha de QRs das mesas, pronta para a gráfica. Warm Glass
 * na tela; no papel vira preto no branco (ver @media print em styles.css).
 * Atrás do login do dono (Gate.tsx), como /admin e /painel.
 *
 * O que o cartão diz, e pra onde o QR aponta, mora em `cartao-qr.ts` — a mesma
 * fonte do cartão avulso do `/admin`. Mesas inativas e de treino ficam de fora.
 */

export default function Qrs() {
  const { t, tErr } = useT();
  const venueId = useMemo(() => new URLSearchParams(window.location.search).get('v') ?? '', []);
  const [data, setData] = useState<TablesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await req<TablesView>(`/api/tables?v=${encodeURIComponent(venueId)}`));
      setError(null);
    } catch (e) {
      setError(tErr(e));
    }
  }, [venueId, tErr]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <main className="shell"><p className="muted center">{error}</p></main>;
  if (!data) return <main className="shell"><p className="muted center">{t('qrs.preparing')}</p></main>;

  const printable = data.tables.filter((t) => t.active && !t.training);

  return (
    <main className="shell wide qrspage">
      <header className="head noprint">
        <span className="venue">{data.venue.name}</span>
        <a className="linklike" href={`/admin?v=${encodeURIComponent(venueId)}`}>{t('qrs.backTables')}</a>
      </header>

      <section className="card noprint">
        <p className="label">{t('qrs.title', { n: printable.length })}</p>
        <p className="muted small">{t('qrs.help')}</p>
        <button className="cta" disabled={printable.length === 0} onClick={() => window.print()}>
          {t('qrs.print')}
        </button>
      </section>

      {printable.length === 0 ? (
        <p className="muted center noprint">{t('qrs.noneActive')}</p>
      ) : (
        <section className="qrgrid">
          {printable.map((t) => <QrCard key={t.id} venueName={data.venue.name} market={data.venue.market} table={t} />)}
        </section>
      )}

      {/* O seletor de idioma, como em todo rodapé (CLAUDE.md): esta página não
          tinha nenhum, e o idioma do cartão só mudava pela URL (auditoria, Q6). */}
      <footer className="foot noprint"><span>{t('qr.sheetNote')}</span><LangToggle compact /></footer>
    </main>
  );
}

function QrCard({ venueName, market, table }: { venueName: string; market?: string; table: VenueTable }) {
  const { t } = useT();
  return (
    <article className="qrcard">
      <p className="qrvenue">{venueName}</p>
      <div className="qrbox">
        <QRCodeSVG value={urlDaMesa(table.qrToken)} size={190} level="M" marginSize={2} />
      </div>
      <h2 className="qrmesa">{tituloDaMesa(table.label, (label) => t('qrs.tableTitle', { label }))}</h2>
      <p className="qrhint">{t('qr.scanToPay', { rail: trilhoDoCartao(market) })}</p>
      <span className="qrbrand">racha</span>
    </article>
  );
}
