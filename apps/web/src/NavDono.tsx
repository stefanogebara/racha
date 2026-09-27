import { useT } from './lang';

/**
 * As três telas do dono, ligadas entre si.
 *
 * Painel (/painel), mesas (/admin) e folha de QRs (/qrs) eram três endereços
 * soltos: do painel só se saía por "sair", e quem abria o painel no meio do
 * serviço não tinha como voltar às mesas sem digitar a URL (auditoria e2e,
 * 27/09/2026). Links comuns, não estado: cada tela continua sendo um endereço
 * que dá pra favoritar no tablet do caixa.
 */
type Aqui = 'painel' | 'mesas' | 'qrs';

export function NavDono({ venueId, aqui }: { venueId: string; aqui: Aqui }) {
  const { t } = useT();
  const v = encodeURIComponent(venueId);
  const itens: { id: Aqui; href: string; rotulo: string }[] = [
    { id: 'painel', href: `/painel?v=${v}`, rotulo: t('nav.panel') },
    { id: 'mesas', href: `/admin?v=${v}`, rotulo: t('nav.tables') },
    { id: 'qrs', href: `/qrs?v=${v}`, rotulo: t('nav.qrs') },
  ];
  return (
    <nav className="navdono noprint" aria-label={t('nav.label')}>
      {itens.map((i) => (
        <a key={i.id} href={i.href} aria-current={i.id === aqui ? 'page' : undefined}
          className={i.id === aqui ? 'on' : undefined}>
          {i.rotulo}
        </a>
      ))}
    </nav>
  );
}
