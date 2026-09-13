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

/** Atributos que PINTAM na tela. Não são passagem de prop — são impressão. */
const SINK = /\b(?:value|title|alt|aria-label|content|label|summary)=\{/g;
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
  if (/[(,=]\s*$/.test(antes)) return true;
  return false;
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
    const fora = linha.replace(SINK, '{').replace(VAO_DE_ATRIBUTO, ' ');

    // Literal de regex sai; aspas sem interpolação saem; a CRASE fica, porque
    // `` {`CNPJ ${taxId}`} `` é a forma de literal que imprime.
    const emTexto = fora
      .replace(REGEX_LITERAL, (m) => ' '.repeat(m.length))
      .replace(ASPAS, (m) => ' '.repeat(m.length))
      // Da crase some só o TEXTO; o miolo de cada `${…}` fica, porque é ele
      // que imprime. Apagar o literal inteiro foi o que abriu a oitava fuga.
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

    // A. IMPRESSÃO.
    for (const m of emTexto.matchAll(/\{[^{}]*\btaxId\b[^{}]*\}/g)) {
      if (naoEImpressao(m[0], emTexto.slice(0, m.index))) continue;
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
