import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import Panel from './Panel';
import Admin from './Admin';
import './styles.css';

const path = window.location.pathname;
const Root = path.startsWith('/painel') ? Panel : path.startsWith('/admin') ? Admin : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
