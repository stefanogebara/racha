
import { LangToggle, useT } from './lang';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import AdminHouse from './AdminHouse';
import AdminRecipient from './AdminRecipient';
import AdminStripe from './AdminStripe';
import AdminSetup from './AdminSetup';
import SetupWizard from './SetupWizard';
import { type Venue, type VenueTable } from './api';
import { authedReq as req, signOut } from './auth';
import { isValidCNPJ, maskCpfCnpj, onlyDigits } from './br';
import { setupComplete, useVenueAdmin, type VenueAdmin } from './useVenueAdmin';

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
  return venueId ? <VenueAdminSurface venueId={venueId} /> : <Onboarding />;
}

// ---------------------------------------------------------------- onboarding
function Onboarding() {
  const { t } = useT();
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [servico, setServico] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<Venue[]>([]);
  const cnpjValid = isValidCNPJ(cnpj); // opcional, mas se preenchido tem que valer

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
        <input className="namefield" inputMode="numeric" placeholder="CNPJ (opcional)" value={maskCpfCnpj(cnpj)}
          style={cnpj && !cnpjValid ? { borderColor: 'var(--burgundy)' } : undefined}
          onChange={(e) => setCnpj(onlyDigits(e.target.value).slice(0, 14))} />
        {cnpj !== '' && (
          <span className="small" style={{ color: cnpjValid ? 'var(--emerald)' : 'var(--burgundy)' }}>
            {cnpjValid ? 'CNPJ válido ✓' : 'CNPJ incompleto ou inválido — confira os 14 dígitos.'}
          </span>
        )}
        <label className="servico" style={{ alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{t('admin.suggested')}</span>
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
        <button className="cta" disabled={busy || !name.trim() || (cnpj !== '' && !cnpjValid)} onClick={submit}>
          {busy ? 'criando…' : 'Criar restaurante'}
        </button>
      </section>
      <footer className="foot"><span>{t('admin.title')}</span><LangToggle compact /></footer>
    </main>
  );
}

// ------------------------------------------------ venue admin (2 telas)
// Uma superfície, dois modos: o assistente de setup (SetupWizard, passo a
// passo) pra quem ainda está configurando, e o painel de gestão (ManageView)
// pro dia a dia. Os dados/ações vêm todos do hook useVenueAdmin — as duas
// telas leem da mesma fonte.
function VenueAdminSurface({ venueId }: { venueId: string }) {
  const admin = useVenueAdmin(venueId);
  const [printing, setPrinting] = useState<VenueTable | null>(null);
  const [mode, setMode] = useState<'wizard' | 'manage' | null>(null);
  const origin = window.location.origin;
  const decided = useRef(false);

  // Decide a tela padrão UMA vez, quando os dados carregam: restaurante já
  // operante abre no painel; ainda em setup abre no assistente. ?setup=1 força.
  useEffect(() => {
    if (decided.current || !admin.venue) return;
    decided.current = true;
    const forced = new URLSearchParams(window.location.search).get('setup') === '1';
    setMode(forced || !setupComplete(admin.venue, admin.tables) ? 'wizard' : 'manage');
  }, [admin.venue, admin.tables]);

  if (printing) return <PrintCard venue={admin.venue} table={printing} origin={origin} onClose={() => setPrinting(null)} />;

  return (
    <main className="shell wide">
      <header className="head">
        <span className="venue">{admin.venue?.name ?? 'Restaurante'}</span>
        <button className="linklike" onClick={() => signOut().then(() => window.location.reload())}>sair</button>
      </header>

      {mode === null && <p className="muted small">carregando…</p>}
      {mode === 'wizard' && (
        <SetupWizard admin={admin} venueId={venueId} onPrint={setPrinting} onDone={() => setMode('manage')} />
      )}
      {mode === 'manage' && (
        <ManageView admin={admin} venueId={venueId} onPrint={setPrinting} onConfigure={() => setMode('wizard')} />
      )}

      <footer className="foot"><span>racha · o QR de cada mesa abre a conta do cliente</span><LangToggle compact /></footer>
    </main>
  );
}

// ------------------------------------------------------- painel de gestão
function ManageView({ admin, venueId, onPrint, onConfigure }: {
  admin: VenueAdmin; venueId: string; onPrint: (t: VenueTable) => void; onConfigure: () => void;
}) {
  const [newLabel, setNewLabel] = useState('');
  const { venue, tables, error } = admin;

  async function add() { if (await admin.addTable(newLabel)) setNewLabel(''); }

  return (
    <>
      {venue && <AdminSetup venue={venue} tables={tables} />}

      <section className="panel" id="mesas" style={{ scrollMarginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <p className="label">Mesas ({tables.length})</p>
          <a className="linklike" style={{ textDecoration: 'none' }} href={`/qrs?v=${encodeURIComponent(venueId)}`}>
            🖨 Imprimir QRs
          </a>
        </div>
        <p className="muted small">
          Cadastre cada mesa com o nome que ela tem no salão (“Mesa 12”, “Balcão 3”).
          Depois marque uma como <em>treino</em> pra equipe praticar sem sujar os números.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input className="namefield" style={{ flex: 1 }} placeholder="Ex.: Mesa 12" value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="cta" style={{ padding: '12px 20px' }} disabled={!newLabel.trim()} onClick={add}>Adicionar</button>
        </div>
        {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
        {tables.length === 0 && <p className="muted small">nenhuma mesa ainda — adicione a primeira acima.</p>}
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
                ? <button className="ghost" onClick={() => admin.closeManualCheck(t)}>fechar conta</button>
                : <button className="cta" style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => admin.openManualCheck(t)}>abrir conta</button>)}
              <button className="ghost" onClick={() => onPrint(t)}>QR</button>
              <button className="ghost" onClick={() => admin.rotate(t)}>girar</button>
              <button className="linklike" onClick={() => admin.toggleTraining(t)}>{t.training ? 'tirar do treino' : 'treino'}</button>
              <button className="ghost" onClick={() => admin.toggle(t)}>{t.active ? 'desativar' : 'ativar'}</button>
            </div>
          </div>
        ))}
      </section>

      <AdminRecipient venueId={venueId} onChanged={admin.refresh} />

      <AdminStripe venueId={venueId} />

      {/* Créditos da casa: recurso avançado (carteira pré-paga), fora do setup — colapsado. */}
      <details>
        <summary className="muted small" style={{ cursor: 'pointer', padding: '4px 2px' }}>
          Créditos da casa (avançado) — carteira pré-paga do cliente
        </summary>
        <div style={{ marginTop: 8 }}>
          <AdminHouse venueId={venueId} />
        </div>
      </details>

      <button className="linklike" style={{ alignSelf: 'center' }} onClick={onConfigure}>abrir assistente de configuração</button>
    </>
  );
}

// --------------------------------------------------------------- print card
function PrintCard({ venue, table, origin, onClose }: { venue: Venue | null; table: VenueTable; origin: string; onClose: () => void }) {
  const { t } = useT();
  const url = `${origin}/?t=${table.qrToken}`;
  return (
    <main className="shell">
      <section className="pixcard qrprint">
        <p className="label">{venue?.name}</p>
        <h2 style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400, fontSize: 30 }}>{table.label}</h2>
        <div className="qrbox">
          <QRCodeSVG value={url} size={220} level="M" marginSize={2} />
        </div>
        <p className="muted small">{t('admin.point')}</p>
        <p className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{url}</p>
        <button className="cta" onClick={() => window.print()}>Imprimir</button>
        <button className="linklike" onClick={onClose}>← voltar</button>
      </section>
    </main>
  );
}
