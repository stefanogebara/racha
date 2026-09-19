'use strict';

/**
 * TODO ERRO 4xx DE `_lib/pay` CARREGA UM `code`.
 *
 * O título deste arquivo dizia "todo erro que chega no cliente", e ele anda só
 * em `_lib/pay`. A diferença não é pedantismo: existem contraexemplos vivos
 * fora do caminho varrido — `_lib/store/supabase.js` tem quatro sítios no gasto
 * de saldo (`saldo insuficiente` 409, `invalid amount` 400, `Conta não
 * encontrada` 404) que chegam ao cliente como texto cru em pt-BR pelo catch
 * geral do `POST /api/house/redeem`. Nada interno vaza ali, então é quebra do
 * contrato de i18n e não divulgação — mas um censo cujo NOME promete a classe
 * inteira faz o próximo leitor acreditar que a classe está fechada, que é
 * precisamente como um guarda deixa de ser lido. Oitava revisão de segurança
 * (2026-09-19, LOW-2); alargar a varredura está na lista do
 * `2026-09-19-o-que-oito-rodadas-deixaram-aberto.md`.
 *
 * O acordo do CLAUDE.md: "o servidor nunca manda texto de tela para erros;
 * manda um `code` estável e centavos crus; quem traduz e formata é o cliente".
 *
 * O `errorBody` só consegue suprimir a mensagem interna quando existe `code`
 * — abaixo de 500 ele cai em `{ success:false, error: err.message }`. Então um
 * erro 4xx sem código é, por construção, texto interno viajando pra tela. E o
 * `tError` do cliente tem uma última linha que imprime esse texto cru
 * ("servidor antigo, sem código"), o que faz o defeito parecer funcionamento.
 *
 * ISTO JÁ FOI ACHADO DUAS VEZES, nos mesmos arquivos e com um commit de
 * distância:
 *
 *  - sétima revisão (MEDIUM-5): a recusa do emissor não tinha `code`, então a
 *    frase da Pagar.me com `acquirer_message` cru ia pra tela;
 *  - oitava revisão (HIGH-1): o conserto cobriu os dois sítios que falam de
 *    cartão e esqueceu o caminho GENÉRICO do gateway — que serve o Pix, está
 *    no ar, e mandava `pagarme POST /orders: The recipient is not active`.
 *
 * Consertar o sítio de novo seria a terceira vez. Este censo prende a CLASSE:
 * qualquer erro atribuído com `statusCode` 4xx dentro de `api/_lib/pay/` tem
 * que receber um `code` também.
 */

const fs = require('node:fs');
const path = require('node:path');

const PAY = path.join(__dirname, '..', '_lib', 'pay');

/**
 * Tira comentário PRESERVANDO a numeração de linha.
 *
 * A primeira versão apagava o bloco inteiro, o que engole as quebras de linha e
 * desloca tudo que vem depois: o censo acusava `create-charge.js:104`, que é
 * uma linha de comentário. Um censo que cita o lugar errado manda a pessoa
 * olhar pro lugar errado — e o defeito de verdade continua onde estava.
 */
const semComentarios = (fonte) => fonte
  .replace(/\/\*[\s\S]*?\*\//g, (bloco) => bloco.replace(/[^\n]/g, ' '))
  .replace(/^([ \t]*)\/\/.*$/gm, '$1');

/**
 * Cada atribuição de `statusCode` 4xx, e se o MESMO erro recebe um `code`
 * antes de ser lançado.
 *
 * A primeira versão disto olhava uma janela de 30 linhas e perguntava "aparece
 * algum `code` por perto?". Era inerte: apagar o conserto do HIGH-1 deixava o
 * censo VERDE, porque dentro da janela havia o `code` de OUTRO erro, de outra
 * função. Um censo que encontra o companheiro errado absolve o culpado — e foi
 * um mutante plantado que mostrou isso, não a leitura.
 *
 * Agora segue a VARIÁVEL: de `err.statusCode = 4xx` até o `throw err` dela,
 * tem que existir um `err.code`. O par é o mesmo objeto, não a vizinhança.
 */
function sitiosDe(fonte) {
  const linhas = fonte.split('\n');
  const fora = [];
  linhas.forEach((linha, i) => {
    /**
     * `err.statusCode = <o que for>` — e o "o que for" importa.
     *
     * A versão anterior exigia um LITERAL de três dígitos, e por isso não
     * enxergava o sítio do HIGH-1, que é um ternário:
     *
     *     err.statusCode = res.status >= 400 && res.status < 500 ? 402 : 502;
     *
     * Ou seja: o censo escrito pra prender aquele achado não via o achado. A
     * regra agora é pelo VALOR POSSÍVEL — qualquer 4xx que apareça no lado
     * direito põe o sítio sob a exigência.
     */
    const atrib = linha.match(/\b([A-Za-z_$][\w$]*)\.statusCode\s*=\s*([^;]+)/);
    // `Object.assign(new Error(…), { statusCode: 400, code: '…' })` — um só termo.
    const literal = linha.match(/statusCode:\s*(\d{3})/);

    if (atrib) {
      const quatroXx = (atrib[2].match(/\b\d{3}\b/g) || [])
        .map(Number).filter((n) => n >= 400 && n < 500);
      if (!quatroXx.length) return;
      const status = quatroXx[0];
      const nome = atrib[1];
      // Do ponto da atribuição até o `throw <nome>` — o fim de vida do objeto.
      let fim = linhas.length;
      for (let k = i + 1; k < linhas.length; k += 1) {
        if (new RegExp(`\\bthrow\\s+${nome}\\b`).test(linhas[k])) { fim = k; break; }
      }
      const corpo = linhas.slice(i, fim + 1).join('\n');
      const temCodigo = new RegExp(`\\b${nome}\\.code\\s*=`).test(corpo);
      fora.push({ linha: i + 1, status, temCodigo });
      return;
    }
    if (literal) {
      const status = Number(literal[1]);
      if (status < 400 || status >= 500) return;
      // Objeto literal: o `code` tem que estar no MESMO literal (mesma linha ou
      // a seguinte, que é como o repositório os escreve).
      const corpo = linhas.slice(i, i + 3).join('\n');
      fora.push({ linha: i + 1, status, temCodigo: /\bcode:\s*'[a-z_]+'/.test(corpo) });
    }
  });
  return fora;
}

/**
 * O ERRO CONSTRUÍDO POR FÁBRICA também conta.
 *
 * `badRequest(msg)` põe o `statusCode = 400` DENTRO do ajudante, então o sítio
 * que o chama não tem literal nenhum pra o censo acima casar. Era um ponto
 * cego: plantei `throw badRequest('carteira desconhecida: …')` sem o segundo
 * argumento — o defeito LOW-1 da oitava revisão, em que a frase em português
 * viaja pra tela — e o censo ficou verde.
 *
 * A fábrica deste repositório recebe o código como SEGUNDO argumento e só o
 * anexa se ele vier (`if (code) err.code = code`), então "chamou com um
 * argumento só" é exatamente "erro 400 sem código".
 */
const FABRICAS = ['badRequest'];

function fabricasMudas(fonte) {
  const linhas = fonte.split('\n');
  const fora = [];
  linhas.forEach((linha, i) => {
    for (const nome of FABRICAS) {
      const m = linha.match(new RegExp(`\\b${nome}\\(`));
      if (!m) continue;
      // Do parêntese de abertura até o fechamento equilibrado — o argumento
      // pode ter template com `${…}` e vírgulas dentro.
      const abre = linha.indexOf('(', m.index);
      let nivel = 0; let fim = -1;
      for (let k = abre; k < linha.length; k += 1) {
        if (linha[k] === '(') nivel += 1;
        else if (linha[k] === ')') { nivel -= 1; if (nivel === 0) { fim = k; break; } }
      }
      if (fim < 0) continue;  // chamada quebrada em várias linhas: não julga
      const args = linha.slice(abre + 1, fim);
      /**
       * Vírgula de TOPO: o segundo argumento é o código.
       *
       * A primeira versão contava a crase como abertura e nunca como
       * fechamento, então qualquer template mantinha a profundidade acima de
       * zero e a vírgula de topo ficava invisível — o censo acusava
       * `badRequest(\`…\`, 'rail_unsupported')`, que TEM código. Acusar o
       * inocente gasta a confiança que o censo precisa pra ser levado a sério
       * quando acusar o culpado.
       */
      let n = 0;
      let temSegundo = false;
      let dentro = null;   // null | "'" | '"' | '`'
      for (let k = 0; k < args.length; k += 1) {
        const ch = args[k];
        if (args[k - 1] === '\\') continue;   // escapado: não é delimitador
        if (dentro) {
          if (ch === dentro) dentro = null;
          // `${` dentro de template reabre código de verdade
          else if (dentro === '`' && ch === '$' && args[k + 1] === '{') { n += 1; k += 1; }
          else if (dentro === '`' && ch === '}' && n > 0) n -= 1;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { dentro = ch; continue; }
        if ('([{'.includes(ch)) n += 1;
        else if (')]}'.includes(ch)) n -= 1;
        else if (ch === ',' && n === 0) { temSegundo = true; break; }
      }
      if (!temSegundo) fora.push(i + 1);
    }
  });
  return fora;
}

const arquivos = fs.readdirSync(PAY).filter((f) => f.endsWith('.js'));

test('todo erro 4xx de `_lib/pay` carrega um `code`', () => {
  const mudos = [];
  for (const nome of arquivos) {
    const fonte = semComentarios(fs.readFileSync(path.join(PAY, nome), 'utf8'));
    for (const s of sitiosDe(fonte)) {
      if (!s.temCodigo) mudos.push(`${nome}:${s.linha} (${s.status})`);
    }
  }
  expect(mudos).toEqual([]);
});

test('nenhuma fábrica de erro 400 é chamada sem código', () => {
  const mudas = [];
  for (const nome of arquivos) {
    const fonte = semComentarios(fs.readFileSync(path.join(PAY, nome), 'utf8'));
    for (const linha of fabricasMudas(fonte)) mudas.push(`${nome}:${linha}`);
  }
  expect(mudas).toEqual([]);
});

test('o censo de fábrica ENXERGA — medido sobre fonte sintética', () => {
  expect(fabricasMudas("throw badRequest('x');\n")).toEqual([1]);
  expect(fabricasMudas("throw badRequest('x', 'meu_codigo');\n")).toEqual([]);
  // Template com vírgula DENTRO não conta como segundo argumento.
  expect(fabricasMudas('throw badRequest(`a ${b(1, 2)} c`);\n')).toEqual([1]);
  expect(fabricasMudas('throw badRequest(`a ${b} c`, \'cod\');\n')).toEqual([]);
});

test('o censo achou sítios de verdade — senão ele passaria sobre nada', () => {
  // Um censo que não encontra nada é indistinguível de um censo quebrado. A
  // população real dos 4xx em `_lib/pay` é pequena e conhecida; se ela cair pra
  // zero, alguém mudou a forma de atribuir status e este arquivo ficou cego.
  const total = arquivos.reduce(
    (n, nome) => n + sitiosDe(semComentarios(fs.readFileSync(path.join(PAY, nome), 'utf8'))).length,
    0,
  );
  expect(total).toBeGreaterThanOrEqual(5);
});

test('o censo ENXERGA — medido sobre fonte sintética', () => {
  const semCodigo = "const e = new Error('x');\ne.statusCode = 402;\nthrow e;\n";
  expect(sitiosDe(semCodigo)).toEqual([{ linha: 2, status: 402, temCodigo: false }]);

  const comCodigo = "const e = new Error('x');\ne.statusCode = 402;\ne.code = 'card_declined';\nthrow e;\n";
  expect(sitiosDe(comCodigo)[0].temCodigo).toBe(true);

  // 5xx não entra: lá o `errorBody` já suprime a mensagem sozinho.
  expect(sitiosDe('e.statusCode = 502;\n')).toEqual([]);

  /**
   * O TERNÁRIO — o sítio real do HIGH-1, que a primeira versão não via porque
   * exigia um literal. Se isto voltar a devolver lista vazia, o censo ficou
   * cego justamente pro achado que o motivou.
   */
  const ternario = "err.statusCode = res.status >= 400 && res.status < 500 ? 402 : 502;\nthrow err;\n";
  expect(sitiosDe(ternario)).toHaveLength(1);
  expect(sitiosDe(ternario)[0].temCodigo).toBe(false);
  expect(sitiosDe(`err.statusCode = a ? 402 : 502;\nerr.code = 'x_y';\nthrow err;\n`)[0].temCodigo)
    .toBe(true);
  // A forma de objeto literal também conta.
  expect(sitiosDe("throw Object.assign(new Error('x'), { statusCode: 400 });\n")).toHaveLength(1);
  expect(sitiosDe("throw Object.assign(new Error('x'), { statusCode: 400, code: 'x_y' });\n")[0].temCodigo)
    .toBe(true);

  /**
   * O CASO QUE ENGANOU A VERSÃO ANTERIOR: um `code` logo abaixo, pertencendo a
   * OUTRO erro. Se este teste passar a dizer `true`, o censo voltou a achar o
   * companheiro errado.
   */
  const vizinhoAlheio = [
    "const err = new Error('a');",
    'err.statusCode = 402;',
    'throw err;',
    '}',
    "const outro = new Error('b');",
    "outro.code = 'nao_e_meu';",
    'throw outro;',
  ].join('\n');
  expect(sitiosDe(vizinhoAlheio)[0].temCodigo).toBe(false);
});
