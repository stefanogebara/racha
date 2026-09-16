import type { Venue, VenueTable } from './api';
import { useT } from './lang';

/**
 * "Implantação" — o wizard de 4 passos do playbook (docs/onboarding §3 item 3)
 * como checklist VIVO: cada passo é computado do estado real da casa, nunca de
 * flags salvas — o que aparece aqui é o que de fato existe. O piloto é
 * assistido (nós implantamos hoje; vira self-serve depois de 10+ casas), então
 * o valor é guiar quem está implantando e manter o roteiro da equipe à mão
 * depois do D2. Absorve o antigo banner âmbar do recebimento: pendência de
 * pagamento é o passo 3 em tom de alerta, não um aviso solto.
 */

interface Step {
  done: boolean;
  title: string;
  sub: string;
  href?: string;
  warn?: boolean;
}

export default function AdminSetup({ venue, tables }: { venue: Venue; tables: VenueTable[] }) {
  const { t } = useT();
  const mesasReais = tables.filter((t) => t.active && !t.training).length;
  const temTreino = tables.some((t) => t.training);
  const recebedorOk = /^r[ep]_/.test(venue.pspRecipientId || '');

  const steps: Step[] = [
    {
      done: true,
      title: t('setup.s1'),
      sub: t('setup.s1sub', { venue: venue.name, pct: (venue.servicoBp / 100).toFixed(0) }),
    },
    {
      done: mesasReais > 0,
      title: t('setup.s2'),
      sub: mesasReais === 0 ? t('setup.s2none')
        : mesasReais === 1 ? t('setup.s2one') : t('setup.s2many', { n: mesasReais }),
      href: '#mesas',
    },
    {
      done: recebedorOk,
      title: t('setup.s3'),
      sub: recebedorOk ? t('setup.s3ok') : t('setup.s3none'),
      href: '#recebimento',
      warn: !recebedorOk,
    },
    {
      done: temTreino,
      title: t('setup.s4'),
      sub: temTreino ? t('setup.s4ok') : t('setup.s4none'),
      href: '#mesas',
    },
  ];
  const feitos = steps.filter((s) => s.done).length;
  const completo = feitos === steps.length;
  const pct = Math.round((feitos / steps.length) * 100);
  // O primeiro passo pendente é O próximo — ganha o botão em destaque; os demais
  // ficam discretos, pra deixar claro por onde continuar (fluxo, não lista solta).
  const proximoTodo = steps.findIndex((s) => !s.done);

  return (
    <section className="panel" aria-label={t('setup.rollout')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <p className="label">{t('setup.rollout')}</p>
        <span className="muted small">{completo ? 'completa ✓' : `passo ${feitos + 1} de ${steps.length}`}</span>
      </div>

      {/* Barra de progresso — o fio contínuo do fluxo. */}
      <div aria-hidden="true" style={{ height: 6, borderRadius: 999, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: 'var(--emerald)', transition: 'width .3s ease' }} />
      </div>

      {!completo && (
        <p className="muted small" style={{ marginTop: 2 }}>{t('setup.inOrder')}</p>
      )}

      {!completo && steps.map((s, i) => {
        const isNext = i === proximoTodo;
        return (
          <div className="checkrow" key={s.title} style={isNext ? { background: 'rgba(16,185,129,0.06)', borderRadius: 12, padding: '10px 12px' } : undefined}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flex: 1, flexWrap: 'wrap' }}>
              <span aria-hidden="true" style={{ opacity: s.done ? 1 : 0.35 }}>{s.done ? '✓' : isNext ? '→' : '○'}</span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <strong style={{ opacity: s.done ? 0.6 : 1 }}>{s.title}</strong>
                <p className="muted small" style={s.warn ? { color: 'var(--erro)' } : undefined}>{s.sub}</p>
              </div>
            </div>
            {!s.done && s.href && (
              <a className={isNext ? 'cta' : 'ghost'} style={isNext ? { textDecoration: 'none', padding: '8px 14px', fontSize: 13 } : { textDecoration: 'none' }} href={s.href}>
                {isNext ? 'resolver agora ↓' : 'resolver ↓'}
              </a>
            )}
          </div>
        );
      })}

      {/* O roteiro sobrevive ao D2: é o que mantém o garçom apresentando o QR. */}
      <details style={{ marginTop: completo ? 0 : 8 }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>
          {t('setup.script')}
        </summary>
        <div className="muted small" style={{ paddingTop: 8, display: 'grid', gap: 6 }}>
          <p>{t('setup.script1')}</p>
          <p>{t('setup.script2', { line: t('wiz.staffLine') })}</p>
          <p>{t('setup.script3')}</p>
          <p>
            🖨 <a href={`/qrs?v=${encodeURIComponent(venue.id)}`}>{t('setup.printLink')}</a>{' '}
            {t('setup.printNote')}
          </p>
        </div>
      </details>
    </section>
  );
}
