/**
 * A casca React do idioma: contexto, hook e o seletor.
 *
 * O dicionário e a formatação vivem em `./i18n` — puros, sem React, e testados
 * lá. O nome é outro de propósito: com os dois chamados `i18n`, o resolvedor
 * escolhe o `.ts` e some com os componentes sem dizer por quê. Quem importa
 * `./lang` quer React; quem importa `./i18n` quer as strings.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DICT, LANGS, STORAGE_KEY, asLang, fill, tError, type Key, type Lang, money, LOCALE, type CurrencyCode } from './i18n';

export { DICT, LANGS, money } from './i18n';
export { tError } from './i18n';
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
  // Outside the iframe it is also stored (see below): a link that says
  // `?lang=pt` is the person's choice, and the panel's own navigation drops
  // the query string.
  try {
    const params = new URLSearchParams(window.location.search);
    const url = asLang(params.get('lang'));
    if (url) {
      // FORA do iframe, o `?lang=` é escolha de verdade — e é GRAVADO. Sem
      // isso, o dono que chegava da landing em português (`/admin?lang=pt`)
      // voltava ao inglês na primeira navegação do painel, que troca a query
      // inteira (`?v=<casa>`). Dentro do iframe da landing (`embed=1`) não:
      // lá o idioma é o da moldura, não uma escolha da pessoa.
      if (params.get('embed') !== '1') {
        try { localStorage.setItem(STORAGE_KEY, url); } catch { /* storage bloqueado */ }
      }
      return { lang: url, escolhido: true };
    }
  } catch { /* sem window (teste) → segue pro armazenado */ }
  try {
    const stored = asLang(localStorage.getItem(STORAGE_KEY));
    if (stored) return { lang: stored, escolhido: true };
  } catch { /* storage bloqueado → fica no padrão */ }
  // O IDIOMA DO NAVEGADOR, quando ninguém escolheu nada (auditoria do portão,
  // P7): o dono brasileiro que digitava `useracha.app/admin` caía num login em
  // inglês. Não é ESCOLHA (`escolhido: false`): o padrão da casa, quando a conta
  // chega, ainda vale por cima. Inglês segue sendo o padrão pra qualquer outro.
  try {
    for (const l of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])) {
      const base = asLang(String(l || '').slice(0, 2).toLowerCase());
      if (base) return { lang: base, escolhido: false };
    }
  } catch { /* sem navigator (teste) */ }
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
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    escolhidoRef.current = true;
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* segue sem lembrar */ }
    // O `?lang=` da URL vence o armazenado ao recarregar — então a escolha pelo
    // seletor o TIRA da barra, senão recarregar desfazia a escolha (auditoria da
    // landing, L13). No iframe da landing não: lá o idioma é o da moldura.
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.has('lang') && u.searchParams.get('embed') !== '1') {
        u.searchParams.delete('lang');
        window.history.replaceState(window.history.state, '', u.pathname + (u.search ? u.search : '') + u.hash);
      }
    } catch { /* sem window (teste) */ }
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
  /**
   * `asLang` na TERCEIRA porta, e a escolha lida por REF.
   *
   * Duas coisas que a primeira versão errou:
   *
   *  - o tipo `Lang` é apagado em runtime e o valor vem do corpo JSON do
   *    servidor. O teste "nada além de um idioma atendido entra" enumera as
   *    portas de fora (`?lang=` e localStorage) e esta era uma terceira, sem
   *    validação. Hoje o servidor só emite `pt`/`es`; no dia em que emitir
   *    outra coisa, `DICT[key][lang]` vira `undefined` e o `fill` estoura
   *    DURANTE o render da tela de pagamento.
   *  - `escolhido` lido do closure: o poll em voo no momento do toque carrega
   *    `escolhido: false`, e quando ele resolve reverte o idioma que a pessoa
   *    acabou de escolher. Janela de 1–2s no 4G de um bar. Um `ref` é um
   *    guarda só, vivo, em vez de um por render.
   */
  const escolhidoRef = useRef(inicial.escolhido);
  const adotarPadraoDaCasa = useCallback((l: Lang | null | undefined) => {
    const escolha = asLang(l);
    if (!escolha || escolhidoRef.current) return;
    setLangState((atual) => (atual === escolha ? atual : escolha));
  }, []);
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
  /**
   * O erro do servidor virando frase, num lugar só.
   *
   * Vinte e uma telas faziam `setError((e as Error).message)` — o texto CRU do
   * servidor. Funcionava enquanto o servidor mandava frase; ele parou de
   * mandar (a frase interna nomeava o adquirente da casa e servia de oráculo
   * de assinatura em webhook), então o cru virou o "HTTP 400" que o `api.ts`
   * inventa. Pior que uma frase honesta em pé.
   *
   * Aqui é o mesmo contrato do `App`: código → tradução, `vars` em centavos →
   * formatados na moeda de quem lê. Fica no `useT` porque é onde se sabe o
   * idioma — uma tela não tem como esquecer o que não precisa passar.
   */
  const tErr = useCallback((e: unknown, currency: CurrencyCode = 'BRL') => {
    const err = e as { code?: string; message?: string; vars?: Record<string, string | number> };
    const vars = err?.vars ? {
      left: money(Number(err.vars.leftCents ?? 0), lang, currency),
      min: money(Number(err.vars.minCents ?? 0), lang, currency),
      max: money(Number(err.vars.maxCents ?? 0), lang, currency),
      // `limit` e `windowMinutes` NÃO são dinheiro — são contagem e
      // minutos. Faltavam aqui, e o resultado era o teto de cobranças
      // chegando com `{limit}` e `{windowMinutes}` LITERAIS na tela, que é
      // a mesma regressão que o comentário acima já registra pro `{max}`.
      // Um censo de marcadores agora impede a terceira. Achado pela
      // revisão de compliance de 2026-09-15 (HIGH-3).
      limit: String(err.vars.limit ?? ''),
      windowMinutes: String(err.vars.windowMinutes ?? ''),
      // `maxChars` é CONTAGEM DE CARACTERES, não dinheiro — e `max` já está
      // tomado pelo `money(maxCents)` logo acima. Serve as recusas das palavras
      // da casa (nome, rótulo de mesa, cidade).
      maxChars: String(err.vars.maxChars ?? ''),
    } : undefined;
    return tError(lang, err?.code, err?.message || '', vars);
  }, [lang]);
  return { t, lang, setLang, adotarPadraoDaCasa, brl, dmy, hm, pct, tErr };
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
