
import { LangToggle, useT } from './lang';
import { Campo } from './Campo';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import AdminHouse from './AdminHouse';
import AdminRecipient from './AdminRecipient';
import AdminStripe from './AdminStripe';
import AdminSetup from './AdminSetup';
import SetupWizard from './SetupWizard';
import { type Venue, type VenueTable } from './api';
import { authedReq as req, signOut } from './auth';
import { isValidCNPJ, maskCpfCnpj, normalizarDocumento } from './br';
import { setupComplete, useVenueAdmin, type VenueAdmin } from './useVenueAdmin';
import { LIMITES } from './limites';

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
  const { t, tErr } = useT();
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
      setError(tErr(e)); setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="head">
        <span className="venue">Racha</span>
        <button className="linklike" onClick={() => signOut().then(() => window.location.reload())}>{t('common.signOut')}</button>
      </header>
      {mine.length > 0 && (
        <section className="panel">
          <p className="label">{t('admin.yourVenues')}</p>
          {mine.map((v) => (
            <div className="checkrow" key={v.id}>
              <strong>{v.name}</strong>
              <a className="ghost" href={`/admin?v=${v.id}`}>{t('admin.manageTables')}</a>
            </div>
          ))}
        </section>
      )}
      <section className="card">
        <p className="label">{mine.length > 0 ? t('admin.registerAnother') : t('admin.registerFirst')}</p>
        {/* `maxLength` no nome da casa: ele vai no cartão do QR, no painel e no
            recibo, e sem teto uma colagem acidental de trezentos caracteres
            passava — o servidor guardava e as três telas quebravam o layout.
            O NÚMERO vem de `limites.ts`, que é o mesmo do servidor e o mesmo do
            CHECK da 0035: este campo nasceu com um 60 escrito à mão contra um
            servidor que aceitava outro número. */}
        <Campo rotulo={t('admin.venueName')} maxLength={LIMITES.nomeDaCasa} autoComplete="organization"
          placeholder={t('admin.venueNameEg')} value={name} onChange={(e) => setName(e.target.value)} />
        <Campo rotulo={t('admin.city')} maxLength={LIMITES.cidade} autoComplete="address-level2"
          value={city} onChange={(e) => setCity(e.target.value)} />
        <Campo
          rotulo={t('admin.cnpjField')} inputMode="numeric" autoCapitalize="characters" autoComplete="off"
          // A FORMA sai do formatador, nunca de uma string pontuada à mão.
          placeholder={maskCpfCnpj('00000000000000')}
          value={maskCpfCnpj(cnpj)}
          ruim={cnpj !== '' && !cnpjValid}
          bom={cnpj !== '' && cnpjValid}
          recado={cnpj !== '' ? (cnpjValid ? t('admin.cnpjOk') : t('admin.cnpjBad')) : undefined}
          onChange={(e) => setCnpj(normalizarDocumento(e.target.value))} />
        <label className="servico" style={{ alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{t('admin.suggested')}</span>
          <div className="stepper">
            <button aria-label={t('admin.less')} onClick={() => setServico(Math.max(0, servico - 1))}>−</button>
            <strong>{servico}%</strong>
            <button aria-label={t('admin.more')} onClick={() => setServico(Math.min(20, servico + 1))}>+</button>
          </div>
        </label>
        <p className="muted small">
          {t('admin.psplater')}
        </p>
        {error && <p className="muted small" style={{ color: 'var(--erro)' }}>{error}</p>}
        <button className="cta" disabled={busy || !name.trim() || (cnpj !== '' && !cnpjValid)} onClick={submit}>
          {busy ? t('admin.creating') : t('admin.createVenue')}
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
  const { t } = useT();
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
        <button className="linklike" onClick={() => signOut().then(() => window.location.reload())}>{t('common.signOut')}</button>
      </header>

      {mode === null && <p className="muted small">{t('admin.loading')}</p>}
      {mode === 'wizard' && (
        <SetupWizard admin={admin} venueId={venueId} onPrint={setPrinting} onDone={() => setMode('manage')} />
      )}
      {mode === 'manage' && (
        <ManageView admin={admin} venueId={venueId} onPrint={setPrinting} onConfigure={() => setMode('wizard')} />
      )}

      <footer className="foot"><span>{t('admin.footQr')}</span><LangToggle compact /></footer>
    </main>
  );
}

// ------------------------------------------------------- painel de gestão
function ManageView({ admin, venueId, onPrint, onConfigure }: {
  admin: VenueAdmin; venueId: string; onPrint: (t: VenueTable) => void; onConfigure: () => void;
}) {
  const [newLabel, setNewLabel] = useState('');
  const { t } = useT();
  const { venue, tables, error } = admin;

  async function add() { if (await admin.addTable(newLabel)) setNewLabel(''); }

  return (
    <>
      {venue && <AdminSetup venue={venue} tables={tables} />}

      {/* O SERVIÇO PAROU DE CORRER, e sem isto o dono não fica sabendo.
          Desde 2026-09-13 a gorjeta exige CNPJ provado (`venue_no_tip_document`):
          sem pessoa jurídica não há folha, e sem folha a frase que o cliente lê
          no comprovante seria falsa. Mas `cnpj` nulo é o estado LEGÍTIMO das
          casas do piloto cujo recebedor foi criado à mão no painel do Pagar.me
          — o `documento.js` diz isso — então elas param de arrecadar os 10% em
          silêncio, e a semana 8 do portão de adoção absorve a diferença.
          Falhar fechado é o certo; falhar calado não é. */}
      {venue && venue.podeCobrarServico === false && (
        <section className="panel" style={{ borderColor: 'var(--erro)' }}>
          <p className="label" style={{ color: 'var(--erro)' }}>{t('admin.noTipDocTitle')}</p>
          <p className="muted small">{t('admin.noTipDocBody')}</p>
          <button className="cta" style={{ marginTop: 8 }} onClick={onConfigure}>
            {t('admin.noTipDocCta')}
          </button>
        </section>
      )}

      <section className="panel" id="mesas" style={{ scrollMarginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <p className="label">{t('admin.tablesN', { n: tables.length })}</p>
          <span style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {/* O PAINEL DE PAGAMENTOS: é pra lá que a pergunta de girar o QR e a de
                fechar a conta mandam a equipe olhar, e daqui não havia caminho até
                ele (compliance HIGH-A de 497bf87). */}
            <a className="linklike" style={{ textDecoration: 'none' }} href={`/painel?v=${encodeURIComponent(venueId)}`}>
              {t('admin.openPanel')}
            </a>
            <a className="linklike" style={{ textDecoration: 'none' }} href={`/qrs?v=${encodeURIComponent(venueId)}`}>
              {t('admin.printQrs')}
            </a>
          </span>
        </div>
        <p className="muted small">
          {t('admin.tablesHelp', { training: t('admin.training') })}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {/* O rótulo da mesa é PALAVRA DA CASA ("Mesa 7", "Varanda 2") e nunca
              se traduz — mas o campo que o coleta é nosso, e ganha rótulo. */}
          <div style={{ flex: 1 }}>
            <Campo rotulo={t('admin.tableLabel')} maxLength={LIMITES.rotuloDaMesa} placeholder={t('admin.tableEg')} value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          </div>
          <button className="cta" style={{ padding: '12px 20px' }} disabled={!newLabel.trim()} onClick={add}>{t('admin.add')}</button>
        </div>
        {/* CRU, porque JÁ VEM TRADUZIDO. O `useVenueAdmin` traduz no setter
            (`setError(trErr(e))`) e escreve frases prontas; embrulhar de novo em
            `tErr` aqui APAGAVA todas elas — `tErr` recebe um ERRO e lê `.code`
            /`.message`, e uma string não tem nenhum dos dois, então o retorno
            era '' e o dono via um parágrafo vermelho VAZIO ao fechar uma conta,
            desativar uma mesa ocupada ou falhar ao criar mesa. O conserto de
            ec86b37 (LOW-3) destruiu seis mensagens boas pra consertar uma, e a
            que ele queria consertar também ficou vazia (segurança HIGH-2 de
            d7f2683). O código cru que sobrava vira frase na ORIGEM, no hook. */}
        {error && <p className="muted small" style={{ color: 'var(--erro)' }}>{error}</p>}
        {tables.length === 0 && <p className="muted small">{t('admin.noTables')}</p>}
        {/* `table`, não `t`: o parâmetro chamava-se `t` e sombreava o tradutor,
            então `t('admin.openBill')` chamaria a MESA como função. */}
        {tables.map((table) => (
          <div className="checkrow" key={table.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, flexWrap: 'wrap' }}>
              <strong style={{ opacity: table.active ? 1 : 0.45 }}>{table.label}</strong>
              {table.hasOpenCheck && <span className="pill parcial">{t('admin.openBill')}</span>}
              {!table.active && <span className="pill fechada">{t('admin.disabled')}</span>}
              {table.training && <span className="muted small">{t('admin.trainingTable')}</span>}
              {table.qrRotatedAt && <span className="muted small">{t('admin.qrRotated')}</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {table.active && (table.hasOpenCheck
                ? <button className="ghost" onClick={() => admin.closeManualCheck(table)}>{t('admin.closeBill')}</button>
                : <button className="cta" style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => admin.openManualCheck(table)}>{t('admin.openBillCta')}</button>)}
              <button className="ghost" onClick={() => onPrint(table)}>QR</button>
              <button className="ghost" onClick={() => admin.rotate(table)}>{t('admin.rotate')}</button>
              <button className="linklike" onClick={() => admin.toggleTraining(table)}>{table.training ? t('admin.untrain') : t('admin.training')}</button>
              <button className="ghost" onClick={() => admin.toggle(table)}>{table.active ? t('admin.deactivate') : t('admin.activate')}</button>
            </div>
          </div>
        ))}
      </section>

      {/* Recebimento POR MERCADO. Em Espanha não existe agência/conta/dígito —
          existe IBAN, e a conta é da Stripe. Em vez de construir um formulário
          bancário espanhol, a Espanha usa o onboarding hospedado da Stripe,
          que já está aqui: o dono preenche IBAN e KYC na página deles e os
          dados bancários nunca passam pela Racha. Menos código e menos dado
          sensível nosso — a resposta certa era não construir o formulário. */}
      {venue?.market === 'es' ? (
        <section className="panel">
          <p className="label">{t('rcpt.section')}</p>
          <p className="muted small">{t('rcpt.esVia')}</p>
          <AdminStripe venueId={venueId} />
        </section>
      ) : (
        <>
          <AdminRecipient venueId={venueId} onChanged={admin.refresh} />
          <AdminStripe venueId={venueId} />
        </>
      )}

      {/* Créditos da casa: recurso avançado (carteira pré-paga), fora do setup — colapsado. */}
      <details>
        <summary className="muted small" style={{ cursor: 'pointer', padding: '4px 2px' }}>
          {t('admin.houseAdvanced')}
        </summary>
        <div style={{ marginTop: 8 }}>
          <AdminHouse venueId={venueId} />
        </div>
      </details>

      <button className="linklike" style={{ alignSelf: 'center' }} onClick={onConfigure}>{t('admin.openWizard')}</button>
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
        {/* A serifa do sistema é a Newsreader, e é a única que o projeto
            vendoriza. Esta linha pedia a Instrument Serif, que não é carregada
            em lugar nenhum desde a migração: o rótulo da mesa caía em Times. */}
        <h2 className="qrvenue" style={{ fontSize: 30 }}>{table.label}</h2>
        <div className="qrbox">
          <QRCodeSVG value={url} size={220} level="M" marginSize={2} />
        </div>
        <p className="muted small">{t('admin.point')}</p>
        <p className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{url}</p>
        <button className="cta" onClick={() => window.print()}>Imprimir</button>
        <button className="linklike" onClick={onClose}>{t('common.backShort')}</button>
      </section>
    </main>
  );
}
