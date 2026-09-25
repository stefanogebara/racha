/**
 * A landing — raiz sem token de mesa.
 *
 * O SISTEMA PRESENCE, CLARO — e não mais invertido. A versão anterior punha
 * a página inteira em chão de tinta, lendo o `presence-trust-section` do
 * twin-me como regra da página. Não era: no twin-me aquilo é UMA faixa escura
 * arredondada dentro de uma página de papel. Aqui é a mesma coisa — o chão é
 * papel com a grade de 12 colunas em fio, e a única faixa escura é a da casa.
 *
 * O herói tem duas coisas, e o produto é a maior delas (.88fr contra 1.12fr).
 * A manchete é Manrope PURA: a troca de uma frase pra serifa itálica que havia
 * aqui é o padrão que a referência de ofício nomeia como assinatura de design
 * gerado — a serifa fica onde tem papel de verdade (a lede, o nome da casa, o
 * dinheiro). Os três passos saem do herói pra uma seção regrada; a equação
 * `R$ 237,10 ÷ 3` vira o razão de três pagamentos, que prova com dinheiro o
 * que a divisão provava com símbolo.
 *
 * Os entalhes seguem soltos em volta do telefone (escolha do dono), agora em
 * tinta sobre papel.
 */
import { useEffect, useRef, useState } from 'react';
import { LangToggle, useT } from './lang';
import { EMPRESA } from './empresa';
import { dishMask } from './dish';
import { money, LANDING_MARKET } from './i18n';
import { splitEqualLocal } from './split';

const DEMO = '/?t=demoracha';
// O idioma vai na URL: o iframe é outro documento e não escuta o seletor daqui.
// Sem isso a landing em inglês emoldurava um produto em português — a salada de
// idioma da decisão #35, bem no herói, que é o argumento de venda.
const embedSrc = (lang: string) => `${DEMO}&embed=1&lang=${lang}`;
const PROOF_TOTAL = 23710;   // a conta da demo, em centavos
/** A largura pra qual o produto é desenhado (o `.shell` do app). */
const LARGURA_DO_PRODUTO = 430;
const PROOF_PEOPLE = 3;


// "1 · Scanned" → "Scanned": o ordinal vem da espinha, não do texto.
const stripOrdinal = (s: string) => s.replace(/^\d+\s*·\s*/, '');

// A empresa da Racha (nome, CNPJ, cidade, contato) vem de `empresa.ts`. Do
// Decreto 7.962/2013 art. 2º o rodapé cumpre o inciso I e o canal eletrônico do
// II; o ENDEREÇO FÍSICO ainda falta (TASKS).

export default function Home() {
  const { t, lang } = useT();
  /**
   * O PAINEL É UMA JANELA, NÃO UMA FOTO — e por isso a altura parou de ser
   * medida.
   *
   * A versão anterior perguntava ao embed a altura do conteúdo e esticava a
   * moldura até ela, porque a moldura era um retrato que não se tocava: o que
   * ficasse de fora (o CPF e o "Pagar com Pix") simplesmente não existia pra
   * quem olhava. Agora o painel é o produto TOCÁVEL em ponteiro fino: tem
   * altura de janela, e o que não cabe se alcança rolando lá dentro, como num
   * telefone. Esticá-lo até 1.400px empurrava a manchete pro meio de um vazio
   * — medido no protótipo aprovado.
   *
   * Em toque (telefone), o iframe não recebe o dedo: um frame tocável engole a
   * rolagem da página. Lá o painel inteiro é um link que abre a demo cheia.
   */
  /**
   * A ESCALA SEGUE A LARGURA REAL DA MOLDURA.
   *
   * O produto é desenhado pra 430px (o `.shell`). A moldura antiga tinha 357px
   * fixos e uma escala escrita à mão (`357 / 430`); a nova é fluida — ~594px
   * no desktop, a coluna inteira no telefone. CSS não divide um comprimento
   * por outro, então quem calcula é o observador de tamanho.
   *
   * E A ALTURA TAMBÉM É MEDIDA, não suposta. A primeira versão supunha 600px
   * de janela, e a folha baixa pra 520 abaixo de 920px de largura: a janela do
   * PRÓPRIO iframe ficava ~98px mais alta do que o que se via, e o fim da
   * rolagem dele — onde mora o "Pagar com Pix" — caía atrás do
   * `overflow: hidden`, inalcançável. Medido a 390px, antes de chegar a
   * produção. Lida da caixa, a altura não tem como discordar da folha.
   */
  const janela = useRef<HTMLDivElement>(null);
  const [escala, setEscala] = useState(357 / LARGURA_DO_PRODUTO);
  const [alturaVisivel, setAlturaVisivel] = useState(600);
  useEffect(() => {
    const el = janela.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0) setEscala(width / LARGURA_DO_PRODUTO);
      if (height > 0) setAlturaVisivel(height);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const parts = Array.from({ length: PROOF_PEOPLE }, (_, i) => splitEqualLocal(PROOF_TOTAL, PROOF_PEOPLE, i)).sort((a, b) => a - b);
  const market = LANDING_MARKET[lang];
  const fmt = (c: number) => money(c, lang, market.currency);
  const steps = [
    [t('home.step1'), t('home.step1d')],
    [t('home.step2'), t('home.step2d')],
    [t('home.step3'), t(market.rail === 'bizum' ? 'home.bizumDirect' : 'home.pixDirect')],
  ];
  // A casa: a frase grande vira a manchete da faixa, o resto vira a lista.
  const claims = [t('land.house2'), t('land.house3'), t('land.house1'), t('land.house4')];
  /**
   * O RAZÃO. Os valores saem do `splitEqualLocal` — o mesmo rateio do maior
   * resto do produto —, e não digitados: é essa a garantia que a seção
   * afirma, e ela não pode ser afirmada por um número escrito à mão. Os nomes
   * e as horas são de exemplo (são do cliente, não se traduzem); o TRILHO vem
   * do mercado, então a mesa espanhola mostra Bizum e euro.
   */
  const RAIL = market.rail === 'bizum' ? 'Bizum' : 'Pix';
  const pagamentos = [['Ana', '21:47'], ['Bárbara', '21:48'], ['Caio', '21:51']]
    .map(([quem, hora], i) => ({ quem, hora, valor: parts[i] }));

  return (
    <main className="landing">
      {/* O chão de papel com a grade de 12 colunas em fio. A faixa da casa fica
          FORA dele: ela é um painel escuro pousado na página, não uma seção. */}
      <div className="chao">
        <header className="topo env">
          <a className="marca" href="/">racha</a>
          <nav>
            <a href={`/admin?lang=${lang}`}>{t('land.nav')}</a>
            <LangToggle compact />
          </nav>
        </header>

        <section className="heroi env">
          <div className="copy">
            <p className="kicker">{t('land.eyebrow')}</p>
            <h1>{t('land.h1a')}</h1>
            <p className="sub">{t('land.sub')}</p>
            <div className="acoes">
              <a className="pilula" href={`${DEMO}&lang=${lang}`}>{t('land.try')} <span aria-hidden="true">→</span></a>
              <a className="elo" href={`/admin?lang=${lang}`}>{t('land.forVenues')}</a>
            </div>
            {/* Quem chega aqui procurando a PRÓPRIA conta não tem o que fazer
                nesta página — a conta abre pelo QR da mesa (auditoria L8). */}
            <p className="namesa">{t('land.dinerHint')}</p>
            <p className="fatos">
              <span>{t('land.proof1')}</span>
              <span>{t('land.proof2')}</span>
            </p>
          </div>

          <div className="palco">
            {/* O iframe da demo tem ~8 paradas de Tab; quem navega por teclado
                pula direto pra explicação (auditoria L9). Só aparece no foco. */}
            <a className="pular" href="#passos">{t('land.skipDemo')}</a>
            {/* O produto de verdade. Em ponteiro fino, tocável ali mesmo — a
                legenda diz "toque nele", e agora ela é verdade. Em toque, a
                camada `.abrir` por cima leva pra demo cheia, porque um frame
                tocável no telefone engole a rolagem da página. */}
            <div className="tela" style={{ '--escala': escala } as React.CSSProperties}>
              <div className="tela-meta" aria-hidden="true">
                <span><i />{t('land.demoFrame')}</span>
              </div>
              {/* `key` força a remontagem quando o idioma muda: trocar o src de
                  um iframe já montado deixa o documento antigo na tela. */}
              <div className="tela-janela" ref={janela}>
                <iframe key={lang} title={t('land.demoFrame')} src={embedSrc(lang)} loading="eager"
                        style={{ height: `${Math.round(alturaVisivel / escala)}px` }} />
              </div>
              <a className="abrir" href={`${DEMO}&lang=${lang}`} aria-label={t('land.try')} />
            </div>
            {/* Os entalhes soltos em volta do telefone — a mesa em volta da
                conta. Escolha do dono: a ilustração é a marca, fica. */}
            <i className="flut espeto" style={dishMask('carne')} aria-hidden="true" />
            <i className="flut chopp" style={dishMask('cerveja')} aria-hidden="true" />
            <i className="flut tampa" style={dishMask('refrigerante')} aria-hidden="true" />
            <p className="dica">{t('land.tryHint')}</p>
          </div>
        </section>

        <section className="passos-secao env" id="passos" tabIndex={-1}>
          <p className="kicker">{t('land.stepsTitle')}</p>
          <ol className="passos">
            {steps.map(([title, desc], i) => (
              <li key={i}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <span className="tit">{stripOrdinal(title)}</span>
                <span className="desc">{desc}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="prova env">
          <p className="kicker">{t('land.proofTitle')}</p>
          <table className="razao">
            <thead>
              <tr>
                <th scope="col">{t('land.lPayer')}</th>
                <th scope="col">{t('land.lTime')}</th>
                <th scope="col" className="como">{t('land.lHow')}</th>
                <th scope="col">{t('land.lAmount')}</th>
              </tr>
            </thead>
            <tbody>
              {pagamentos.map((p) => (
                <tr key={p.quem}>
                  <td className="quem">{p.quem}</td>
                  <td>{p.hora}</td>
                  <td className="como"><span className="pago"><i />{t('land.lConfirmed', { rail: RAIL })}</span></td>
                  <td className="valor">{fmt(p.valor)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {/* O ESTADO da mesa, que é texto nosso e traduz — não o número
                    dela, que é palavra do restaurante e não traduz. Pôr "Mesa 1"
                    aqui obrigava a escrever conteúdo da casa como literal. */}
                {/* Duas colunas + a do "Como" VAZIA, e não `colSpan={3}`: no
                    telefone a coluna "Como" some, e um rodapé que a contava
                    empurrava o total uma coluna pra fora (auditoria L6). */}
                <td className="quem" colSpan={2}>{t('land.lClosed')}</td>
                <td className="como" aria-hidden="true" />
                <td className="valor">{fmt(PROOF_TOTAL)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="cap">{t('land.proofCap')}</p>
        </section>
      </div>

      <section className="casa" id="casa">
        <p className="kicker">{t('land.venueTitle')}</p>
        <h2>{t('land.house0')}</h2>
        <ul className="itens">
          {claims.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
        <a className="pilula" href={`/admin?lang=${lang}`}>{t('land.openPanel')} <span aria-hidden="true">→</span></a>
      </section>

      <footer className="rodape env">
        <span>{t('app.tagline')}</span>
        <nav>
          <a href={`${DEMO}&lang=${lang}`}>{t('land.try')}</a>
          <a href={`/admin?lang=${lang}`}>{t('land.nav')}</a>
        </nav>
        {/* Pelo formatador, não à mão. A versão manual daqui era a ÚNICA
            formatada no produto inteiro — o comprovante e o aviso, que são o
            que o cliente lê, imprimiam catorze dígitos crus. */}
        <span className="legal">Racha · {EMPRESA.razaoSocial} · CNPJ {EMPRESA.cnpj} · {EMPRESA.cidade} · <a href={`mailto:${EMPRESA.contato}`}>{EMPRESA.contato}</a></span>
      </footer>
    </main>
  );
}
