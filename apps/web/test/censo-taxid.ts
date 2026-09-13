/**
 * O CENSO DO DOCUMENTO DA CASA, como módulo.
 *
 * Mora fora do arquivo de teste porque a revisão precisa poder IMPORTÁ-LO pra
 * mutar — quando ele vivia dentro do `taxid.test.ts`, importar a função
 * rodava a suíte inteira. Uma regra que só dá pra exercitar rodando o teste
 * que a usa não dá pra atacar de fora, e atacar de fora é como as oito fugas
 * apareceram.
 *
 * Histórico, porque cada versão errou de um jeito instrutivo:
 *
 *  v1 — `!/\w+=\{/` de LINHA: qualquer `style={{…}}` na linha desligava a
 *       regra. Sete fugas, todas provadas por mutação pela revisão.
 *  v2 — dispensas POSICIONAIS (recorta-se o vão do atributo antes de olhar o
 *       resto) e `i18n.ts` deixou de ser pulado. Pra deixá-lo entrar eu
 *       mascarei os literais de string — e com isso apaguei o
 *       `` {`CNPJ ${taxId}`} ``, que é a única forma de literal que IMPRIME.
 *       O conserto de uma fuga abriu a oitava. Mais três junto: atributo de
 *       EXIBIÇÃO (`value=`, `title=`) seguia dispensado como se fosse
 *       passagem de prop; a dispensa de anotação de tipo disparava em
 *       ternário (`{x ? x : null}` tem `: null`); e qualquer contrabarra na
 *       interpolação desligava a regra, o que inclui
 *       `{String(taxId).replace(/\D/g,'')}` — catorze dígitos crus na tela.
 *  v3 — esta. As dispensas deixaram de ser lexicais e passaram a ser de
 *       FORMA, e entrou a regra D: dígito cru escrito à mão também é o
 *       documento, e nenhuma das três regras anteriores conhecia essa forma.
 */

/**
 * PASSAGEM DE PROP — a lista fechada, e é esta que é a exceção.
 *
 * Antes havia uma lista de atributos que PINTAM (`value`, `title`, …) e tudo
 * o mais era tratado como passagem de prop. Denylist: `defaultValue={taxId}`
 * e `placeholder={venue.taxId}` escapavam, e os dois renderizam o documento
 * dentro de um campo visível. Invertido — um atributo só é dispensado se
 * estiver aqui; qualquer outro conta como posição de texto. É a regra de
 * allowlist que este repositório passou a semana reaprendendo.
 */
const PASSAGEM = /^(?:className|style|key|ref|id|htmlFor|type|name|role|tabIndex|inputMode|on[A-Z]\w*|data-\w+|aria-(?:hidden|checked|expanded|controls)|taxId)$/;
/** Vãos de atributo que passam adiante: `className={…}`, `style={{…}}`, `taxId={…}`. */
const VAO_DE_ATRIBUTO = /\w+=\{(?:[^{}]|\{[^{}]*\})*\}/g;
/** Aspas simples e duplas somem inteiras; a crase preserva os `${…}`. */
const ASPAS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
const CRASE = /`(?:[^`\\]|\\.)*`/g;
/** Literal de regex, reconhecido pelo que vem ANTES — senão divisão vira regex. */
const REGEX_LITERAL =
  /(?<=[=(,:[!&|?+\-*%^~{;]\s*)\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuyd]*/g;
const CNPJ_PONTUADO = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
const CPF_PONTUADO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/;
/** Regra D: o documento escrito cru, em literal. */
const DIGITOS_CRUS = /(?<![\d.\-/])(\d{11}|\d{14})(?![\d.\-/])/;

export function semComentarios(texto: string): string {
  return texto
    // Troca por QUEBRAS DE LINHA, não por nada: apagar um comentário de bloco
    // de dez linhas desloca todo o resto do arquivo, e o censo passa a apontar
    // linhas que não existem. O `Home.tsx:21` que ele acusava era a linha 33.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * O que NÃO é impressão, embora se escreva com chaves.
 *
 * Anotação de tipo e desestruturação de parâmetro. NÃO é mais "qualquer `:`"
 * — `{x ? x : null}` tem dois-pontos e imprime. A forma de tipo é
 * `{ ident: Tipo }` ou `{ ident?: Tipo }`, e um ternário não casa com ela
 * porque depois do identificador vem `.` ou `?` seguido de expressão.
 */
function naoEImpressao(trecho: string, antes: string): boolean {
  if (/;/.test(trecho)) return true;
  if (/^\{\s*\w+\??\s*:\s*[\w'"|\s[\]<>.]+\s*\}$/.test(trecho)) return true;
  if (/^\{[\s\w]+,[\s\w,]*\}$/.test(trecho)) return true;
  // POSIÇÃO DE PARÂMETRO — e `antes` tem que ser CÓDIGO. Testado contra a
  // linha inteira, qualquer vírgula ou parêntese do TEXTO JSX desligava a
  // regra: `<p>{venue.name}, {venue.taxId}</p>` e `<p>Racha ({venue.taxId})</p>`
  // — as duas linhas de rodapé mais naturais que alguém escreveria — passavam
  // verdes. A falha da v1 outra vez: traço léxico noutro ponto da linha
  // desarmando a regra. Agora exige um IDENTIFICADOR colado no delimitador,
  // que é o que uma chamada de função ou um literal de objeto tem, e um `}`
  // de JSX não tem.
  // Sem espaço entre o identificador e o delimitador: `foo(` é chamada,
  // `Racha (` é texto. Com `\s*` no meio, `<p>Racha ({venue.taxId})</p>`
  // ainda escapava.
  if (/(?:\w|\)|\])[(,]\s*$|[:=]\s*$/.test(antes)) return true;
  return false;
}

/**
 * Some o que NÃO imprime: literal de regex e aspas. A crase FICA, porque
 * `` {`CNPJ ${taxId}`} `` é a forma de literal que imprime — dela some só o
 * texto, e os `${…}` ficam.
 */
function limpar(linha: string): string {
  return linha
    .replace(REGEX_LITERAL, (m) => ' '.repeat(m.length))
    .replace(ASPAS, (m) => ' '.repeat(m.length))
    .replace(CRASE, (m) => {
      let saida = '';
      let resto = m;
      while (resto.length) {
        const abre = resto.indexOf('${');
        if (abre < 0) { saida += ' '.repeat(resto.length); break; }
        let nivel = 0;
        let fim = abre + 1;
        for (; fim < resto.length; fim++) {
          if (resto[fim] === '{') nivel++;
          else if (resto[fim] === '}' && --nivel === 0) break;
        }
        saida += ' '.repeat(abre) + resto.slice(abre + 1, fim + 1);
        resto = resto.slice(fim + 1);
      }
      return saida;
    });
}

/** O censo. `arquivo` só entra na mensagem — a regra não olha nome de arquivo nenhum. */
export function ofensoresEm(arquivo: string, bruto: string): string[] {
  const achados: string[] = [];
  const todoOTexto = semComentarios(bruto);
  const linhas = todoOTexto.split('\n');
  linhas.forEach((linha, i) => {
    const onde = `${arquivo}:${i + 1}`;
    const janela = linhas.slice(i, i + 3).join('\n');
    // Atributo de EXIBIÇÃO vira posição de texto ANTES de qualquer recorte:
    // `value={venue.taxId}` pinta na tela tanto quanto `{venue.taxId}`.
    // Recorta SÓ os atributos de passagem; os demais viram posição de texto.
    const fora = linha.replace(VAO_DE_ATRIBUTO, (m) => {
      const nome = m.slice(0, m.indexOf('='));
      return PASSAGEM.test(nome) ? ' ' : m.slice(m.indexOf('=') + 1);
    });

    // Literal de regex sai; aspas sem interpolação saem; a CRASE fica, porque
    // `` {`CNPJ ${taxId}`} `` é a forma de literal que imprime.
    const emTexto = limpar(fora);

    // A. IMPRESSÃO — sobre a JANELA, não a linha.
    //
    // Era de linha enquanto B e D já olhavam três linhas: meia correção. Um
    // `prettier` que quebre a expressão (`<span>{\n  venue.taxId\n}</span>`,
    // `{venue.taxId ??\n  ''}`) escapava inteiro. Só a primeira linha reporta,
    // pra não achar o mesmo sítio três vezes.
    // As linhas seguintes passam pela MESMA limpeza da corrente — máscara só
    // de aspas deixava um literal de regex (`/\(\{taxId\}\)/`, que REMOVE o
    // buraco da frase no `PrivacyNotice`) virar achado quando visto de cima.
    const janelaTexto = i === 0 || !/\{[^{}]*$/.test(linhas[i - 1])
      ? [emTexto, ...linhas.slice(i + 1, i + 3).map(limpar)].join('\n')
      : '';
    for (const m of janelaTexto.matchAll(/\{[^{}]*\btaxId\b[^{}]*\}/g)) {
      if (naoEImpressao(m[0].replace(/\s+/g, ' '), janelaTexto.slice(0, m.index))) continue;
      if (!/formatTaxId/.test(m[0])) achados.push(`${onde} imprime cru: ${m[0].trim().slice(0, 60)}`);
    }

    // B. APELIDO. Janela de três linhas: a atribuição pode ser um ternário
    //    quebrado — o `PrivacyNotice.tsx` é assim.
    const apelido = /\b(?:const|let|var)\s+[\w\s,:]+=\s*[^=;]*\btaxId\b/.exec(fora);
    if (apelido && !/formatTaxId/.test(janela)) {
      achados.push(`${onde} apelida sem formatar: ${apelido[0].trim().slice(0, 60)}`);
    }

    // C. DOCUMENTO PONTUADO À MÃO. Dispensa POSICIONAL: só dentro de um
    //    `placeholder=`, que ENSINA o formato em vez de afirmar um documento.
    const semPlaceholder = linha.replace(/placeholder=(?:"[^"]*"|'[^']*'|\{[^{}]*\})/g, ' ');
    if (CNPJ_PONTUADO.test(semPlaceholder)) achados.push(`${onde} CNPJ pontuado à mão`);
    if (CPF_PONTUADO.test(semPlaceholder)) achados.push(`${onde} CPF pontuado à mão`);

    // D. DÍGITO CRU EM LITERAL. Onze ou catorze dígitos escritos à mão são o
    //    documento tanto quanto a versão pontuada, e as regras A-C precisavam
    //    todas ou do token `taxId` ou da pontuação pra enxergar.
    //    Quando o literal está numa CONSTANTE NOMEADA, o formatador quase
    //    nunca está ao lado — no `Home.tsx` a declaração está na linha 33 e o
    //    `formatTaxId` na 139. Então segue-se o NOME: toda leitura dele tem
    //    que passar pelo formatador. Janela de três linhas só pro literal
    //    anônimo, escrito direto onde imprime.
    const cru = DIGITOS_CRUS.exec(semPlaceholder);
    if (cru) {
      const nomeado = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(fora);
      if (nomeado) {
        // Só as leituras DEPOIS da declaração, por deslocamento absoluto no
        // arquivo — não pelo tamanho da linha, que não é posição nenhuma.
        const fimDaDeclaracao = linhas.slice(0, i + 1).join('\n').length;
        const usos = [...todoOTexto.matchAll(new RegExp(`\\b${nomeado[1]}\\b`, 'g'))]
          .filter((u) => u.index !== undefined && u.index > fimDaDeclaracao);
        const cruas = usos.filter((u) => {
          const antes = todoOTexto.slice(Math.max(0, u.index! - 60), u.index!);
          return !/formatTaxId\s*\(\s*$/.test(antes);
        });
        if (cruas.length) {
          achados.push(`${onde} documento cru na constante ${nomeado[1]}, lida sem formatar`);
        }
      } else if (!/formatTaxId/.test(janela)) {
        achados.push(`${onde} documento cru em literal: ${cru[1]}`);
      }
    }
  });
  return achados;
}
