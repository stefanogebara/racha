import { useCallback, useEffect, useMemo, useState } from 'react';
import { brl, type PanelAtivacao } from './api';
import { authedReq, signOut } from './auth';

/**
 * Painel do restaurante — live view of every table's check + day totals.
 * Warm Glass; auto-refresh. Behind the owner login gate (Gate.tsx); every
 * fetch carries the owner's token and the API enforces venue ownership.
 */

interface PanelData {
  venue: { name: string };
  checks: Array<{
    checkId: string;
    tableLabel: string;
    state: { status: string; totalCents: number; paidCents: number; tipCents: number; anomalies: number };
  }>;
  today: { confirmedCents: number; tipsCents: number; paymentsCount: number; anomalies: number };
  ativacao: PanelAtivacao;
}

const STATUS_LABEL: Record<string, string> = {
  aberta: 'aberta',
  parcial: 'pagando',
  paga: 'paga',
  fechada: 'fechada',
};

export default function Panel() {
  const venueId = useMemo(
    () => new URLSearchParams(window.location.search).get('v') ?? '',
    [],
  );
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await authedReq<PanelData>(`/api/panel?v=${encodeURIComponent(venueId)}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [venueId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  if (error) return <main className="shell wide"><p className="muted center">{error}</p></main>;
  if (!data) return <main className="shell wide"><p className="muted center">carregando o salão…</p></main>;

  return (
    <main className="shell wide">
      <header className="head">
        <span className="venue">{data.venue.name}</span>
        <button className="linklike" onClick={() => signOut().then(() => window.location.reload())}>sair</button>
      </header>

      <section className="statgrid">
        <div className="stat">
          <b className="mono">{brl(data.today.confirmedCents)}</b>
          <span>recebido hoje · {data.today.paymentsCount} pagamentos</span>
        </div>
        <div className="stat">
          <b className="mono">{brl(data.today.tipsCents)}</b>
          <span>serviço da equipe (folha)</span>
        </div>
        <div className="stat">
          <b className="mono">{data.today.anomalies}</b>
          <span>{data.today.anomalies === 0 ? 'nenhuma anomalia ✓' : 'anomalias — conciliar!'}</span>
        </div>
      </section>

      <Ativacao a={data.ativacao} />

      <section className="panel">
        <p className="label">Mesas</p>
        {data.checks.length === 0 && <p className="muted small">nenhuma conta aberta.</p>}
        {data.checks.map((c) => {
          const pct = c.state.totalCents > 0
            ? Math.min(100, (c.state.paidCents / c.state.totalCents) * 100)
            : 0;
          return (
            <div className="checkrow" key={c.checkId}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>{c.tableLabel}</strong>
                  <span className="mono">
                    {brl(c.state.paidCents)} / {brl(c.state.totalCents)}
                  </span>
                </div>
                <div className="progressbar"><span style={{ width: `${pct}%` }} /></div>
              </div>
              <span className={`pill ${c.state.status}`}>{STATUS_LABEL[c.state.status] ?? c.state.status}</span>
            </div>
          );
        })}
      </section>

      <footer className="foot">
        <span>racha · painel atualiza sozinho a cada 4s</span>
      </footer>
    </main>
  );
}

// ------------------------------------------------------------------ ativação

/** 'YYYY-MM-DD' → 'DD/MM' por fatia de string — new Date() aqui empurraria o dia
 *  para a véspera no fuso BR (ISO sem hora é parseado como meia-noite UTC). */
const ddmm = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

/** Últimos 7 dias de uso — barras CSS proporcionais ao valor, sem lib de gráfico. */
function Ativacao({ a }: { a: PanelAtivacao | undefined }) {
  if (!a) return null; // backend antigo ainda no ar — o resto do painel segue de pé
  const vazio = a.semana.pagamentos === 0 && a.semana.contas === 0;
  const teto = Math.max(1, ...a.dias.map((d) => d.valorCents));
  return (
    <section className="panel">
      <p className="label">Ativação — últimos 7 dias</p>
      {vazio ? (
        <p className="muted small">sem movimento nos últimos 7 dias.</p>
      ) : (
        <>
          {a.dias.map((d) => (
            <div className="actrow" key={d.dia}>
              <span className="mono muted small">{ddmm(d.dia)}</span>
              <div className="actbar"><span style={{ width: `${Math.round((d.valorCents / teto) * 100)}%` }} /></div>
              <span className={d.contas === 0 ? 'mono small muted' : 'mono small'}>
                {d.contas} {d.contas === 1 ? 'conta' : 'contas'} · {brl(d.valorCents)}
              </span>
            </div>
          ))}
          <p className="small">
            Pix {a.metodos.pix} · Cartão {a.metodos.card} · Saldo {a.metodos.house_account}
          </p>
          <p className="muted small">
            Semana: {a.semana.pagamentos} {a.semana.pagamentos === 1 ? 'pagamento' : 'pagamentos'} ·{' '}
            {a.semana.contas} {a.semana.contas === 1 ? 'conta' : 'contas'} · {brl(a.semana.valorCents)} ·{' '}
            serviço {brl(a.semana.gorjetaCents)}
          </p>
        </>
      )}
    </section>
  );
}
