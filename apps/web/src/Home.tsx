/**
 * Raiz sem token de mesa = primeira impressão (desktop, prospect, investidor,
 * revisor de KYC clicando o "site do recebedor"). Antes era uma linha morta
 * ("Escaneie o QR…"); agora é uma mini-landing com demo ao vivo.
 *
 * Decisão de produto (não mudar sem re-decidir): DINER NÃO TEM LOGIN — "sem
 * app, sem cadastro" é o wedge (pesquisa sunday/inKind: fricção no checkout
 * mata a adoção na mesa). Login existe onde ganha o lugar: dono (/admin) e,
 * no saldo da casa, identidade progressiva por telefone (OTP de recuperação
 * é o v2 anotado em docs/house-accounts).
 */
import { LangToggle, useT } from './lang';

const DEMO_MESA = '/?t=demoracha';

export default function Home() {
  const { t } = useT();
  return (
    <main className="shell">
      <header className="head">
        <span className="venue">racha</span>
        <span className="mesa">{t('home.tagline')}</span>
      </header>

      <section className="card">
        <p className="label">{t('home.forVenues')}</p>
        <h1 style={{ margin: '4px 0 8px', fontSize: 28, lineHeight: 1.15 }}>
          {t('home.h1')}
        </h1>
        <p className="muted">
          {t('home.lede')}
        </p>
        <a className="cta" style={{ textAlign: 'center', textDecoration: 'none' }} href={DEMO_MESA}>
          {t('home.demo')}
        </a>
        <a className="ghost" style={{ textAlign: 'center', textDecoration: 'none' }} href="/admin">
          {t('home.iAmVenue')}
        </a>
      </section>

      <section className="card">
        <p className="label">{t('home.how')}</p>
        <div className="checkrow">
          <span>{t('home.step1')}</span>
          <span className="muted small">{t('home.step1d')}</span>
        </div>
        <div className="checkrow">
          <span>{t('home.step2')}</span>
          <span className="muted small">{t('home.step2d')}</span>
        </div>
        <div className="checkrow">
          <span>{t('home.step3')}</span>
          <span className="muted small">{t('home.pixDirect')}</span>
        </div>
        <p className="muted small">
          {t('home.legal')}
        </p>
      </section>

      <section className="card">
        <p className="label">{t('home.houseBalance')}</p>
        <p className="muted">
          {t('home.balancePitch')}
        </p>
      </section>

      <footer className="foot" style={{ flexDirection: 'column', gap: 6, textAlign: 'center' }}>
        <LangToggle compact />
        <span>{t('app.tagline')}</span>
        <span>
          Racha — 65.087.663 Stefano Chap Chap Gebara · CNPJ 65.087.663/0001-30 · São Paulo, SP
        </span>
      </footer>
    </main>
  );
}
