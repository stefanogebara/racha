import { useState } from 'react';
import AdminRecipient from './AdminRecipient';
import AdminStripe from './AdminStripe';
import type { VenueTable } from './api';
import type { VenueAdmin } from './useVenueAdmin';
import { useT } from './lang';

/**
 * Assistente de configuração do restaurante — uma etapa por tela, com
 * próximo/voltar. Mesas → Recebimento → Equipe → Pronto. Cada etapa mostra seu
 * estado real (✓ quando de fato feito), computado dos dados vivos, nunca de
 * flags salvas. É a tela padrão de um restaurante ainda não configurado; depois
 * de operante, o padrão vira o painel de gestão (ManageView), e o dono volta
 * aqui pelo link "assistente de configuração".
 */

/// Chaves, não rótulos: o passo é um dado, o nome dele é texto de tela.
const STEP_KEYS = ['wiz.stepTables', 'wiz.stepPayout', 'wiz.stepStaff', 'wiz.stepDone'] as const;
function StepHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ marginTop: 4 }}>
      <p className="label" style={{ marginBottom: 2 }}>{title}</p>
      <p className="muted small" style={{ margin: 0 }}>{sub}</p>
    </div>
  );
}

export default function SetupWizard({ admin, venueId, onPrint, onDone }: {
  admin: VenueAdmin; venueId: string; onPrint: (t: VenueTable) => void; onDone: () => void;
}) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [newLabel, setNewLabel] = useState('');
  const { venue, tables, error } = admin;

  const mesasReais = tables.filter((t) => t.active && !t.training).length;
  const recebedorOk = /^r[ep]_/.test(venue?.pspRecipientId || '');
  const temTreino = tables.some((t) => t.training);
  const done = [mesasReais > 0, recebedorOk, temTreino, false];
  // Trava de avanço por etapa: só sai da etapa quando o essencial dela existe.
  // Passo 1 (mesas): ≥1 mesa. Passo 2 (recebimento): recebedor criado — sem ele
  // as cobranças reais não liquidam, então não deixa passar batido.
  const leaveOk = (s: number) => (s === 0 ? tables.length > 0 : s === 1 ? recebedorOk : true);
  const canNext = leaveOk(step);
  // Pular pela trilha (stepper): pra frente só até onde as travas deixam; voltar sempre.
  const canJump = (target: number) => {
    if (target <= step) return true;
    for (let s = step; s < target; s++) if (!leaveOk(s)) return false;
    return true;
  };

  async function add() {
    if (await admin.addTable(newLabel)) setNewLabel('');
  }

  return (
    <>
      {/* Stepper — os círculos são clicáveis pra pular direto pra qualquer etapa. */}
      <section className="panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          {STEP_KEYS.map((stepKey, i) => {
            const state = done[i] ? 'done' : i === step ? 'current' : 'pending';
            // Musgo = feito, azul = onde voce esta, papel = ainda nao.
            // O passo ATUAL saia na cor de erro (era `--burgundy`, que apontava
            // pra tinta): agora que erro e coral de verdade, o passo atual pintado
            // de erro diria que ha algo errado com ele. Azul e a cor de 'em curso'
            // no Presence, e e o que o passo atual e.
            const bg = state === 'done' ? 'var(--ok)' : state === 'current' ? 'var(--emcurso)' : 'transparent';
            const fg = state === 'pending' ? 'var(--stone)' : '#fff';
            const reachable = canJump(i);
            return (
              <div key={stepKey} style={{ display: 'flex', alignItems: 'flex-start', flex: i < STEP_KEYS.length - 1 ? 1 : '0 0 auto', minWidth: 0 }}>
                <button onClick={() => reachable && setStep(i)} disabled={!reachable} aria-current={i === step}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: reachable ? 'pointer' : 'not-allowed', opacity: reachable ? 1 : 0.5, padding: 0 }}>
                  <span style={{ width: 28, height: 28, borderRadius: 999, background: bg, color: fg, border: state === 'pending' ? '1px solid var(--glass-border-input)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>
                    {done[i] ? '✓' : i + 1}
                  </span>
                  <span className="small" style={{ color: i === step ? 'var(--charcoal)' : 'var(--stone)', fontWeight: i === step ? 600 : 400 }}>{t(stepKey)}</span>
                </button>
                {i < STEP_KEYS.length - 1 && (
                  <div style={{ flex: 1, height: 2, background: done[i] ? 'var(--emerald)' : 'var(--glass-border-input)', margin: '13px 6px 0' }} />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {step === 0 && (
        <>
          <StepHead title={t('wiz.t1')} sub={t('wiz.t1sub')} />
          <section className="panel">
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="namefield" style={{ flex: 1 }} placeholder={t('admin.tableEg')} value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
              <button className="cta" style={{ padding: '12px 20px' }} disabled={!newLabel.trim()} onClick={add}>{t('admin.add')}</button>
            </div>
            {error && <p className="muted small" style={{ color: 'var(--erro)' }}>{error}</p>}
            {tables.length === 0 && <p className="muted small">{t('admin.noTables')}</p>}
            {tables.map((table) => (
              <div className="checkrow" key={table.id}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ opacity: table.active ? 1 : 0.45 }}>{table.label}</strong>
                  {!table.active && <span className="pill fechada">{t('admin.disabled')}</span>}
                  {table.training && <span className="muted small">{t('admin.trainingTable')}</span>}
                </div>
                <button className="ghost" onClick={() => admin.toggle(table)}>{table.active ? t('admin.deactivate') : t('admin.activate')}</button>
              </div>
            ))}
          </section>
        </>
      )}

      {step === 1 && (
        <>
          {/* Em Espanha nós NÃO validamos banco e conta — a Stripe faz isso na
              página dela. Descrever o fluxo brasileiro aqui prometeria uma
              tela que não existe. */}
          <StepHead title={t('wiz.t2')} sub={t(venue?.market === 'es' ? 'wiz.t2subEs' : 'wiz.t2sub')} />
          {/* Mesmo desdobramento do painel: Espanha vai pelo onboarding
              hospedado da Stripe (IBAN e KYC lá), Brasil pelo recebedor. */}
          {venue?.market === 'es'
            ? <AdminStripe venueId={venueId} />
            : <AdminRecipient venueId={venueId} onChanged={admin.refresh} />}
        </>
      )}

      {step === 2 && (
        <>
          <StepHead title={t('wiz.t3')} sub={t('wiz.t3sub')} />
          <section className="panel">
            {tables.length === 0 && <p className="muted small">{t('setup.tablesFirst')}</p>}
            {tables.map((table) => (
              <div className="checkrow" key={table.id}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{table.label}</strong>
                  {table.training && <span className="pill paga">{t('admin.training')}</span>}
                </div>
                <button className={table.training ? 'ghost' : 'cta'} style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => admin.toggleTraining(table)}>
                  {table.training ? t('admin.untrain') : t('admin.useInTraining')}
                </button>
              </div>
            ))}
            <details style={{ marginTop: 8 }}>
              <summary className="muted small" style={{ cursor: 'pointer' }}>{t('setup.script')}</summary>
              <div className="muted small" style={{ paddingTop: 8, display: 'grid', gap: 6 }}>
                <p>{t('wiz.script1')}</p>
                <p>{t('setup.script2', { line: t('wiz.staffLine') })}</p>
                <p>{t('wiz.script3')}</p>
              </div>
            </details>
          </section>
        </>
      )}

      {step === 3 && (
        <>
          <StepHead title={t('wiz.t4')} sub={t('wiz.t4sub')} />
          <section className="panel">
            <div className="checkrow">
              <span>{done[0] ? '✓' : '○'} {t('wiz.doneTables')}</span>
              <span className="muted small">{t('wiz.doneActive', { n: mesasReais })}</span>
            </div>
            <div className="checkrow">
              <span>{done[1] ? '✓' : '○'} {t('wiz.donePayout')}</span>
              <span className="muted small" style={!recebedorOk ? { color: 'var(--erro)' } : undefined}>{recebedorOk ? t('wiz.connected') : t('wiz.pending')}</span>
            </div>
            <div className="checkrow">
              <span>{done[2] ? '✓' : '○'} {t('wiz.doneTraining')}</span>
              <span className="muted small">{temTreino ? t('wiz.marked') : t('wiz.none')}</span>
            </div>
            {tables.length > 0 && (
              <a className="cta" style={{ textDecoration: 'none', textAlign: 'center', marginTop: 8 }} href={`/qrs?v=${encodeURIComponent(venueId)}`}>
                🖨 {t('setup.printLink')}
              </a>
            )}
            {tables[0] && (
              <button className="ghost" style={{ marginTop: 4 }} onClick={() => onPrint(tables[0])}>{t('wiz.seeQr', { table: tables[0].label })}</button>
            )}
            {!recebedorOk && (
              <p className="muted small">{t('wiz.canFinish')}</p>
            )}
          </section>
        </>
      )}

      {/* Navegação */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <button className="ghost" style={{ visibility: step > 0 ? 'visible' : 'hidden' }} onClick={() => setStep(step - 1)}>{t('wiz.back')}</button>
        {step < STEP_KEYS.length - 1
          ? <button className="cta" disabled={!canNext} onClick={() => setStep(step + 1)}>{t('wiz.next')}</button>
          : <button className="cta" onClick={onDone}>{t('wiz.finish')}</button>}
      </div>
      {step === 1 && !recebedorOk && (
        <p className="muted small" style={{ alignSelf: 'center', textAlign: 'center', margin: 0 }}>
          {t('wiz.needRecipient')}
        </p>
      )}
      <button className="linklike" style={{ alignSelf: 'center' }} onClick={onDone}>{t('wiz.straightToPanel')}</button>
    </>
  );
}
