import { useCallback, useEffect, useMemo, useState } from 'react';
import { LangToggle, useT } from './lang';
import { type PanelAtivacao } from './api';
import { authedReq, signOut } from './auth';

/**
 * Painel do restaurante — live view of every table's check + day totals.
 * Warm Glass; auto-refresh. Behind the owner login gate (Gate.tsx); every
 * fetch carries the owner's token and the API enforces venue ownership.
 */

interface Reconcile {
  severity: 'ok' | 'info' | 'high' | 'critical';
  driftCents: number;
  checksChecked: number;
  accountsChecked: number;
  findings: Array<{ severity: string; code: string; message: string }>;
  at: string;
}

interface PanelData {
  venue: { name: string };
  reconcile?: Reconcile;
  checks: Array<{
    checkId: string;
    tableLabel: string;
    state: { status: string; totalCents: number; paidCents: number; tipCents: number; anomalies: number };
  }>;
  today: { confirmedCents: number; tipsCents: number; paymentsCount: number; anomalies: number };
  ativacao: PanelAtivacao;
}

/// Chaves, não palavras. Um mapa de strings fixas em português é uma língua só
/// disfarçada de dado — a mesma observação que a decisão #35 fez sobre o
/// `LEDGER_LABEL`. O texto sai traduzido na renderização.
const STATUS_KEY = {
  aberta: 'panel.status.aberta',
  parcial: 'panel.status.parcial',
  paga: 'panel.status.paga',
  fechada: 'panel.status.fechada',
} as const;

export default function Panel() {
  const { t, brl } = useT();
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
  if (!data) return <main className="shell wide"><p className="muted center">{t('panel.loading')}</p></main>;

  return (
    <main className="shell wide">
      <header className="head">
        <span className="venue">{data.venue.name}</span>
        <button className="linklike" onClick={() => signOut().then(() => window.location.reload())}>{t('common.signOut')}</button>
      </header>

      <section className="statgrid">
        <div className="stat">
          <b className="mono">{brl(data.today.confirmedCents)}</b>
          <span>{t('panel.receivedToday', { n: data.today.paymentsCount })}</span>
        </div>
        <div className="stat">
          <b className="mono">{brl(data.today.tipsCents)}</b>
          <span>{t('panel.tip')}</span>
        </div>
        <div className="stat">
          <b className="mono">{data.today.anomalies}</b>
          <span>{data.today.anomalies === 0 ? t('panel.noAnomaly') : t('panel.anomalies')}</span>
        </div>
      </section>

      <Conciliacao r={data.reconcile} />

      <Ativacao a={data.ativacao} />

      <section className="panel">
        <p className="label">{t('panel.tables')}</p>
        {data.checks.length === 0 && <p className="muted small">{t('panel.noOpenBill')}</p>}
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
              <span className={`pill ${c.state.status}`}>
                {c.state.status in STATUS_KEY
                  ? t(STATUS_KEY[c.state.status as keyof typeof STATUS_KEY])
                  : c.state.status}
              </span>
            </div>
          );
        })}
      </section>

      <footer className="foot">
        <LangToggle compact />
        <span>{t('panel.autoRefresh')}</span>
      </footer>
    </main>
  );
}

// -------------------------------------------------------------- conciliação

/** 'HH:MM' local a partir do ISO — só a hora interessa aqui. */
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * O dinheiro bate?
 *
 * Duas contagens independentes do mesmo dinheiro — o log de eventos e a tabela
 * de pagamentos — conferidas ao centavo. Verde é informação, não enfeite: sem
 * ele, "não apareceu nada" e "não conferi nada" são a mesma tela, e a segunda é
 * a que quebra restaurante.
 */
function Conciliacao({ r }: { r: Reconcile | undefined }) {
  const { t, brl } = useT();
  if (!r) return null; // backend antigo ainda no ar — o resto do painel segue de pé
  const vermelho = r.severity === 'critical' || r.severity === 'high';
  return (
    <section className="panel">
      <p className="label">{t('panel.recon')}</p>
      {vermelho ? (
        <>
          <p className="small" style={{ color: 'var(--red, #a3231f)' }}>
            <strong>
              {r.driftCents > 0
                ? t('panel.reconDriftAmt', { amount: brl(r.driftCents) })
                : t('panel.reconDrift')}
            </strong>
          </p>
          {r.findings.map((f, i) => (
            <p className="muted small" key={i}>· {f.message}</p>
          ))}
          <p className="muted small">
            {t('panel.reconManual')} {t('panel.reconCall')}
          </p>
        </>
      ) : (
        <p className="small">
          {t('panel.reconOkFull')} <span className="muted">
            {t('panel.reconChecked', {
              bills: r.checksChecked === 1 ? t('panel.billsOne') : t('panel.billsMany', { n: r.checksChecked }),
              accounts: r.accountsChecked === 0 ? ''
                : r.accountsChecked === 1 ? t('panel.balOne') : t('panel.balMany', { n: r.accountsChecked }),
              time: hhmm(r.at),
            })}
          </span>
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ ativação

/** 'YYYY-MM-DD' → 'DD/MM' por fatia de string — new Date() aqui empurraria o dia
 *  para a véspera no fuso BR (ISO sem hora é parseado como meia-noite UTC). */
/// Dia/mês na ORDEM do idioma. "05/09" lido por um falante de inglês é 9 de
/// maio, não 5 de setembro — e a coluna toda é uma linha do tempo, então a
/// ordem errada não é um detalhe, é o gráfico invertido na cabeça de quem lê.
const dayMonth = (dia: string, lang: 'pt' | 'en' | 'es') => {
  const [, mm, dd] = dia.split('-');
  // Inglês é o único que põe o mês na frente. Português e espanhol leem
  // dia/mês, e trocar a ordem inverte o gráfico na cabeça de quem lê.
  return lang === 'en' ? `${mm}/${dd}` : `${dd}/${mm}`;
};

/** Últimos 7 dias de uso — barras CSS proporcionais ao valor, sem lib de gráfico. */
function Ativacao({ a }: { a: PanelAtivacao | undefined }) {
  const { t, brl, lang } = useT();
  // Backend antigo ainda no ar — o resto do painel segue de pé. A guarda cobre
  // o objeto E as partes dele: `semana`/`dias` faltando não pode derrubar a
  // tela que mostra o dinheiro do dia.
  if (!a || !a.semana || !Array.isArray(a.dias)) return null;
  const vazio = a.semana.pagamentos === 0 && a.semana.contas === 0;
  const teto = Math.max(1, ...a.dias.map((d) => d.valorCents));
  return (
    <section className="panel">
      <p className="label">{t('panel.activation')}</p>
      {vazio ? (
        <p className="muted small">{t('panel.noMovement')}</p>
      ) : (
        <>
          {a.dias.map((d) => (
            <div className="actrow" key={d.dia}>
              <span className="mono muted small">{dayMonth(d.dia, lang)}</span>
              <div className="actbar"><span style={{ width: `${Math.round((d.valorCents / teto) * 100)}%` }} /></div>
              <span className={d.contas === 0 ? 'mono small muted' : 'mono small'}>
                {d.contas === 1 ? t('panel.oneBill') : t('panel.nBills', { n: d.contas })}
                {' · '}{brl(d.valorCents)}
              </span>
            </div>
          ))}
          {/* `a` é checado acima porque um backend mais antigo pode não mandar
              a ativação — mas `metodos` e `semana` eram lidos direto, então um
              backend mais antigo que mande a ativação SEM eles derrubava o
              painel inteiro em tela branca, que é exatamente o que a guarda de
              cima existe pra evitar. Reproduzido no navegador com um payload
              parcial. O painel mostra o que veio e cala o que não veio. */}
          {a.metodos && (
            <p className="small">
              {t('panel.methods', { pix: a.metodos.pix, card: a.metodos.card,
                                    house: a.metodos.house_account })}
            </p>
          )}
          <p className="muted small">
            {t('panel.weekLine', {
              payments: a.semana.pagamentos === 1 ? t('panel.onePayment')
                : t('panel.nPayments', { n: a.semana.pagamentos }),
              bills: a.semana.contas === 1 ? t('panel.oneBill')
                : t('panel.nBills', { n: a.semana.contas }),
              amount: brl(a.semana.valorCents),
              tip: brl(a.semana.gorjetaCents),
            })}
          </p>
        </>
      )}
    </section>
  );
}
