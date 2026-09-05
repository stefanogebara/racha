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
      {/* O herói da landing: marca em serif itálico, uma frase, uma ação. */}
      <header className="hero">
        <span className="marca">racha</span>
        <h1>{t('home.h1')}</h1>
        <p className="sub">{t('home.lede')}</p>
        <div className="acoes">
          <a className="cta" href={DEMO_MESA}>{t('home.demo')}</a>
          <a className="ghost" href="/admin">{t('home.iAmVenue')}</a>
        </div>
      </header>

      <section className="card">
        <div className="t-secao"><h2>{t('home.how')}</h2></div>
        <div className="passo">
          <b>{t('home.step1')}</b>
          <span>{t('home.step1d')}</span>
        </div>
        <div className="passo">
          <b>{t('home.step2')}</b>
          <span>{t('home.step2d')}</span>
        </div>
        <div className="passo">
          <b>{t('home.step3')}</b>
          <span>{t('home.pixDirect')}</span>
        </div>
        <p className="muted small">
          {t('home.legal')}
        </p>
      </section>

      <section className="card">
        <div className="t-secao"><h2>{t('home.houseBalance')}</h2></div>
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
