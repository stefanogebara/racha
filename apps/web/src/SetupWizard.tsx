import { useState } from 'react';
import AdminRecipient from './AdminRecipient';
import type { VenueTable } from './api';
import type { VenueAdmin } from './useVenueAdmin';

/**
 * Assistente de configuração do restaurante — uma etapa por tela, com
 * próximo/voltar. Mesas → Recebimento → Equipe → Pronto. Cada etapa mostra seu
 * estado real (✓ quando de fato feito), computado dos dados vivos, nunca de
 * flags salvas. É a tela padrão de um restaurante ainda não configurado; depois
 * de operante, o padrão vira o painel de gestão (ManageView), e o dono volta
 * aqui pelo link "assistente de configuração".
 */

const STEPS = ['Mesas', 'Recebimento', 'Equipe', 'Pronto'];
const FRASE_GARCOM =
  '“Pode escanear o QR da mesa pra ver a conta e pagar quando quiser — a gorjeta vai direto pra gente.”';

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
  const [step, setStep] = useState(0);
  const [newLabel, setNewLabel] = useState('');
  const { venue, tables, error } = admin;

  const mesasReais = tables.filter((t) => t.active && !t.training).length;
  const recebedorOk = /^r[ep]_/.test(venue?.pspRecipientId || '');
  const temTreino = tables.some((t) => t.training);
  const done = [mesasReais > 0, recebedorOk, temTreino, false];
  const canNext = step === 0 ? tables.length > 0 : true;

  async function add() {
    if (await admin.addTable(newLabel)) setNewLabel('');
  }

  return (
    <>
      {/* Stepper — os círculos são clicáveis pra pular direto pra qualquer etapa. */}
      <section className="panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          {STEPS.map((title, i) => {
            const state = done[i] ? 'done' : i === step ? 'current' : 'pending';
            const bg = state === 'done' ? 'var(--emerald)' : state === 'current' ? 'var(--burgundy)' : 'transparent';
            const fg = state === 'pending' ? 'var(--stone)' : '#fff';
            return (
              <div key={title} style={{ display: 'flex', alignItems: 'flex-start', flex: i < STEPS.length - 1 ? 1 : '0 0 auto', minWidth: 0 }}>
                <button onClick={() => setStep(i)} aria-current={i === step}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  <span style={{ width: 28, height: 28, borderRadius: 999, background: bg, color: fg, border: state === 'pending' ? '1px solid var(--glass-border-input)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>
                    {done[i] ? '✓' : i + 1}
                  </span>
                  <span className="small" style={{ color: i === step ? 'var(--charcoal)' : 'var(--stone)', fontWeight: i === step ? 600 : 400 }}>{title}</span>
                </button>
                {i < STEPS.length - 1 && (
                  <div style={{ flex: 1, height: 2, background: done[i] ? 'var(--emerald)' : 'var(--glass-border-input)', margin: '13px 6px 0' }} />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {step === 0 && (
        <>
          <StepHead title="Passo 1 · Mesas" sub="Cadastre cada mesa com o nome que ela tem no salão (“Mesa 12”, “Balcão 3”). É o que o cliente vê ao escanear o QR." />
          <section className="panel">
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="namefield" style={{ flex: 1 }} placeholder="Ex.: Mesa 12" value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
              <button className="cta" style={{ padding: '12px 20px' }} disabled={!newLabel.trim()} onClick={add}>Adicionar</button>
            </div>
            {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
            {tables.length === 0 && <p className="muted small">nenhuma mesa ainda — adicione a primeira acima.</p>}
            {tables.map((t) => (
              <div className="checkrow" key={t.id}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ opacity: t.active ? 1 : 0.45 }}>{t.label}</strong>
                  {!t.active && <span className="pill fechada">desativada</span>}
                  {t.training && <span className="muted small">· treino</span>}
                </div>
                <button className="ghost" onClick={() => admin.toggle(t)}>{t.active ? 'desativar' : 'ativar'}</button>
              </div>
            ))}
          </section>
        </>
      )}

      {step === 1 && (
        <>
          <StepHead title="Passo 2 · Recebimento" sub="Onde o dinheiro das comandas cai. Validamos CPF/CNPJ, banco e conta aqui na hora; o Pagar.me confirma a conta (análise KYC, ~3 dias úteis)." />
          <AdminRecipient venueId={venueId} onChanged={admin.refresh} />
        </>
      )}

      {step === 2 && (
        <>
          <StepHead title="Passo 3 · Equipe" sub="Marque uma mesa como treino: a equipe pratica o fluxo nela sem sujar os números da casa." />
          <section className="panel">
            {tables.length === 0 && <p className="muted small">cadastre mesas no passo 1 primeiro.</p>}
            {tables.map((t) => (
              <div className="checkrow" key={t.id}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{t.label}</strong>
                  {t.training && <span className="pill paga">treino</span>}
                </div>
                <button className={t.training ? 'ghost' : 'cta'} style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => admin.toggleTraining(t)}>
                  {t.training ? 'tirar do treino' : 'usar no treino'}
                </button>
              </div>
            ))}
            <details style={{ marginTop: 8 }}>
              <summary className="muted small" style={{ cursor: 'pointer' }}>Roteiro da equipe (workshop de 15 min + a frase do garçom)</summary>
              <div className="muted small" style={{ paddingTop: 8, display: 'grid', gap: 6 }}>
                <p>1 · Workshop pré-turno de 15 min: cada garçom escaneia e paga uma conta de mentira <em>no próprio celular</em>, na mesa de treino — a experiência dissolve o medo.</p>
                <p>2 · A frase que apresenta o QR, uma só: {FRASE_GARCOM}</p>
                <p>3 · Primeira mesa real paga com a gente presente. Meta da semana 1: ≥25% das contas pelo QR.</p>
              </div>
            </details>
          </section>
        </>
      )}

      {step === 3 && (
        <>
          <StepHead title="Tudo pronto" sub="Revise e imprima os QRs. Você pode voltar e ajustar qualquer passo depois." />
          <section className="panel">
            <div className="checkrow">
              <span>{done[0] ? '✓' : '○'} Mesas cadastradas</span>
              <span className="muted small">{mesasReais} ativa(s)</span>
            </div>
            <div className="checkrow">
              <span>{done[1] ? '✓' : '○'} Recebimento</span>
              <span className="muted small" style={!recebedorOk ? { color: 'var(--burgundy)' } : undefined}>{recebedorOk ? 'conectado' : 'pendente'}</span>
            </div>
            <div className="checkrow">
              <span>{done[2] ? '✓' : '○'} Mesa de treino</span>
              <span className="muted small">{temTreino ? 'marcada' : 'nenhuma'}</span>
            </div>
            {tables.length > 0 && (
              <a className="cta" style={{ textDecoration: 'none', textAlign: 'center', marginTop: 8 }} href={`/qrs?v=${encodeURIComponent(venueId)}`}>
                🖨 Imprimir os QRs das mesas
              </a>
            )}
            {tables[0] && (
              <button className="ghost" style={{ marginTop: 4 }} onClick={() => onPrint(tables[0])}>ver o QR da {tables[0].label}</button>
            )}
            {!recebedorOk && (
              <p className="muted small">Dá pra concluir agora e conectar o recebimento depois — mas sem ele as cobranças reais não liquidam.</p>
            )}
          </section>
        </>
      )}

      {/* Navegação */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <button className="ghost" style={{ visibility: step > 0 ? 'visible' : 'hidden' }} onClick={() => setStep(step - 1)}>← Voltar</button>
        {step < STEPS.length - 1
          ? <button className="cta" disabled={!canNext} onClick={() => setStep(step + 1)}>Próximo →</button>
          : <button className="cta" onClick={onDone}>Concluir ✓</button>}
      </div>
      <button className="linklike" style={{ alignSelf: 'center' }} onClick={onDone}>ir direto pro painel</button>
    </>
  );
}
