/**
 * A landing — raiz sem token de mesa.
 *
 * Uma composição, um trilho. Grade de 12: títulos nas colunas 1–4, conteúdo
 * nas 5–12, em toda seção. O herói é uma linha só: manchete à esquerda, o
 * produto AO VIVO à direita — numa moldura de tela, não num telefone de
 * mentira (o cliente usa o navegador; não tem app). A prova (a conta da demo
 * dividida por três, ao centavo) é a peça central, em seção própria, largura
 * toda: três partes em três colunas iguais, a legenda presa à parte de ouro.
 * Serif itálica só na manchete e nos numerais; UM acento na página. Os
 * entalhes: nas linhas da conta E soltos em volta do telefone (escolha do dono).
 */
import { LangToggle, useT } from './lang';
import { dishMask } from './dish';
import { money } from './i18n';
import { splitEqualLocal } from './split';

const DEMO = '/?t=demoracha';
const EMBED = `${DEMO}&embed=1`; // o mesmo produto, mostrado como um estado
const PROOF_TOTAL = 23710;   // a conta da demo, em centavos
const PROOF_PEOPLE = 3;

// "1 · Scanned" → "Scanned": o ordinal vem da espinha, não do texto.
const stripOrdinal = (s: string) => s.replace(/^\d+\s*·\s*/, '');

export default function Home() {
  const { t, lang } = useT();
  const parts = Array.from({ length: PROOF_PEOPLE }, (_, i) => splitEqualLocal(PROOF_TOTAL, PROOF_PEOPLE, i)).sort((a, b) => a - b);
  const fmt = (c: number) => money(c, lang);
  const steps = [
    [t('home.step1'), t('home.step1d')],
    [t('home.step2'), t('home.step2d')],
    [t('home.step3'), t('home.pixDirect')],
  ];
  const claims = [t('land.house0'), t('land.house2'), t('land.house3'), t('land.house1'), t('land.house4')];

  return (
    <main className="landing">
      <header className="topo env">
        <a className="marca" href="/">racha</a>
        <nav>
          <a href="/admin">{t('land.nav')}</a>
          <LangToggle compact />
        </nav>
      </header>

      <section className="heroi env">
        <div className="copy">
          <p className="eyebrow">{t('land.eyebrow')}</p>
          <h1>
            <span>{t('land.h1a')}</span>
            <em>{t('land.h1b')}</em>
          </h1>
          <p className="sub">{t('land.sub')}</p>
          <div className="acoes">
            <a className="btn" href={DEMO}>{t('land.try')}</a>
            <a className="btn fantasma" href="/admin">{t('land.forVenues')}</a>
          </div>
          {/* Os três gestos vivem ao lado do produto que os mostra. */}
          <ol className="passos">
            {steps.map(([title, desc], i) => (
              <li key={i}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <span className="tit">{stripOrdinal(title)}</span>
                <span className="desc">{desc}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* O produto de verdade, rodando, INTEIRO — da conta ao botão de pagar.
            Moldura de fio, sem bisel, sem 9:41: é uma página web, e isso é o
            argumento. Passa da dobra de propósito; quem rola vê o resto. */}
        <div className="palco">
          <a className="tela" href={DEMO} aria-label="Racha — demo ao vivo">
            <iframe title="Racha — demo ao vivo" src={EMBED} loading="eager" tabIndex={-1} />
          </a>
          {/* Os entalhes soltos em volta do telefone — a mesa em volta da conta.
              Escolha do dono (decisão #36): a ilustração é a marca, fica. */}
          <i className="flut espeto" style={dishMask('carne')} aria-hidden="true" />
          <i className="flut chopp" style={dishMask('cerveja')} aria-hidden="true" />
          <i className="flut tampa" style={dishMask('refrigerante')} aria-hidden="true" />
          <p className="dica">{t('land.tryHint')}</p>
        </div>
      </section>

      <section className="prova env">
        <p className="eyebrow">{t('land.proofTitle')}</p>
        <p className="eq">
          <span className="n">{fmt(PROOF_TOTAL)}</span>
          <span className="op" aria-label="÷"><i /><b /><i /></span>
          <span className="n">{PROOF_PEOPLE}</span>
          <span className="op igual" aria-label="="><b /><b /></span>
        </p>
        {/* Três colunas da grade (1, 5, 9): a parte de ouro cai na coluna onde a
            tela do herói começa. A legenda é uma linha inteira, não um sussurro. */}
        <ol className="partes">
          {parts.map((c, i) => (
            <li key={i} className={c !== parts[0] ? 'acento' : undefined}><span className="n">{fmt(c)}</span></li>
          ))}
        </ol>
        <p className="cap">{t('land.proofCap')}</p>
      </section>

      {/* Para a casa: prosa, não outra lista numerada. Cinco frases, uma voz. */}
      <section className="secao env grade casa">
        <h2 className="h2">{t('land.venueTitle')}</h2>
        <div>
          <div className="manifesto">
            {claims.map((c, i) => <p key={i}>{c}</p>)}
          </div>
          <a className="link" href="/admin">{t('land.openPanel')} <span aria-hidden="true">→</span></a>
        </div>
      </section>

      <footer className="rodape env">
        <hr />
        <span>{t('app.tagline')}</span>
        <nav>
          <a href={DEMO}>{t('land.try')}</a>
          <a href="/admin">{t('land.nav')}</a>
        </nav>
        <span className="legal">Racha · CNPJ 65.087.663/0001-30 · São Paulo, SP</span>
      </footer>
    </main>
  );
}
