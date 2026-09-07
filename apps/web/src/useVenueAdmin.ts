import { useCallback, useEffect, useState } from 'react';
import { useT } from './lang';
import { parseBrlToCents, type TablesView, type Venue, type VenueTable } from './api';
import { authedReq as req } from './auth';

/**
 * Estado + ações de um restaurante (mesas/QR/contas manuais), compartilhado
 * entre as duas telas do admin: o assistente de setup (SetupWizard, passo a
 * passo) e o painel de gestão do dia a dia (Admin/ManageView). Uma fonte só
 * pros dados e mutações — as duas telas leem daqui, então não divergem.
 */
export interface VenueAdmin {
  venue: Venue | null;
  tables: VenueTable[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
  /** cria a mesa; retorna true no sucesso (pra tela limpar o input). */
  addTable: (label: string) => Promise<boolean>;
  rotate: (t: VenueTable) => Promise<void>;
  toggle: (t: VenueTable) => Promise<void>;
  toggleTraining: (t: VenueTable) => Promise<void>;
  openManualCheck: (t: VenueTable) => Promise<void>;
  closeManualCheck: (t: VenueTable) => Promise<void>;
}

export function useVenueAdmin(venueId: string): VenueAdmin {
  // Um hook pode chamar outro: as mensagens que ESTE arquivo escreve saem
  // traduzidas aqui. Os CÓDIGOS que vêm do servidor continuam sendo traduzidos
  // no ponto de exibição, por `tError` — é lá que se sabe o idioma do leitor e
  // é lá que o texto cru do servidor serve de reserva.
  // `tr`, não `t`: os callbacks deste hook chamam a MESA de `t`.
  const { t: tr } = useT();
  const [venue, setVenue] = useState<Venue | null>(null);
  const [tables, setTables] = useState<VenueTable[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await req<TablesView>(`/api/tables?v=${encodeURIComponent(venueId)}`);
      setVenue(data.venue); setTables(data.tables); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [venueId]);

  useEffect(() => { refresh(); }, [refresh]);

  const addTable = useCallback(async (label: string): Promise<boolean> => {
    const clean = label.trim();
    if (!clean) return false;
    try {
      await req('/api/tables', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId, label: clean }),
      });
      await refresh();
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }, [venueId, refresh]);

  const rotate = useCallback(async (t: VenueTable) => {
    if (!confirm(`Girar o QR da ${t.label}? O código impresso atual para de funcionar na hora.`)) return;
    try { await req('/api/tables/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id }) }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }, [refresh]);

  const toggle = useCallback(async (t: VenueTable) => {
    if (t.active && t.hasOpenCheck) { setError(tr('admin.hasOpenBill', { table: t.label })); return; }
    if (t.active && !confirm(`Desativar a ${t.label}? O QR dela para de funcionar.`)) return;
    try { await req('/api/tables/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, active: !t.active }) }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }, [refresh]);

  // Mesa de treino: a equipe pratica o fluxo nela; fica fora da folha /qrs.
  const toggleTraining = useCallback(async (t: VenueTable) => {
    try { await req<{ id: string; training: boolean }>('/api/tables/training', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, training: !t.training }) }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }, [refresh]);

  // Modo manual (POS adapter): o dono abre/fecha a conta pelo painel.
  const openManualCheck = useCallback(async (t: VenueTable) => {
    const raw = prompt(`Abrir conta na ${t.label}\n\nTotal da conta (R$):`);
    if (raw == null) return;
    const totalCents = parseBrlToCents(raw); // "1.234,56" e "R$ 47,50" resolvem certo
    if (totalCents == null || totalCents <= 0) { setError('Informe um total válido.'); return; }
    try {
      await req('/api/checks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, totalCents }) });
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }, [refresh]);

  const closeManualCheck = useCallback(async (t: VenueTable) => {
    if (!confirm(`Fechar a conta da ${t.label}?`)) return;
    try {
      const view = await fetch(`/api/check?t=${encodeURIComponent(t.qrToken)}`).then((r) => r.json());
      const checkId = view?.data?.check?.id;
      // A code, not a sentence. This hook has no language: it runs above the
      // React tree that knows which one the reader picked. `tError` at the
      // display site turns it into the right words, and falls back to the raw
      // text for anything it does not recognise — the same contract the server
      // follows (CLAUDE.md).
      if (!checkId) { setError('check_not_found'); return; }
      await req('/api/checks/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkId }) });
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }, [refresh]);

  return { venue, tables, error, setError, refresh, addTable, rotate, toggle, toggleTraining, openManualCheck, closeManualCheck };
}

/** "Configurado" = tem recebedor real + ≥1 mesa operante. Decide qual tela abre. */
export function setupComplete(venue: Venue | null, tables: VenueTable[]): boolean {
  if (!venue) return false;
  const recebedorOk = /^r[ep]_/.test(venue.pspRecipientId || '');
  const mesasReais = tables.filter((t) => t.active && !t.training).length;
  return recebedorOk && mesasReais > 0;
}
