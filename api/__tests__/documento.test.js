'use strict';

/**
 * O documento da casa, do lado do SERVIDOR.
 *
 * Metade deste arquivo testa a conferência; a outra metade testa que a
 * conferência do servidor e a do cliente continuam sendo a MESMA conferência.
 * Ver o cabeçalho de `api/_lib/br/documento.js` e o do fixture.
 */

const doc = require('../_lib/br/documento.js');
const F = require('../_lib/br/documentos.fixture.json');

describe('CPF/CNPJ com dígito verificador', () => {
  test('o fixture não encolhe até virar o caso que eu estava olhando', () => {
    expect(F.validos.length).toBeGreaterThanOrEqual(6);
    expect(F.invalidos.length).toBeGreaterThanOrEqual(6);
    // Os dois tipos, dos dois lados da linha.
    expect(F.validos.filter((v) => v.tipo === 'cpf').length).toBeGreaterThan(1);
    expect(F.validos.filter((v) => v.tipo === 'cnpj').length).toBeGreaterThan(1);
  });

  test('todo documento válido do fixture passa, e com o tipo certo', () => {
    const erraram = F.validos.filter((v) => !doc.isValidCpfCnpj(v.doc) || doc.docKind(v.doc) !== v.tipo);
    expect(erraram).toEqual([]);
  });

  test('todo documento inválido do fixture é recusado', () => {
    const passaram = F.invalidos.filter((v) => doc.isValidCpfCnpj(v.doc));
    expect(passaram).toEqual([]);
  });
});

describe('o portão de escrita do POST /api/venues', () => {
  const F2 = F.documento_da_casa.casos;

  test('cada caso do fixture sai como o fixture diz', () => {
    const divergiram = [];
    for (const c of F2) {
      const r = doc.normalizarDocumentoDaCasa(c.entrada, c.market);
      if (r.ok !== c.ok) { divergiram.push(`${c.market} ${JSON.stringify(c.entrada)}: ok=${r.ok}, esperado ${c.ok}`); continue; }
      if (c.ok && r.valor !== c.valor) {
        divergiram.push(`${c.market} ${JSON.stringify(c.entrada)}: valor=${JSON.stringify(r.valor)}, esperado ${JSON.stringify(c.valor)}`);
      }
      if (!c.ok && r.code !== 'tax_id_invalid') {
        divergiram.push(`${c.market} ${JSON.stringify(c.entrada)}: code=${r.code}`);
      }
    }
    expect(divergiram).toEqual([]);
    // O corpo cobre os dois mercados e os dois lados da linha.
    expect(F2.filter((c) => c.market === 'es').length).toBeGreaterThan(3);
    expect(F2.filter((c) => c.market === 'br' && c.ok === false).length).toBeGreaterThan(5);
  });

  test('todo CPF válido é recusado como documento de CASA', () => {
    // Documento de casa é documento de empresa. A versão anterior aceitava
    // CPF porque foi escrita em cima do `isValidCpfCnpj`, que aceita os dois,
    // e `venues.cnpj` sai no `/api/check` sem autenticação nenhuma.
    const cpfs = F.validos.filter((v) => v.tipo === 'cpf');
    expect(cpfs.length).toBeGreaterThan(1);
    for (const v of cpfs) {
      expect(doc.isValidCpfCnpj(v.doc)).toBe(true);          // é documento válido
      expect(doc.normalizarDocumentoDaCasa(v.doc, 'br').ok).toBe(false);  // e não serve aqui
    }
  });

  test('o que sai pro cliente é conferido pelo VALOR, não só pelo mercado', () => {
    for (const c of F.publicacao.casos) {
      expect(doc.documentoPublicavelDaCasa(c.market, c.valor, c.mostra)).toBe(c.sai);
    }
  });

  test('o que não é texto nem número é recusado, sem estourar', () => {
    for (const lixo of [{}, [], true, () => {}, Symbol('x'), 12n, NaN, Infinity]) {
      expect(() => doc.normalizarDocumentoDaCasa(lixo, 'br')).not.toThrow();
      expect(doc.normalizarDocumentoDaCasa(lixo, 'br').ok).toBe(false);
    }
  });

  test('o corte por tamanho NÃO é o que recusa a string enorme — e fica assim mesmo', () => {
    // Honestidade sobre o que este teste prova.
    //
    // A primeira versão media o relógio e dizia "se alguém inverter a ordem,
    // isto fica lento". A revisão inverteu a ordem: passou em 2 ms. A segunda
    // versão afirmou provar a ordem estruturalmente; também não provava —
    // tirando o `length > 32`, tudo continua sendo recusado, porque uma
    // string de 33 dígitos não é CPF nem CNPJ e o `docKind` a derruba.
    // Verificado por mutação: com o corte fora, os dez testes seguem verdes.
    //
    // Então o corte NÃO é carregador hoje. Ele fica como profundidade: a
    // regex de forma canônica é ancorada sobre uma classe de caracteres só,
    // sem backtracking, e por isso 1 MB custa fração de milissegundo — mas
    // isso é propriedade DESTA regex, e quem lhe acrescentar um quantificador
    // não vai pensar no corpo de 1 MB do `readBody`. O que este teste afirma
    // é só o comportamento observável, que é o que um teste pode afirmar.
    expect(doc.normalizarDocumentoDaCasa('0'.repeat(33), 'br').ok).toBe(false);
    expect(doc.normalizarDocumentoDaCasa('x'.repeat(1_000_000), 'br').ok).toBe(false);
    expect(doc.normalizarDocumentoDaCasa('B' + '1'.repeat(40), 'es').ok).toBe(false);
    // E rápido, sem afirmar POR QUE é rápido.
    const t0 = process.hrtime.bigint();
    doc.normalizarDocumentoDaCasa('0'.repeat(1_000_000), 'br');
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(50);
  });

  test('o código de erro é um que o cliente já sabe traduzir', () => {
    // O servidor nunca manda texto de exibição (CLAUDE.md). Um código novo
    // sem chave no dicionário vira texto cru na tela de quem não lê português.
    const fs = require('node:fs');
    const path = require('node:path');
    const dict = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
    const r = doc.normalizarDocumentoDaCasa('99999999999999', 'br');
    expect(r.ok).toBe(false);
    expect(dict).toContain(`'err.${r.code}'`);
  });

  test('a rota não manda frase junto com o código', () => {
    // `{ error: 'CNPJ inválido', code: 'tax_id_invalid' }` mandava as duas
    // coisas: o código pro cliente traduzir e uma frase em português pra quem
    // não pediu português. Ver `http-error.js` — "com CÓDIGO, a mensagem
    // interna NÃO viaja".
    const fs = require('node:fs');
    const path = require('node:path');
    const router = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');
    const linha = router.split('\n').find((l) => l.includes('code: doc.code'));
    expect(linha).toBeTruthy();
    expect(linha).not.toMatch(/error:\s*'/);
  });
});

/**
 * O CENSO DAS ROTAS.
 *
 * `POST /api/venues` foi endurecido em 2026-09-13 e `POST /api/psp/recipient`
 * ficou como estava — o mesmo defeito, no campo que decide pra ONDE O DINHEIRO
 * VAI, enquanto o que foi consertado é o que aparece impresso no recibo. As
 * duas revisões acharam, separadamente, e o módulo que eu tinha acabado de
 * escrever diagnosticava a doença no próprio cabeçalho ("cliente validando,
 * servidor não — o par clássico") ao mesmo tempo que a deixava viva uma rota
 * adiante.
 *
 * Então o guarda não é sobre uma rota: toda leitura de documento vinda do
 * CORPO da requisição passa por uma conferência, e quem acrescentar a próxima
 * descobre aqui, não numa revisão.
 */
describe('toda rota que lê documento do corpo o confere', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROUTER = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

  /** Campos de documento que chegam pelo corpo. Nome novo? Entra aqui. */
  const CAMPOS = [/\bb\.cnpj\b/g, /\bb\.document\b/g, /\bb\.payerDocument\b/g, /\bbody\.payerDocument\b/g];
  /**
   * Quem confere. As três primeiras são conferência NA ROTA; `charge` e
   * `demoCharge` são o portão de dinheiro, e a conferência do CPF do pagador
   * mora dentro dele (`api/_lib/pay/create-charge.js`: onze dígitos, e string
   * vazia conta como ausente). Aceitar o nome da função é aceitar que a
   * conferência está uma camada abaixo — o que é verdade, e é por isso que
   * está escrito aqui em vez de a janela ter sido alargada até o padrão casar
   * por acidente.
   */
  const CONFEREM = /normalizarDocumentoDaCasa|isValidCpfCnpj|isValidCNPJ|isValidCPF|\bcharge\b|demoCharge/;

  test('cada leitura está a poucas linhas de uma conferência', () => {
    const linhas = ROUTER.split('\n');
    const semGuarda = [];
    let leituras = 0;
    linhas.forEach((linha, i) => {
      // Comentário não lê nada — e os comentários daqui CITAM os campos.
      const codigo = linha.replace(/(^|[^:])\/\/.*$/, '$1');
      if (!CAMPOS.some((re) => { re.lastIndex = 0; return re.test(codigo); })) return;
      leituras++;
      // A janela olha pra trás e pra frente: a conferência pode preceder a
      // leitura (`const doc = normalizar…(b.cnpj)`) ou vir logo depois.
      const janela = linhas.slice(Math.max(0, i - 16), i + 8).join('\n');
      if (!CONFEREM.test(janela)) {
        semGuarda.push(`router.js:${i + 1}  ${linha.trim().slice(0, 100)}`);
      }
    });
    // Um censo que anda em zero leituras passa calado.
    expect(leituras).toBeGreaterThanOrEqual(3);
    expect(semGuarda).toEqual([]);
  });

  test('o documento do recebedor tem que bater com o do recibo', () => {
    // `venues.cnpj` é o que o cliente lê no comprovante; `b.document` é onde o
    // split liquida. Nada ligava os dois, então "recibo mostra X, dinheiro vai
    // pra Y" era alcançável e silencioso — com o material de venda prometendo
    // ao dono o contrário. Ver `docs/outreach/`.
    expect(ROUTER).toMatch(/recipient_doc_mismatch/);
    const i18n = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'web', 'src', 'i18n.ts'), 'utf8');
    expect(i18n).toContain("'err.recipient_doc_mismatch'");
  });
});
