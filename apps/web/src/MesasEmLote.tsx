import { useState } from 'react';
import { useT } from './lang';
import { Campo } from './Campo';
import { MESAS_POR_LOTE, type VenueAdmin } from './useVenueAdmin';

/**
 * "Mesa 1 até Mesa 20" num toque, embaixo do campo da mesa avulsa. Fechado por
 * padrão: quem tem duas varandas com nome próprio não precisa dele; quem tem
 * 30 mesas numeradas precisa muito (auditoria e2e, 27/09/2026).
 */
export function MesasEmLote({ admin }: { admin: VenueAdmin }) {
  const { t } = useT();
  // "Mesa" nos dois mercados, e não pelo idioma da TELA: o nome da mesa é
  // palavra da casa e vai impresso no cartão (CLAUDE.md). O dono troca à vontade.
  const [prefixo, setPrefixo] = useState('Mesa');
  const [de, setDe] = useState('1');
  const [ate, setAte] = useState('10');
  const [progresso, setProgresso] = useState<string | null>(null);
  const [rodando, setRodando] = useState(false);

  const nDe = Number(de);
  const nAte = Number(ate);
  const total = nAte - nDe + 1;
  const valido = prefixo.trim() !== '' && de !== '' && ate !== '' && Number.isInteger(nDe) && Number.isInteger(nAte)
    && nDe >= 0 && total >= 1 && total <= MESAS_POR_LOTE;

  async function criar() {
    if (!valido || rodando) return;
    setRodando(true);
    setProgresso(t('admin.batchProgress', { done: 0, total }));
    const criadas = await admin.addTablesNumbered(prefixo, nDe, nAte,
      (feitas, tot) => setProgresso(t('admin.batchProgress', { done: feitas, total: tot })));
    setProgresso(t('admin.batchDone', { n: criadas }));
    setRodando(false);
  }

  return (
    <details className="lote">
      <summary className="linklike">{t('admin.batchOpen')}</summary>
      <div className="lotecampos">
        <Campo rotulo={t('admin.batchPrefix')} maxLength={30} value={prefixo} onChange={(e) => setPrefixo(e.target.value)} />
        <Campo rotulo={t('admin.batchFrom')} inputMode="numeric" value={de} onChange={(e) => setDe(e.target.value.replace(/\D/g, ''))} />
        <Campo rotulo={t('admin.batchTo')} inputMode="numeric" value={ate} onChange={(e) => setAte(e.target.value.replace(/\D/g, ''))} />
      </div>
      {!valido && total > MESAS_POR_LOTE && (
        <p className="muted small" style={{ margin: 0 }}>{t('admin.batchMax', { n: MESAS_POR_LOTE })}</p>
      )}
      <button type="button" className="ghost" disabled={!valido || rodando} onClick={() => void criar()}>
        {valido ? t('admin.batchCreate', { n: total, first: `${prefixo.trim()} ${nDe}`, last: `${prefixo.trim()} ${nAte}` }) : t('admin.batchOpen')}
      </button>
      {progresso && <p className="muted small" role="status" style={{ margin: 0 }}>{progresso}</p>}
    </details>
  );
}
