/**
 * A casca React do idioma: contexto, hook e o seletor.
 *
 * O dicionário e a formatação vivem em `./i18n` — puros, sem React, e testados
 * lá. O nome é outro de propósito: com os dois chamados `i18n`, o resolvedor
 * escolhe o `.ts` e some com os componentes sem dizer por quê. Quem importa
 * `./lang` quer React; quem importa `./i18n` quer as strings.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DICT, LANGS, STORAGE_KEY, asLang, fill, type Key, type Lang, money, LOCALE, type CurrencyCode } from './i18n';

export { DICT, LANGS, money, tError } from './i18n';
export type { Key, Lang } from './i18n';

/* ── contexto ─────────────────────────────────────────────────────────────── */

/**
 * O idioma inicial, e se ele foi ESCOLHIDO por alguém.
 *
 * A distinção importa: só um idioma que ninguém escolheu pode ser trocado pelo
 * padrão da CASA quando a conta chega. Escolha de gente sempre ganha — um
 * turista que pôs EN em Barcelona não quer PT porque jantou em São Paulo.
 */
function readStored(): { lang: Lang; escolhido: boolean } {
  // `?lang=` wins over the stored choice. It exists for one real case: the
  // landing embeds the product in an iframe, and an iframe is its own document
  // — it reads storage once at mount and never hears the parent's toggle. The
  // hero was an English page wrapped around a Portuguese product.
  //
  // It is not a second source of truth: nothing writes it, and the visible app
  // still stores and reads the person's own choice.
  try {
    const url = asLang(new URLSearchParams(window.location.search).get('lang'));
    if (url) return { lang: url, escolhido: true };
  } catch { /* sem window (teste) → segue pro armazenado */ }
  try {
    const stored = asLang(localStorage.getItem(STORAGE_KEY));
    if (stored) return { lang: stored, escolhido: true };
  } catch { /* storage bloqueado → fica no padrão */ }
  return { lang: 'en', escolhido: false };   // padrão do produto, não escolha
}

/** O atributo `lang` do documento e dos botões, pro leitor de tela pronunciar
 *  certo. Declarado antes de quem o usa. */
const HTML_LANG: Record<Lang, string> = { en: 'en', pt: 'pt-BR', es: 'es-ES' };

const LangContext = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
  adotarPadraoDaCasa: (l: Lang | null | undefined) => void;
}>({
  lang: 'en', setLang: () => {}, adotarPadraoDaCasa: () => {},
});

export function LangProvider({ children }: { children: React.ReactNode }) {
  const inicial = useMemo(readStored, []);
  const [lang, setLangState] = useState<Lang>(inicial.lang);
  const [escolhido, setEscolhido] = useState<boolean>(inicial.escolhido);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    setEscolhido(true);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* segue sem lembrar */ }
  }, []);
  /**
   * O PADRÃO DA CASA, quando ninguém escolheu nada.
   *
   * O servidor manda `venue.defaultLang` em toda conta — e o cliente declarava
   * o TIPO do campo e nunca o lia. Efeito medido em 2026-09-10: um cliente
   * brasileiro, num restaurante brasileiro, no primeiro QR da vida, recebia a
   * conta em INGLÊS, com `R$213.10` de ponto decimal, enquanto a casa dizia
   * `pt`. Campo calculado, enviado e morto — a mesma forma do `offRail`.
   *
   * NÃO sobrescreve escolha: só age quando o idioma atual é o padrão do
   * produto, e o que ele faz também não vira escolha (não grava no storage),
   * senão a casa seguinte herdaria o idioma desta.
   */
  const adotarPadraoDaCasa = useCallback((l: Lang | null | undefined) => {
    if (!l || escolhido) return;
    setLangState((atual) => (atual === l ? atual : l));
  }, [escolhido]);
  // O `lang` do documento e o TÍTULO seguem a escolha juntos, num só efeito:
  // são as duas coisas que vivem fora do React e por isso são as duas que
  // ficam pra trás. O título vinha fixo em inglês do `index.html`.
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[lang];
    document.title = DICT['doc.title'][lang];
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang, adotarPadraoDaCasa }), [lang, setLang, adotarPadraoDaCasa]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang() { return useContext(LangContext); }

export function useT() {
  const { lang, setLang, adotarPadraoDaCasa } = useLang();
  const t = useCallback(
    (key: Key, vars?: Record<string, string | number>) => fill(DICT[key][lang], vars),
    [lang],
  );
  // Money and dates come from the same hook as the words, because they are the
  // same decision (#34): the currency never changes — BRL in both languages,
  // switching language does not convert money — but the SEPARATION follows the
  // reader. "R$ 1.234,56" read by an English speaker is worth a thousand times
  // what it is. Same for "06/12/2026", which is two different days.
  //
  // They live here rather than as free functions so a screen cannot forget the
  // language: there is nothing to pass. Only App.tsx was doing this correctly;
  // the wallet, the panel and the house-balance flow printed pt-BR to everyone.
  // `brl` é o nome histórico (sessenta call sites) e continua significando
  // "dinheiro pra tela". O que mudou com a Espanha é que a MOEDA passou a vir
  // de fora: a casa decide se a conta é em real ou em euro, o leitor decide a
  // separação. O default BRL mantém as telas brasileiras iguais.
  const brl = useCallback(
    (cents: number, currency: CurrencyCode = 'BRL') => money(cents, lang, currency),
    [lang],
  );
  const dmy = useCallback(
    (iso: string) => new Date(iso).toLocaleDateString(LOCALE[lang]),
    [lang],
  );
  // Hora e porcentagem entram aqui pelo MESMO motivo que o dinheiro e a data:
  // eram os dois números que ainda saíam com `'pt-BR'` escrito na linha, e
  // ninguém nota porque o resultado *parece* certo. "14:30" está certo em
  // espanhol e errado em inglês ("2:30 PM"); "1,5" é um número e meio em
  // Madrid e mil e quinhentos em Nova York. Um bônus de "1,5%" lido como
  // "1500%" é uma promessa que a casa não fez.
  const hm = useCallback(
    (iso: string) => new Date(iso).toLocaleTimeString(LOCALE[lang], { hour: '2-digit', minute: '2-digit' }),
    [lang],
  );
  const pct = useCallback(
    (bp: number) => (bp / 100).toLocaleString(LOCALE[lang]),
    [lang],
  );
  return { t, lang, setLang, adotarPadraoDaCasa, brl, dmy, hm, pct };
}

/**
 * O seletor. Botões, não um menu: com três opções, um `select` esconde duas
 * terças da resposta atrás de um toque. Fica no rodapé em toda tela da
 * plataforma — perto do fim, longe do botão de pagar.
 */
export function LangToggle({ compact = false }: { compact?: boolean }) {
  const { lang, setLang } = useLang();
  return (
    <div className="langtoggle" role="group" aria-label={DICT['lang.label'][lang]}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          className={l === lang ? 'langopt on' : 'langopt'}
          aria-pressed={l === lang}
          lang={HTML_LANG[l]}
          onClick={() => setLang(l)}
        >
          {compact ? l.toUpperCase() : DICT[`lang.${l}` as Key][lang]}
        </button>
      ))}
    </div>
  );
}
