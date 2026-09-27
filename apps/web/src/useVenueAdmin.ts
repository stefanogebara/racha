import { useCallback, useEffect, useState } from 'react';
import { useT } from './lang';
import { api, parseBrlToCents, type TablesView, type Venue, type VenueTable } from './api';
import { authedReq as req } from './auth';
import { criarMesasNumeradas } from './mesas-lote';

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
  addTablesNumbered: (prefixo: string, de: number, ate: number, onProgress?: (feitas: number, total: number) => void) => Promise<number>;
  rotate: (t: VenueTable) => Promise<void>;
  toggle: (t: VenueTable) => Promise<void>;
  toggleTraining: (t: VenueTable) => Promise<void>;
  openManualCheck: (t: VenueTable, raw: string) => Promise<boolean>;
  closeManualCheck: (t: VenueTable) => Promise<void>;
}

export function useVenueAdmin(venueId: string): VenueAdmin {
  // Um hook pode chamar outro: as mensagens que ESTE arquivo escreve saem
  // traduzidas aqui. Os CÓDIGOS que vêm do servidor continuam sendo traduzidos
  // no ponto de exibição, por `tError` — é lá que se sabe o idioma do leitor e
  // é lá que o texto cru do servidor serve de reserva.
  // `tr`, não `t`: os callbacks deste hook chamam a MESA de `t`.
  const { t: tr, tErr: trErr } = useT();
  const [venue, setVenue] = useState<Venue | null>(null);
  const [tables, setTables] = useState<VenueTable[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await req<TablesView>(`/api/tables?v=${encodeURIComponent(venueId)}`);
      setVenue(data.venue); setTables(data.tables); setError(null);
    } catch (e) { setError(trErr(e)); }
  }, [venueId, trErr]);

  useEffect(() => { void refresh(); }, [refresh]);

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
    } catch (e) { setError(trErr(e)); return false; }
  }, [venueId, refresh, trErr]);

  /**
   * VÁRIAS MESAS NUMERADAS DE UMA VEZ ("Mesa 1" até "Mesa 20"). Um salão de
   * 30 mesas eram 30 digitações e 30 toques (auditoria e2e, 27/09/2026).
   * Uma por vez, na ordem, pela MESMA rota da mesa avulsa — o servidor segue
   * validando cada rótulo e barrando duplicata. Nome repetido (409) é pulado,
   * não é erro: reabrir a tela e pedir "1 a 20" de novo completa o que falta.
   */
  const addTablesNumbered = useCallback(async (
    prefixo: string, de: number, ate: number, onProgress?: (feitas: number, total: number) => void,
  ): Promise<number> => {
    // Limpa o erro de um lote anterior: sem isto, repetir o lote que falhou
    // deixava a frase velha ao lado do sucesso novo (segurança, PR do lote 1).
    setError(null);
    const r = await criarMesasNumeradas(
      (label) => req('/api/tables', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId, label }),
      }),
      prefixo, de, ate, onProgress);
    await refresh();
    // Depois do refresh: ele zera o erro quando a leitura vem boa.
    if (r.erro) setError(trErr(r.erro));
    return r.criadas;
  }, [venueId, refresh, trErr]);

  const rotate = useCallback(async (t: VenueTable) => {
    if (!confirm(tr('admin.rotateAsk', { table: t.label }))) return;
    try { await req('/api/tables/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id }) }); await refresh(); }
    catch (e) { setError(trErr(e)); }
  }, [refresh, tr, trErr]);

  const toggle = useCallback(async (t: VenueTable) => {
    if (t.active && t.hasOpenCheck) { setError(tr('admin.hasOpenBill', { table: t.label })); return; }
    if (t.active && !confirm(tr('admin.deactivateAsk', { table: t.label }))) return;
    try { await req('/api/tables/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, active: !t.active }) }); await refresh(); }
    catch (e) { setError(trErr(e)); }
  }, [refresh, tr, trErr]);

  // Mesa de treino: a equipe pratica o fluxo nela, e ela NÃO COBRA; fica fora
  // da folha /qrs. MARCAR pede confirmação: era um toque só, e uma mesa de
  // verdade marcada por engano para de cobrar no meio do turno (auditoria do
  // painel, P1). Tirar do treino não pede confirmação — mas oferece girar o QR
  // (abaixo).
  const toggleTraining = useCallback(async (t: VenueTable) => {
    if (!t.training && !confirm(tr('admin.confirmTraining', { label: t.label }))) return;
    try {
      await req<{ id: string; training: boolean }>('/api/tables/training', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, training: !t.training }) });
      // TIRAR do treino oferece girar o QR: um cartão carimbado "TREINO — não
      // aceita pagamento" esquecido numa mesa continuaria valendo com o mesmo
      // token, e a mesa volta a cobrar — o carimbo viraria mentira (compliance,
      // PR #20, M-2).
      if (t.training && confirm(tr('admin.untrainRotateAsk', { label: t.label }))) {
        await req('/api/tables/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id }) });
      }
      await refresh();
    }
    catch (e) { setError(trErr(e)); }
  }, [refresh, tr, trErr]);

  // Modo manual (POS adapter): o dono abre/fecha a conta pelo painel.
  // O valor vem de um campo NA TELA (Admin.tsx), não de um `prompt()`: a
  // caixinha nativa do navegador parecia erro no telefone e sumia a moldura do
  // produto (e2e 27/09/2026). Devolve se abriu, pra tela fechar o campo.
  const openManualCheck = useCallback(async (t: VenueTable, raw: string): Promise<boolean> => {
    const totalCents = parseBrlToCents(raw); // "1.234,56" e "R$ 47,50" resolvem certo
    if (totalCents == null || totalCents <= 0) { setError(tr('admin.totalInvalid')); return false; }
    try {
      await req('/api/checks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, totalCents }) });
      setError(null);
      await refresh();
      return true;
    } catch (e) { setError(trErr(e)); return false; }
  }, [refresh, tr, trErr]);

  const closeManualCheck = useCallback(async (t: VenueTable) => {
    if (!confirm(tr('admin.closeCheckConfirm', { table: t.label }))) return;
    try {
      // `api.getCheck`, não um `fetch` à mão: é a MESMA requisição, e aberta
      // aqui ela pulava o decodificador — o que tirava este arquivo do censo
      // que existe pra impedir erro montado à mão. Menos uma dispensa.
      // SEM `.catch(() => null)`: engolir a falha aqui fazia o dono ler
      // "conta não encontrada" numa mesa com conta aberta, sempre que a rede
      // piscasse no balcão. Um 404 de verdade já chega com `code:
      // 'check_not_found'` e é traduzido pelo `trErr` lá embaixo; falha de rede
      // sobe com a mensagem dela. O `setError('check_not_found')` escrito à mão
      // fica só pro caso em que ele é VERDADE: respondeu 200 e não há conta.
      const view = await api.getCheck(t.qrToken);
      const checkId = view?.check?.id;
      // FRASE, não código — e traduzida AQUI, como todo o resto deste hook.
      //
      // Isto era `setError('check_not_found')` com um comentário dizendo que o
      // hook "não tem idioma". Tem: `trErr` está na linha 33. O código cru
      // chegava à tela e era impresso literal, e a tentativa de consertar isso
      // na TELA (embrulhar tudo em `tErr`) apagou as outras seis mensagens,
      // porque `tErr` espera um erro e recebia uma string. Traduzir na origem
      // deixa um contrato só: quem escreve em `error` escreve frase pronta.
      if (!checkId) { setError(trErr({ code: 'check_not_found' })); return; }
      await req('/api/checks/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkId }) });
      await refresh();
    } catch (e) { setError(trErr(e)); }
  }, [refresh, tr, trErr]);

  return { venue, tables, error, setError, refresh, addTable, addTablesNumbered, rotate, toggle, toggleTraining, openManualCheck, closeManualCheck };
}

/** "Configurado" = tem recebedor real + ≥1 mesa operante. Decide qual tela abre. */
export function setupComplete(venue: Venue | null, tables: VenueTable[]): boolean {
  if (!venue) return false;
  const recebedorOk = /^r[ep]_/.test(venue.pspRecipientId || '');
  const mesasReais = tables.filter((t) => t.active && !t.training).length;
  return recebedorOk && mesasReais > 0;
}
