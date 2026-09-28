import { useState } from 'react';
import { useT } from './lang';
import { Campo } from './Campo';
import { parseBrlToCents, type VenueTable } from './api';
import { ITENS_POR_CONTA, NOME_MAXIMO, lerComanda, linhaVazia, type LinhaDaComanda } from './comanda';
import type { VenueAdmin } from './useVenueAdmin';

/**
 * Abrir a conta de uma mesa, na própria linha dela: com os ITENS (padrão — é o
 * que deixa o cliente ver o que consumiu e pagar "por item") ou só com o total,
 * pra quem está com pressa. Era um `prompt()` que só pedia o total (e2e
 * 27/09/2026).
 */
const ERRO_DA_COMANDA = {
  vazia: 'abrir.errEmpty',
  linha_incompleta: 'abrir.errIncomplete',
  qtd_invalida: 'abrir.errQty',
  preco_invalido: 'abrir.errPrice',
  muitos_itens: 'abrir.errTooMany',
} as const;

export function AbrirConta({ admin, table, market, onClose }: {
  admin: VenueAdmin; table: VenueTable; market?: string; onClose: () => void;
}) {
  const { t, brl } = useT();
  const [modo, setModo] = useState<'itens' | 'total'>('itens');
  const [linhas, setLinhas] = useState<LinhaDaComanda[]>([linhaVazia()]);
  const [total, setTotal] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const simbolo = market === 'es' ? '€' : 'R$';
  const moeda = market === 'es' ? 'EUR' : 'BRL';

  const lida = lerComanda(linhas, parseBrlToCents);
  // Linha pela metade NÃO desarma o botão: o toque é o que mostra qual linha
  // falta e por quê. Só a comanda toda em branco desarma.
  const podeAbrir = !enviando && (modo === 'itens' ? (lida.ok || lida.erro !== 'vazia') : total.trim() !== '');

  function mudarLinha(i: number, campo: keyof LinhaDaComanda, valor: string) {
    setLinhas((ls) => ls.map((l, j) => (j === i ? { ...l, [campo]: valor } : l)));
    setAviso(null);
  }

  async function abrir() {
    if (enviando) return;
    if (modo === 'itens' && !lida.ok) {
      setAviso(t(ERRO_DA_COMANDA[lida.erro], { n: lida.linha ?? 0 }));
      return;
    }
    // Um envio por vez: dois toques mandavam dois POST (segurança, lote 1).
    setEnviando(true);
    try {
      const ok = await admin.openManualCheck(table, modo === 'itens' && lida.ok ? { items: lida.itens } : { total });
      if (ok) onClose();
    } finally { setEnviando(false); }
  }

  return (
    <form className="abrirconta" onSubmit={(e) => { e.preventDefault(); void abrir(); }}>
      <div className="modes" role="tablist">
        <button type="button" role="tab" aria-selected={modo === 'itens'} className={modo === 'itens' ? 'mode on' : 'mode'} onClick={() => setModo('itens')}>
          {t('abrir.byItems')}
        </button>
        <button type="button" role="tab" aria-selected={modo === 'total'} className={modo === 'total' ? 'mode on' : 'mode'} onClick={() => setModo('total')}>
          {t('abrir.onlyTotal')}
        </button>
      </div>

      {modo === 'itens' ? (
        <>
          {linhas.map((l, i) => (
            <div className="comandalinha" key={i}>
              <Campo rotulo={t('abrir.item')} maxLength={NOME_MAXIMO} placeholder={t('abrir.itemEg')} value={l.nome}
                autoFocus={i === 0} onChange={(e) => mudarLinha(i, 'nome', e.target.value)} />
              <Campo rotulo={t('abrir.qty')} inputMode="numeric" maxLength={2} value={l.qtd}
                onChange={(e) => mudarLinha(i, 'qtd', e.target.value.replace(/\D/g, ''))} />
              <Campo rotulo={t('abrir.unitPrice', { symbol: simbolo })} inputMode="decimal" placeholder="0,00" value={l.preco}
                onChange={(e) => mudarLinha(i, 'preco', e.target.value)} />
              {linhas.length > 1 && (
                <button type="button" className="linklike" aria-label={t('abrir.removeItem', { n: i + 1 })}
                  onClick={() => setLinhas((ls) => ls.filter((_, j) => j !== i))}>✕</button>
              )}
            </div>
          ))}
          <button type="button" className="ghost" disabled={linhas.length >= ITENS_POR_CONTA}
            onClick={() => setLinhas((ls) => [...ls, linhaVazia()])}>
            {t('abrir.addItem')}
          </button>
          {lida.ok && <p className="small" style={{ margin: 0 }}><strong>{t('abrir.total', { amount: brl(lida.totalCents, moeda) })}</strong></p>}
        </>
      ) : (
        <Campo rotulo={t('admin.openCheckTotal', { symbol: simbolo })} inputMode="decimal" placeholder="0,00" autoFocus
          value={total} onChange={(e) => setTotal(e.target.value)} />
      )}

      {aviso && <p className="small" role="alert" style={{ margin: 0, color: 'var(--erro)' }}>{aviso}</p>}
      <div className="acoes">
        <button className="cta" type="submit" disabled={!podeAbrir}>{t('admin.openBillCta')}</button>
        <button className="linklike" type="button" onClick={onClose}>{t('rcpt.cancel')}</button>
      </div>
    </form>
  );
}
