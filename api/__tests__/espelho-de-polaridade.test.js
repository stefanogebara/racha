'use strict';

/**
 * O OITAVO INSTRUMENTO: O ESPELHO DE POLARIDADE.
 *
 * Todo instrumento de vocabulário deste repositório faz UMA pergunta: este
 * token DISPARA? A grade adversarial exige `acusa === true`; a sonda de
 * alcance exige que a moldura canônica reaja; o censo de peso exige que apagar
 * a alternativa deixe o corpo vermelho. Nenhum pergunta o contrário — este
 * token dispara ONDE NÃO DEVE?
 *
 * E é nessa polaridade que mora o defeito mais caro da rodada 19: o `no`
 * espanhol entrou por relação (`no` + VERBO), a espreita não tinha âncora de
 * fim, e `acerto` — substantivo português comuníssimo que está no
 * `verbo_finito` porque também é 1ª pessoa de `acertar` — fazia `A gorjeta no
 * acerto vai pro garçom.` ser lida como NEGAÇÃO. Recusada no commit pai,
 * liberada pelo commit seguinte, nos dois guardas e no censo de build, que é
 * quem governa o `i18n.ts` e o roteiro impresso do garçom.
 *
 * Então: pega cada alternativa de cada lista de DETECÇÃO, planta numa grade de
 * turnos INOCENTES de restaurante, e exige que o guarda continue absolvendo.
 * Um token que acusa dentro de uma frase inocente é o custo que este arquivo
 * chama de apagar a conta da tela.
 * Pedido pela revisão de segurança de 2026-09-15, que achou o CRITICAL por
 * este raciocínio antes de o instrumento existir.
 *
 * O QUE ISTO NÃO MEDE, e a distinção importa: ele mede FALSO POSITIVO — token
 * que faz o guarda recusar uma frase inocente. O CRITICAL que o motivou é do
 * outro sinal: `A gorjeta no acerto vai pro garçom.` é uma PROMESSA que passou
 * a ser absolvida. Medi: com o padrão revertido ao estado do defeito, este
 * espelho continua verde. Quem pega aquela classe é o DIFERENCIAL CONTRA O
 * PAI (`api/__tests__/diferencial.test.js`), e foi com ele que a revisão de
 * segurança achou. As duas polaridades precisam de instrumento; esta é uma
 * delas, e dizer qual é parte de não vender cobertura que não existe.
 *
 * E molduras fixas: um token que só acusa numa vizinhança que a grade não tem
 * passa — por isso ele é o oitavo instrumento e não o único.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const G = JSON.parse(fs.readFileSync(
  path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;
const FONTE = fs.readFileSync(path.join(__dirname, 'claims.test.js'), 'utf8');

function carrega() {
  const corpo = FONTE.slice(0, FONTE.indexOf("describe('"))
    .replace("const RAIZ = path.join(__dirname, '..', '..');", 'const RAIZ = ' + JSON.stringify(RAIZ) + ';')
    .replace(/require\(['"]\.\.\/\.\.\/scripts\//g,
      'require(' + JSON.stringify(path.join(RAIZ, 'scripts')) + " + '/");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-'));
  const arq = path.join(tmp, 'censo.js');
  fs.writeFileSync(arq, corpo + '\nmodule.exports = { acusa };\n');
  return require(arq);
}

/**
 * Turnos INOCENTES de restaurante — a conversa que o produto tem todo dia, e
 * onde `%s` é o token plantado. Nenhuma promete destino nenhum.
 */
const MOLDURAS = [
  // Com destinatário, mas SEM frase de destino: o verbo está no prefixo, então
  // nenhuma delas é promessa por construção. É aqui que o `no acerto` morava.
  (t) => `No ${t} da conta, fala com o garçom.`,
  (t) => `Depois do ${t}, chama o garçom pra fechar.`,
  (t) => `Posso ${t} você a acertar na maquininha.`,
  // Sem destinatário nenhum: nada pode disparar, e é o controle da grade.
  (t) => `Sua parte é R$ 61,00. O ${t} já saiu.`,
  (t) => `O ${t} da mesa 7 já fechou.`,
];

/**
 * A moldura é INOCENTE POR CONSTRUÇÃO, não por sorte: uma que vire promessa
 * quando recebe um substantivo de gorjeta mede o guarda acertando, não
 * errando. A primeira versão tinha `A comanda do ${t} vai pro garçom`, que põe
 * o token num genitivo colado no destinatário — ali um nome de gorjeta É a
 * promessa, e a grade acusava o guarda de fazer o certo.
 */

/** Listas de DETECÇÃO: as que fazem o guarda olhar pra frase. */
/**
 * SÓ AS LISTAS DE SUBSTANTIVO, porque as molduras são de SUBSTANTIVO. Plantar
 * um verbo num slot de nome produz `No fica da conta, fala com o garçom.`, que
 * não é português e não mede guarda nenhum — mede a minha grade. As listas de
 * verbo e de palavra funcional precisam das molduras delas, e enquanto não
 * tiverem é melhor dizer isso do que vender cobertura que não existe.
 */
const LISTAS = ['substantivo_gorjeta', 'nome_de_quantia', 'verbo_espanhol',
  'substantivo_nao_dinheiro', 'nucleo_negavel'];

const TOLERADAS = G._espelho_tolerado || {};

describe('o ESPELHO DE POLARIDADE: nenhum token acusa um turno inocente', () => {
  const { acusa } = carrega();

  test.each(LISTAS)('%s', (campo) => {
    const tokens = G[campo].split('|')
      .map((a) => a.replace(/^\\b/, '').replace(/\\b$/, ''))
      .map((a) => a.replace(/\(\?<!\[[^\]]*\]\)/g, '').replace(/\(\?!\[[^\]]*\]\)/g, ''))
      .filter((a) => /^[a-zà-ÿ]+$/.test(a));
    expect(tokens.length).toBeGreaterThanOrEqual(5);
    const acusaram = [];
    for (const t of tokens) {
      for (const m of MOLDURAS) {
        const frase = m(t);
        if (acusa(frase) && !TOLERADAS[frase]) acusaram.push(frase);
      }
    }
    expect(acusaram).toEqual([]);
  });

  test('a gaveta do espelho é usada e tem motivo escrito', () => {
    const { acusa: a } = carrega();
    for (const [frase, porque] of Object.entries(TOLERADAS)) {
      expect(`${frase}: ${porque}`).toMatch(/.{160,}/);
      expect(a(frase)).toBe(true);
    }
  });
});
