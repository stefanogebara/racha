import React from 'react';
import { DICT, type Lang } from './i18n';

/**
 * A REDE DE SEGURANÇA DO RENDER — a conta não pode virar tela branca.
 *
 * Sem ela, um `throw` durante o render desmonta a raiz inteira e sobra uma
 * página em branco. Não era alcançável enquanto tudo vivia no chunk de entrada;
 * passou a ser quando os trilhos da Stripe viraram `lazy`, e por dois caminhos
 * corriqueiros, nenhum deles adversário:
 *
 *  - o 4G do bar oscila na hora de buscar o chunk. O `App` já se defende
 *    disso no poll ("um blip de sinal NÃO pode apagar a tela"), e o import
 *    dinâmico não tinha defesa nenhuma — falhava mais forte que a coisa contra
 *    a qual aquele comentário protege;
 *  - um deploy enquanto a mesa está com a conta aberta: o Vite emite chunks com
 *    hash no nome, o hash antigo some, e a aba aberta recebe "Failed to fetch
 *    dynamically imported module". Um jantar dura mais que o intervalo entre
 *    dois deploys.
 *
 * Recarregar é seguro AQUI e em nenhum lugar por acaso: o estado do pagamento é
 * event-sourced no servidor (inegociável #6), então a tela é derivada e nada se
 * perde ao remontar. Achado pela revisão de segurança de 2026-09-10.
 */
type Props = { lang: Lang; children: React.ReactNode };
type State = { caiu: boolean };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { caiu: false };

  static getDerivedStateFromError(): State {
    return { caiu: true };
  }

  componentDidCatch(erro: unknown) {
    // Sem telemetria de terceiro: o console basta, e mandar o erro pra fora
    // seria acrescentar um destinatário na tela de pagamento (inegociável #10).
    // eslint-disable-next-line no-console
    console.error('[racha] render caiu', erro);
  }

  render() {
    if (!this.state.caiu) return this.props.children;
    const t = (k: 'boundary.title' | 'boundary.body' | 'boundary.retry') => DICT[k][this.props.lang];
    return (
      <main className="shell">
        <section className="card">
          <p className="label">{t('boundary.title')}</p>
          <p className="muted small">{t('boundary.body')}</p>
          <button className="cta" onClick={() => window.location.reload()}>{t('boundary.retry')}</button>
        </section>
      </main>
    );
  }
}
