import { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import AdminHouse from './AdminHouse';
import AdminRecipient from './AdminRecipient';
import { parseBrlToCents, type TablesView, type Venue, type VenueTable } from './api';
import { authedReq as req, signOut } from './auth';

/**
 * Painel de gestão do restaurante — onboarding + mesas/QR. Warm Glass.
 * Behind the owner login gate (see Gate.tsx). Two surfaces by URL:
 *   /admin            → onboarding (cria o restaurante) → redireciona p/ mesas
 *   /admin?v=<id>     → gestão de mesas (criar, QR imprimível, girar, desativar)
 * O QR codifica a URL da conta do cliente: <origin>/?t=<qr_token>.
 * A folha de impressão de todos os QRs vive em /qrs?v=<id> (Qrs.tsx).
 */

export default function Admin() {
  const venueId = useMemo(() => new URLSearchParams(window.location.search).get('v') ?? '', []);
  return venueId ? <Tables venueId={venueId} /> : <Onboarding />;
}

// ---------------------------------------------------------------- onboarding
function Onboarding() {
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [servico, setServico] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<Venue[]>([]);

  // If this owner already has venues, offer them instead of a blank form.
  useEffect(() => {
    req<{ user: unknown; venues: Venue[] }>('/api/me')
      .then((d) => setMine(d.venues || []))
      .catch(() => {});
  }, []);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const v = await req<Venue>('/api/venues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, city: city || null, cnpj: cnpj || null, servicoBp: Math.round(servico * 100) }),
      });
      window.location.search = `?v=${v.id}`;
    } catch (e) {
      setError((e as Error).message); setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="head">
        <span className="venue">Racha</span>
        <button className="linklike" onClick={() => signOut().then(() => window.location.reload())}>sair</button>
      </header>
      {mine.length > 0 && (
        <section className="panel">
          <p className="label">Seus restaurantes</p>
          {mine.map((v) => (
            <div className="checkrow" key={v.id}>
              <strong>{v.name}</strong>
              <a className="ghost" href={`/admin?v=${v.id}`}>gerenciar mesas →</a>
            </div>
          ))}
        </section>
      )}
      <section className="card">
        <p className="label">{mine.length > 0 ? 'Cadastrar outro restaurante' : 'Cadastre seu restaurante'}</p>
        <input className="namefield" placeholder="Nome do restaurante" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="namefield" placeholder="Cidade (opcional)" value={city} onChange={(e) => setCity(e.target.value)} />
        <input className="namefield" placeholder="CNPJ (opcional)" value={cnpj} onChange={(e) => setCnpj(e.target.value)} />
        <label className="servico" style={{ alignItems: 'center' }}>
          <span style={{ flex: 1 }}>Serviço sugerido</span>
          <div className="stepper">
            <button aria-label="menos" onClick={() => setServico(Math.max(0, servico - 1))}>−</button>
            <strong>{servico}%</strong>
            <button aria-label="mais" onClick={() => setServico(Math.min(20, servico + 1))}>+</button>
          </div>
        </label>
        <p className="muted small">
          O meio de pagamento (Pix/split) é conectado depois — sem ele, o restaurante
          existe mas ainda não recebe. Isso mantém a Racha fora da custódia de recursos.
        </p>
        {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
        <button className="cta" disabled={busy || !name.trim()} onClick={submit}>
          {busy ? 'criando…' : 'Criar restaurante'}
        </button>
      </section>
      <footer className="foot"><span>racha · gestão</span></footer>
    </main>
  );
}

// ------------------------------------------------------------------- tables
function Tables({ venueId }: { venueId: string }) {
  const [venue, setVenue] = useState<Venue | null>(null);
  const [tables, setTables] = useState<VenueTable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [printing, setPrinting] = useState<VenueTable | null>(null);

  const origin = window.location.origin;

  const refresh = useCallback(async () => {
    try {
      const data = await req<TablesView>(`/api/tables?v=${encodeURIComponent(venueId)}`);
      setVenue(data.venue); setTables(data.tables); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [venueId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function addTable() {
    const label = newLabel.trim();
    if (!label) return;
    try {
      await req('/api/tables', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId, label }),
      });
      setNewLabel(''); await refresh();
    } catch (e) { setError((e as Error).message); }
  }

  async function rotate(t: VenueTable) {
    if (!confirm(`Girar o QR da ${t.label}? O código impresso atual para de funcionar na hora.`)) return;
    try { await req('/api/tables/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id }) }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }
  async function toggle(t: VenueTable) {
    if (t.active && t.hasOpenCheck) { setError(`${t.label} tem conta aberta — feche antes de desativar.`); return; }
    if (t.active && !confirm(`Desativar a ${t.label}? O QR dela para de funcionar.`)) return;
    try { await req('/api/tables/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, active: !t.active }) }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }
  // Mesa de treino: a equipe pratica o fluxo nela; fica fora da folha /qrs.
  async function toggleTraining(t: VenueTable) {
    try { await req<{ id: string; training: boolean }>('/api/tables/training', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, training: !t.training }) }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }

  // Manual mode (POS adapter): the owner opens/closes the check from the panel.
  async function openManualCheck(t: VenueTable) {
    const raw = prompt(`Abrir conta na ${t.label}\n\nTotal da conta (R$):`);
    if (raw == null) return;
    const totalCents = parseBrlToCents(raw); // "1.234,56" e "R$ 47,50" resolvem certo
    if (totalCents == null || totalCents <= 0) { setError('Informe um total válido.'); return; }
    try {
      await req('/api/checks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: t.id, totalCents }) });
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }
  async function closeManualCheck(t: VenueTable) {
    if (!confirm(`Fechar a conta da ${t.label}?`)) return;
    try {
      const view = await fetch(`/api/check?t=${encodeURIComponent(t.qrToken)}`).then((r) => r.json());
      const checkId = view?.data?.check?.id;
      if (!checkId) { setError('Conta não encontrada.'); return; }
      await req('/api/checks/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkId }) });
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }

  if (printing) return <PrintCard venue={venue} table={printing} origin={origin} onClose={() => setPrinting(null)} />;

  return (
    <main className="shell wide">
      <header className="head">
        <span className="venue">{venue?.name ?? 'Restaurante'}</span>
        <button className="linklike" onClick={() => signOut().then(() => window.location.reload())}>sair</button>
      </header>

      {!venue?.pspRecipientId?.startsWith('rp_') && (
        <section className="card" style={{ borderColor: 'rgba(245,158,11,0.4)' }}>
          <p className="small">
            ⚠ Meio de pagamento ainda não conectado — as mesas funcionam para teste,
            mas cobranças reais só depois de criar o recebedor na seção Recebimento abaixo.
          </p>
        </section>
      )}

      <section className="panel">
        <p className="label">Adicionar mesa</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="namefield" style={{ flex: 1 }} placeholder="Ex.: Mesa 12" value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTable()} />
          <button className="cta" style={{ padding: '12px 20px' }} disabled={!newLabel.trim()} onClick={addTable}>Adicionar</button>
        </div>
        {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
      </section>

      <section className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <p className="label">Mesas ({tables.length})</p>
          <a className="linklike" style={{ textDecoration: 'none' }} href={`/qrs?v=${encodeURIComponent(venueId)}`}>
            🖨 Imprimir QRs das mesas
          </a>
        </div>
        {tables.length === 0 && <p className="muted small">nenhuma mesa ainda.</p>}
        {tables.map((t) => (
          <div className="checkrow" key={t.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, flexWrap: 'wrap' }}>
              <strong style={{ opacity: t.active ? 1 : 0.45 }}>{t.label}</strong>
              {t.hasOpenCheck && <span className="pill parcial">conta aberta</span>}
              {!t.active && <span className="pill fechada">desativada</span>}
              {t.training && <span className="muted small">· mesa de treino</span>}
              {t.qrRotatedAt && <span className="muted small">QR girado</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {t.active && (t.hasOpenCheck
                ? <button className="ghost" onClick={() => closeManualCheck(t)}>fechar conta</button>
                : <button className="cta" style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => openManualCheck(t)}>abrir conta</button>)}
              <button className="ghost" onClick={() => setPrinting(t)}>QR</button>
              <button className="ghost" onClick={() => rotate(t)}>girar</button>
              <button className="linklike" onClick={() => toggleTraining(t)}>{t.training ? 'tirar do treino' : 'treino'}</button>
              <button className="ghost" onClick={() => toggle(t)}>{t.active ? 'desativar' : 'ativar'}</button>
            </div>
          </div>
        ))}
      </section>

      <AdminRecipient venueId={venueId} onChanged={refresh} />

      <AdminHouse venueId={venueId} />

      <footer className="foot"><span>racha · o QR de cada mesa abre a conta do cliente</span></footer>
    </main>
  );
}

// --------------------------------------------------------------- print card
function PrintCard({ venue, table, origin, onClose }: { venue: Venue | null; table: VenueTable; origin: string; onClose: () => void }) {
  const url = `${origin}/?t=${table.qrToken}`;
  return (
    <main className="shell">
      <section className="pixcard qrprint">
        <p className="label">{venue?.name}</p>
        <h2 style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400, fontSize: 30 }}>{table.label}</h2>
        <div className="qrbox">
          <QRCodeSVG value={url} size={220} level="M" marginSize={2} />
        </div>
        <p className="muted small">Aponte a câmera · pague sua parte por Pix</p>
        <p className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{url}</p>
        <button className="cta" onClick={() => window.print()}>Imprimir</button>
        <button className="linklike" onClick={onClose}>← voltar</button>
      </section>
    </main>
  );
}
