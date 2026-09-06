import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import Panel from './Panel';
import Admin from './Admin';
import Gate from './Gate';
import Qrs from './Qrs';
import Wallet from './Wallet';
import { LangProvider } from './lang';
import './styles.css';

const path = window.location.pathname;
// Diner flows (conta, carteira) are public; owner surfaces (/admin, /painel) sit behind the login gate.
const root =
  path.startsWith('/painel') ? <Gate><Panel /></Gate>
  : path.startsWith('/admin') ? <Gate><Admin /></Gate>
  : path.startsWith('/qrs') ? <Gate><Qrs /></Gate>
  : path.startsWith('/carteira') ? <Wallet />
  : <App />;

ReactDOM.createRoot(document.getElementById('root')!).render(
  // O idioma envolve TUDO: cliente, painel e admin leem a mesma escolha.
  <React.StrictMode><LangProvider>{root}</LangProvider></React.StrictMode>,
);
