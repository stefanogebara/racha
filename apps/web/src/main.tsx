import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LangProvider, useT } from './lang';
import ErrorBoundary from './ErrorBoundary';
import './styles.css';

/**
 * AS TELAS DO DONO SAEM DO PACOTE DO CLIENTE.
 *
 * `Gate` importa `./auth`, que no corpo do módulo faz `createClient(...)` contra
 * o Supabase do SEATABLE, com `persistSession` e `autoRefreshToken`. Com import
 * estático isso ia no chunk de ENTRADA — o que todo cliente baixa ao ler o QR
 * de uma mesa. Medido no build: 543 KB crus / 158 KB gzip contendo
 * `ckforlwdhewexyqljsaf`, `onAuthStateChange` e `refresh_token`, numa página
 * pública, sem login, alcançada por um QR que circula em foto e link.
 *
 * E em qualquer navegador que já tenha entrado no painel, o cliente de auth
 * encontra a sessão guardada e a RENOVA a partir da tela da conta — chamada à
 * infraestrutura de outro produto, disparada por quem só queria dividir uma
 * conta. Inegociável #10.
 *
 * É a mesma classe do defeito da Stripe: import estático com efeito colateral
 * no corpo do módulo. Achado pela revisão de segurança de 2026-09-10.
 */
const Panel = lazy(() => import('./Panel'));
const Admin = lazy(() => import('./Admin'));
const Qrs = lazy(() => import('./Qrs'));
const Wallet = lazy(() => import('./Wallet'));
const Gate = lazy(() => import('./Gate'));

const path = window.location.pathname;
// Diner flows (conta, carteira) are public; owner surfaces (/admin, /painel) sit behind the login gate.
const root =
  path.startsWith('/painel') ? <Gate><Panel /></Gate>
  : path.startsWith('/admin') ? <Gate><Admin /></Gate>
  : path.startsWith('/qrs') ? <Gate><Qrs /></Gate>
  : path.startsWith('/carteira') ? <Wallet />
  : <App />;

/** O contorno de carregamento das telas do dono, com o idioma já escolhido. */
function Carregando() {
  const { t } = useT();
  return <main className="shell"><p className="muted center">{t('admin.loading')}</p></main>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  // O idioma envolve TUDO: cliente, painel e admin leem a mesma escolha.
  <React.StrictMode>
    <LangProvider>
      <Raiz>{root}</Raiz>
    </LangProvider>
  </React.StrictMode>,
);

/** O limite de erro precisa do idioma, e o idioma vem do provider acima. */
function Raiz({ children }: { children: React.ReactNode }) {
  const { lang } = useT();
  return (
    <ErrorBoundary lang={lang}>
      <Suspense fallback={<Carregando />}>{children}</Suspense>
    </ErrorBoundary>
  );
}
