import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import Panel from './Panel';
import Admin from './Admin';
import Gate from './Gate';
import './styles.css';

const path = window.location.pathname;
// Diner conta flow is public; owner surfaces (/admin, /painel) sit behind the login gate.
const root =
  path.startsWith('/painel') ? <Gate><Panel /></Gate>
  : path.startsWith('/admin') ? <Gate><Admin /></Gate>
  : <App />;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
