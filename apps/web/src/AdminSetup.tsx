import type { Venue, VenueTable } from './api';

/**
 * "Implantação" — o wizard de 4 passos do playbook (docs/onboarding §3 item 3)
 * como checklist VIVO: cada passo é computado do estado real da casa, nunca de
 * flags salvas — o que aparece aqui é o que de fato existe. O piloto é
 * assistido (nós implantamos hoje; vira self-serve depois de 10+ casas), então
 * o valor é guiar quem está implantando e manter o roteiro da equipe à mão
 * depois do D2. Absorve o antigo banner âmbar do recebimento: pendência de
 * pagamento é o passo 3 em tom de alerta, não um aviso solto.
 */

const FRASE_GARCOM =
  '“Pode escanear o QR da mesa pra ver a conta e pagar quando quiser — a gorjeta vai direto pra gente.”';

interface Step {
  done: boolean;
  title: string;
  sub: string;
  href?: string;
  warn?: boolean;
}

export default function AdminSetup({ venue, tables }: { venue: Venue; tables: VenueTable[] }) {
  const mesasReais = tables.filter((t) => t.active && !t.training).length;
  const temTreino = tables.some((t) => t.training);
  const recebedorOk = /^r[ep]_/.test(venue.pspRecipientId || '');

  const steps: Step[] = [
    {
      done: true,
      title: 'Casa criada',
      sub: `${venue.name} · serviço sugerido ${(venue.servicoBp / 100).toFixed(0)}%`,
    },
    {
      done: mesasReais > 0,
      title: 'Mesas com os rótulos reais',
      sub: mesasReais > 0
        ? `${mesasReais} ${mesasReais === 1 ? 'mesa ativa' : 'mesas ativas'} — depois imprima os QRs`
        : 'cadastre as mesas como elas se chamam no salão',
      href: '#mesas',
    },
    {
      done: recebedorOk,
      title: 'Recebimento conectado',
      sub: recebedorOk
        ? 'recebedor criado — repasse automático diário'
        : 'sem recebedor, as mesas só funcionam em teste: cobrança real não tem para onde liquidar',
      href: '#recebimento',
      warn: !recebedorOk,
    },
    {
      done: temTreino,
      title: 'Equipe: mesa de treino',
      sub: temTreino
        ? 'mesa de treino marcada — pagamentos dela ficam fora dos números'
        : 'marque uma mesa como “treino” pro workshop pré-turno da equipe',
      href: '#mesas',
    },
  ];
  const feitos = steps.filter((s) => s.done).length;
  const completo = feitos === steps.length;

  return (
    <section className="panel" aria-label="Implantação">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <p className="label">Implantação</p>
        <span className="muted small">{completo ? 'completa ✓' : `${feitos} de ${steps.length}`}</span>
      </div>

      {!completo && steps.map((s) => (
        <div className="checkrow" key={s.title}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flex: 1, flexWrap: 'wrap' }}>
            <span aria-hidden="true" style={{ opacity: s.done ? 1 : 0.35 }}>{s.done ? '✓' : '○'}</span>
            <div style={{ flex: 1, minWidth: 180 }}>
              <strong style={{ opacity: s.done ? 0.6 : 1 }}>{s.title}</strong>
              <p className="muted small" style={s.warn ? { color: 'var(--burgundy)' } : undefined}>{s.sub}</p>
            </div>
          </div>
          {!s.done && s.href && (
            <a className="ghost" style={{ textDecoration: 'none' }} href={s.href}>resolver ↓</a>
          )}
        </div>
      ))}

      {/* O roteiro sobrevive ao D2: é o que mantém o garçom apresentando o QR. */}
      <details style={{ marginTop: completo ? 0 : 8 }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>
          Roteiro da equipe (workshop de 15 min + a frase do garçom)
        </summary>
        <div className="muted small" style={{ paddingTop: 8, display: 'grid', gap: 6 }}>
          <p>
            1 · Workshop pré-turno de 15 min: cada garçom escaneia e paga uma conta
            de mentira <em>no próprio celular</em>, na mesa de treino — a experiência
            dissolve o medo, e a mesa de treino fica fora dos números.
          </p>
          <p>2 · A frase que apresenta o QR, uma só: {FRASE_GARCOM}</p>
          <p>
            3 · Primeira mesa real paga com a gente presente. Meta da semana 1:
            ≥25% das contas pelo QR — acompanhe na seção Ativação do painel da casa.
          </p>
          <p>
            🖨 <a href={`/qrs?v=${encodeURIComponent(venue.id)}`}>Imprimir os QRs das mesas</a> —
            display por mesa, nunca A4 solto.
          </p>
        </div>
      </details>
    </section>
  );
}
