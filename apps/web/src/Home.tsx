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
import { useT } from './lang';

const DEMO_MESA = '/?t=demoracha';

export default function Home() {
  const { t } = useT();
  return (
    <main className="shell">
      <header className="head">
        <span className="venue">racha</span>
        <span className="mesa">pagamento na mesa</span>
      </header>

      <section className="card">
        <p className="label">{t('home.forVenues')}</p>
        <h1 style={{ margin: '4px 0 8px', fontSize: 28, lineHeight: 1.15 }}>
          A conta da mesa, resolvida no Pix.
        </h1>
        <p className="muted">
          O cliente escaneia o QR, divide como quiser e paga em segundos —
          sem app, sem cadastro, sem esperar a maquininha. Cartão via
          Google&nbsp;Pay e saldo pré-pago com bônus, no mesmo QR.
        </p>
        <a className="cta" style={{ textAlign: 'center', textDecoration: 'none' }} href={DEMO_MESA}>
          Ver a demonstração ao vivo
        </a>
        <a className="ghost" style={{ textAlign: 'center', textDecoration: 'none' }} href="/admin">
          Sou restaurante — entrar no painel
        </a>
      </section>

      <section className="card">
        <p className="label">{t('home.how')}</p>
        <div className="checkrow">
          <span>1 · Escaneou</span>
          <span className="muted small">o QR da mesa abre a conta na hora</span>
        </div>
        <div className="checkrow">
          <span>2 · Dividiu</span>
          <span className="muted small">igual ou por valor — cada um a sua parte</span>
        </div>
        <div className="checkrow">
          <span>3 · Pagou</span>
          <span className="muted small">{t('home.pixDirect')}</span>
        </div>
        <p className="muted small">
          Serviço da equipe (gorjeta) rastreado separado, do jeito que a lei
          pede. A mesa gira mais rápido no rush — e ninguém fica esperando
          maquininha passar de mão em mão.
        </p>
      </section>

      <section className="card">
        <p className="label">{t('home.houseBalance')}</p>
        <p className="muted">
          Seu cliente carrega saldo via Pix e ganha bônus (ex.: +15%).
          Fidelidade que vira caixa antecipado — o saldo pago não expira e é
          reembolsável; o bônus é promocional, com validade clara.
        </p>
      </section>

      <footer className="foot" style={{ flexDirection: 'column', gap: 4, textAlign: 'center' }}>
        <span>racha · sem app, sem cadastro</span>
        <span>
          Racha — 65.087.663 Stefano Chap Chap Gebara · CNPJ 65.087.663/0001-30 · São Paulo, SP
        </span>
      </footer>
    </main>
  );
}
