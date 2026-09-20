import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LangToggle, useT } from './lang';
import { type PanelAtivacao } from './api';
import { textoDoAchado, type CurrencyCode } from './i18n';
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
  findings: Array<{
    severity: string; code: string;
    /** O servidor não manda mais texto: só código e centavos. */
    message?: string;
    /** Os centavos, crus, pra o cliente formatar no idioma do leitor. */
    overpaidCents?: number; deltaCents?: number; driftCents?: number; amountCents?: number;
    // A SEGUNDA quantia de um achado, quando ele tem duas. Acrescentada ao achado,
    // à projeção da rota, ao tipo do `textoDoAchado` e à frase — e esquecida AQUI,
    // que é o tipo declarado do objeto entregue à função. Compila (tudo opcional,
    // atribuição estrutural) e renderiza certo, então nada acusava: o próximo a
    // escrever `f.refundableCents` neste arquivo levava erro de compilação sem
    // pista de onde o campo mora (segurança LOW-1 da rodada quinze).
    refundableCents?: number;
    chargedTipCents?: number; txid?: string; chargeId?: string; recipientId?: string;
  }>;
  at: string;
}

interface PanelData {
  /** A moeda vem do SERVIDOR: o painel imprime dinheiro e não deve adivinhar. */
  venue: { name: string; currency?: CurrencyCode };
  reconcile?: Reconcile;
  checks: Array<{
    checkId: string;
    tableLabel: string;
    state: {
      status: string; totalCents: number; paidCents: number; tipCents: number; anomalies: number;
      /** Contagem de disputas — o backend antigo não manda, e a linha some. */
      disputes?: { open: number; lost: number; won: number };
      /** Recebido a MAIS nesta conta: dívida da casa com quem pagou. */
      overpaidCents?: number;
      /**
       * QUAL cobrança devolver, e quanto. Sem isto o dono lia "R$ 90,00 a
       * devolver" e tinha que adivinhar a cobrança no painel do adquirente —
       * uma obrigação que a tela anuncia e não sabe endereçar.
       */
      overpaidTxids?: Array<{ txid: string; restituteCents: number }>;
      /** Pago DEPOIS de a conta fechar, na parte que a sobra não cobre — ver `paidAfterClose` no redutor. */
      paidAfterClose?: Array<{ txid: string; amountCents: number; sempreDevido?: boolean }>;
    };
  }>;
  today: {
    confirmedCents: number; tipsCents: number; paymentsCount: number; anomalies: number;
    /** O que a conta PEDIU de serviço — o `tipsCents` é o que de fato entrou. */
    tipsChargedCents?: number;
    /** Recebido a mais: dívida da casa com o cliente, fora do faturamento. */
    overpaidCents?: number;
  };
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
  const { t, brl: fmtMoney, tErr } = useT();
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
      return true;
    } catch (e) {
      setError(tErr(e));
      return false;
    }
  }, [venueId, tErr]);

  /**
   * O PAINEL PARA DE PERGUNTAR QUANDO NINGUÉM ESTÁ OLHANDO.
   *
   * Eram quatro segundos, para sempre, em toda aba aberta — e cada volta é uma
   * leitura do razão de toda conta aberta da casa MAIS a conciliação. Uma aba
   * esquecida num tablet do balcão custava 21.600 cargas por dia sem ninguém
   * ler nenhuma delas, e o custo não é só servidor: foi esse laço que
   * transformou uma lentidão de dez segundos no login numa deslogada de todo
   * dono do sistema (o 401 de cada volta chamava `signOut`).
   *
   * `visibilitychange` é o sinal certo: a aba escondida não pinta, então a
   * carga que ela busca não é vista por ninguém. Ao voltar, recarrega NA HORA —
   * quem volta pro tablet quer o estado de agora, não o de daqui a quatro
   * segundos.
   *
   * E o recuo depois de uma falha: numa queda, cada aba aberta batia a cada
   * quatro segundos, o que é exatamente o contrário do que ajuda a plataforma
   * a se levantar. Dobra até um minuto e volta ao normal no primeiro acerto.
   */
  const falhas = useRef(0);
  useEffect(() => {
    let vivo = true;
    let id: ReturnType<typeof setTimeout>;

    const proximoIntervalo = () => Math.min(4000 * 2 ** falhas.current, 60_000);
    const uma = async () => {
      if (!vivo) return;
      if (document.visibilityState === 'visible') {
        const ok = await refresh();
        falhas.current = ok ? 0 : falhas.current + 1;
      }
      if (vivo) id = setTimeout(uma, proximoIntervalo());
    };
    void uma();

    const aoVoltar = () => {
      if (document.visibilityState !== 'visible') return;
      // Volta na hora, e zera o recuo: a pessoa está olhando de novo.
      falhas.current = 0;
      clearTimeout(id);
      void uma();
    };
    document.addEventListener('visibilitychange', aoVoltar);
    return () => { vivo = false; clearTimeout(id); document.removeEventListener('visibilitychange', aoVoltar); };
  }, [refresh]);

  // RESPONDER a pergunta do pago-depois-de-fechar, com a resposta FIXA "não
  // pagou no caixa" — escopada, pra não apagar junto a falha de um estorno, e
  // sem texto livre no razão. Se a mesa pagou no caixa, a resposta NÃO é esta:
  // é devolver pelo adquirente, e a marca sai sozinha. (Compliance HIGH-1,
  // MEDIUM-1 e MEDIUM-3 de 41d1244.)
  // Um clique por vez: dois cliques escreviam duas respostas, e a segunda virava
  // uma marca que nada limpava (compliance LOW-A de 57c0d2e).
  const [respondendo, setRespondendo] = useState<string | null>(null);
  const naoPagouNoCaixa = useCallback(async (checkId: string, txid: string) => {
    if (respondendo) return;
    if (!window.confirm(t('panel.resolveConfirm'))) return;
    setRespondendo(txid);
    try {
      await authedReq('/api/checks/resolve-issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkId, txid, scope: 'paid_after_close' }),
      });
      await refresh();
    } catch (e) {
      window.alert(tErr(e));
    } finally {
      setRespondendo(null);
    }
  }, [t, refresh, tErr, respondendo]);

  if (error) return <main className="shell wide"><p className="muted center">{error}</p></main>;
  if (!data) return <main className="shell wide"><p className="muted center">{t('panel.loading')}</p></main>;

  // A moeda da casa, resolvida UMA vez, e um `brl` local amarrado a ela. O
  // painel chamava `brl(cents)` em oito lugares e o padrão do hook é BRL —
  // então o dono de uma casa espanhola lia "R$" no faturamento do dia e na
  // linha de GORJETA, que é o número que ele leva pra folha. Amarrar o
  // formatador aqui é mais seguro que lembrar a moeda oito vezes.
  const currency: CurrencyCode = data.venue.currency ?? 'BRL';
  // Somado das contas abertas hoje. Backend antigo não manda `disputes`, e aí
  // a linha simplesmente não aparece — que é o comportamento certo.
  const disputas = data.checks.reduce(
    (acc, c) => {
      const d = c.state.disputes;
      if (!d) return acc;
      return { open: acc.open + d.open, lost: acc.lost + d.lost, total: acc.total + d.open + d.lost };
    },
    { open: 0, lost: 0, total: 0 },
  );
  const brl = (c: number) => fmtMoney(c, currency);

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
          <span>
            {t('panel.tip')}
            {/* O que foi COBRADO ao lado do que foi ARRECADADO — só quando os
                dois diferem, senão é ruído. A diferença nasce do Pix pago a
                menor, onde o serviço é o resíduo: ela precisa estar à vista de
                quem distribui a gorjeta (Lei 13.419). */}
            {typeof data.today.tipsChargedCents === 'number'
              && data.today.tipsChargedCents !== data.today.tipsCents
              ? ` · ${t('panel.tipShort', { charged: brl(data.today.tipsChargedCents) })}`
              : ''}
          </span>
        </div>
        {/* Dinheiro a DEVOLVER. Só aparece quando existe, e nunca some dentro
            do faturamento: quem recebeu o indevido tem que restituir. */}
        {(data.today.overpaidCents || 0) > 0 && (
          <div className="stat">
            <b className="mono" style={{ color: 'var(--erro)' }}>{brl(data.today.overpaidCents || 0)}</b>
            <span>{t('panel.toRefund')}</span>
          </div>
        )}
        {/* Chargebacks: só aparece quando existe. Um zero permanente numa tela
            de operação é ruído — e a taxa é o número pelo qual o adquirente
            julga a casa, então quando aparece tem que ser visível. */}
        {disputas.total > 0 && (
          <div className="stat">
            <b className="mono">{disputas.lost}</b>
            <span>
              {t('panel.disputes')}
              {disputas.open > 0 ? ` · ${t('panel.disputesOpen', { n: disputas.open })}` : ''}
            </span>
          </div>
        )}
        <div className="stat">
          <b className="mono">{data.today.anomalies}</b>
          <span>{data.today.anomalies === 0 ? t('panel.noAnomaly') : t('panel.anomalies')}</span>
        </div>
      </section>

      <Conciliacao r={data.reconcile} currency={currency} />

      <Ativacao a={data.ativacao} currency={currency} />

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
              {/* A DÍVIDA na linha da mesa, com a cobrança a devolver.
                  O aviso ao cliente manda "falar com a equipe" — e a tela da
                  equipe não dizia qual mesa, nem qual cobrança. Ver
                  `docs/runbooks/devolver-dinheiro-a-mais.md`. */}
              {(c.state.overpaidCents || 0) > 0 && (
                <span className="owed" style={{ color: 'var(--erro)', fontSize: 12 }}>
                  {t('panel.owedBack', { amount: brl(c.state.overpaidCents || 0) })}
                  {(c.state.overpaidTxids || []).map((x) => (
                    <em key={x.txid} className="mono" style={{ display: 'block', opacity: 0.75 }}>
                      {x.txid} · {brl(x.restituteCents)}
                    </em>
                  ))}
                </span>
              )}
              {/* PAGO DEPOIS DE FECHAR. O Racha não registra o caixa: um Pix que
                  confirma depois de a mesa pagar no caixa e a conta fechar só
                  completa a conta, e a dívida não aparecia em lugar nenhum. A
                  frase de girar o QR manda a equipe olhar AQUI. (Compliance
                  HIGH-1 de 40d5c50.) */}
              {(c.state.paidAfterClose || []).length > 0 && (
                <span className="owed" style={{ color: 'var(--erro)', fontSize: 12 }}>
                  {(c.state.paidAfterClose || []).map((x) => (
                    <em key={`${x.txid}:${x.sempreDevido ? 'devido' : 'pergunta'}`} style={{ display: 'block' }}>
                      {x.sempreDevido
                        ? t('panel.duplicateTip', { amount: brl(x.amountCents) })
                        : t('panel.paidAfterClose', { amount: brl(x.amountCents) })}{' '}
                      <span className="mono" style={{ opacity: 0.75 }}>{x.txid}</span>
                      {!x.sempreDevido && (
                        <>{' '}
                          <button className="linklike" style={{ fontSize: 12 }}
                            disabled={respondendo !== null}
                            onClick={() => void naoPagouNoCaixa(c.checkId, x.txid)}>
                            {t('panel.notPaidAtTill')}
                          </button>
                        </>
                      )}
                    </em>
                  ))}
                </span>
              )}
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

/**
 * O dinheiro bate?
 *
 * Duas contagens independentes do mesmo dinheiro — o log de eventos e a tabela
 * de pagamentos — conferidas ao centavo. Verde é informação, não enfeite: sem
 * ele, "não apareceu nada" e "não conferi nada" são a mesma tela, e a segunda é
 * a que quebra restaurante.
 */

function Conciliacao({ r, currency }: { r: Reconcile | undefined; currency: CurrencyCode }) {
  const { t, brl: fmtMoney, hm } = useT();
  const brl = (c: number) => fmtMoney(c, currency);
  if (!r) return null; // backend antigo ainda no ar — o resto do painel segue de pé
  const vermelho = r.severity === 'critical' || r.severity === 'high';
  return (
    <section className="panel">
      <p className="label">{t('panel.recon')}</p>
      {vermelho ? (
        <>
          {/* `--red` não existe no sistema: o canário de divergência — o número
              mais alto do inegociável #8 — saía num bordô órfão, fora da
              paleta, porque o CSS degrada em silêncio quando a variável falta. */}
          <p className="small" style={{ color: 'var(--erro)' }}>
            <strong>
              {r.driftCents > 0
                ? t('panel.reconDriftAmt', { amount: brl(r.driftCents) })
                : t('panel.reconDrift')}
            </strong>
          </p>
          {/* O ACHADO traduzido, não o texto do servidor.
              O painel imprimia `f.message`: português montado no servidor, com
              centavos crus ("9000¢"). Contra o acordo de trabalho — servidor
              manda código + centavos, cliente traduz e formata — e a tela do
              CLIENTE já tinha ganhado esse tratamento. Esta era o chamador
              esquecido. Código sem tradução cai num genérico que mostra o
              código, nunca a frase de um vizinho. */}
          {r.findings.map((f, i) => (
            <p className="muted small" key={i}>· {textoDoAchado(f, t, brl)}</p>
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
              time: hm(r.at),
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
function Ativacao({ a, currency }: { a: PanelAtivacao | undefined; currency: CurrencyCode }) {
  const { t, brl: fmtMoney, lang } = useT();
  const brl = (c: number) => fmtMoney(c, currency);
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
