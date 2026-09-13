'use strict';

/**
 * CPF/CNPJ com dígito verificador, do lado do SERVIDOR.
 *
 * Até 2026-09-13 esta conferência existia só em `apps/web/src/br.ts`: o
 * `Admin.tsx` mascarava pra catorze dígitos e desarmava o botão com
 * `!cnpjValid`, e o `POST /api/venues` aceitava `b.cnpj` do corpo sem checar
 * tipo, tamanho nem dígito. Cliente validando, servidor não — o par clássico.
 * O valor guardado chega depois a TODO cliente não autenticado pelo
 * `/api/check`, e agora também ao formatador do recibo.
 *
 * CÓPIA DECLARADA, NÃO CÓPIA ESQUECIDA. Os dois lados não podem compartilhar
 * módulo (o servidor é CommonJS, o cliente é TS/ESM), então o que impede a
 * divergência não é disciplina: é `documentos.fixture.json`, o mesmo corpo de
 * documentos exercitado pelos DOIS testes. Se as implementações discordarem,
 * um dos dois lados fica vermelho.
 */

function onlyDigits(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

function isValidCPF(input) {
  const d = onlyDigits(input);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // 000..., 111... passam na conta
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function isValidCNPJ(input) {
  const d = onlyDigits(input);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    const pesos = len === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * pesos[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** 11 dígitos → cpf, 14 → cnpj, senão null. */
function docKind(input) {
  const n = onlyDigits(input).length;
  if (n === 11) return 'cpf';
  if (n === 14) return 'cnpj';
  return null;
}

function isValidCpfCnpj(input) {
  const k = docKind(input);
  return k === 'cpf' ? isValidCPF(input) : k === 'cnpj' ? isValidCNPJ(input) : false;
}

/**
 * O que o `createVenue` guarda. Devolve `{ ok, valor }` ou `{ ok:false, code }`.
 *
 * DOCUMENTO DE CASA É DOCUMENTO DE EMPRESA. A primeira versão aceitava CPF,
 * porque foi escrita em cima do `isValidCpfCnpj`, que aceita os dois — e o
 * nome da função (`normalizarCnpjDeCasa`) mentia sobre isso. Três camadas
 * passaram a tratar o CPF como caso de primeira classe: o portão aceitava, o
 * fixture listava três CPFs como válidos, e o `formatTaxId` pontuava
 * `529.982.247-25` no recibo.
 *
 * O que isso publica: `venues.cnpj` sai no `/api/check`, que NÃO tem
 * autenticação — o token da mesa viaja em link compartilhado e em QR
 * fotografado. Um dono MEI que mandasse o próprio CPF (e MEI é o segmento do
 * piloto) teria o documento pessoal dele na tela de todo cliente da casa.
 *
 * O argumento já estava escrito no `markets.js`, apontado pra Espanha: lá o
 * NIF de um autónomo É o DNI dele, e por isso a Espanha não mostra documento
 * nenhum. O Brasil tem a mesma população e a regra não tinha sido aplicada
 * aqui. Achado pela revisão de segurança de 2026-09-13.
 *
 * Ausente é LEGÍTIMO: o cadastro pede o documento no passo do recebedor, não
 * no de abrir a casa, e exigi-lo aqui quebraria o assistente. O que não é
 * legítimo é guardar qualquer blob — o corpo vai até 1 MB, e o que entra aqui
 * sai no `/api/check` de todo mundo.
 *
 * `code`, não frase: quem escolhe a língua é o cliente (CLAUDE.md). O código é
 * o `tax_id_invalid` que o `create-charge.js` já emite e o `i18n.ts` já
 * traduz nas três línguas — um código novo pra mesma coisa seria uma quarta
 * palavra pro mesmo erro e uma tela em inglês cru pra quem lê em espanhol.
 */
function normalizarDocumentoDaCasa(bruto, market = 'br') {
  if (bruto == null || bruto === '') return { ok: true, valor: null };
  if (typeof bruto !== 'string' && typeof bruto !== 'number') {
    return { ok: false, code: 'tax_id_invalid' };
  }
  const texto = String(bruto).trim();
  // Cortado ANTES de qualquer regex: uma string de 1 MB não precisa ser
  // percorrida pra se saber que não é um documento de catorze dígitos.
  if (texto.length > 32) return { ok: false, code: 'tax_id_invalid' };

  // ESPANHA: NIF/CIF é letra + 8 dígitos, ou 8 dígitos + letra. Sem dígito
  // verificador aqui — o algoritmo espanhol não está implementado, e fingir
  // que está seria pior que não checar. Confere a FORMA, e diz na cara que a
  // conferência é de forma. (A exigência do `formatTaxId` era impossível de
  // satisfazer antes desta linha: o gate de pontuação canônica só aceita
  // dígitos, e todo NIF começa ou termina com letra — nenhuma casa espanhola
  // conseguia ser criada com documento.)
  if (market === 'es') {
    const nif = texto.replace(/[.\-\s]/g, '').toUpperCase();
    // NIE (X/Y/Z + 7 dígitos + letra) e CIF de controle ALFABÉTICO (tipos
    // P,Q,R,S,N,W) são formas legítimas que a primeira versão recusava — e
    // NIE é comuníssimo entre donos de bar em Espanha. "Confere a FORMA" foi
    // afirmado com mais confiança do que a regex merecia.
    // `^\d{8}[A-Z]$` É O DNI DE UMA PESSOA FÍSICA, e documento de casa é
    // documento de empresa — a regra que o lado brasileiro deste mesmo
    // arquivo existe pra impor ("No Brasil isso é CNPJ e só"). Aceitá-lo aqui
    // seria deixar o split liquidar no documento pessoal de alguém, que é o
    // achado que este módulo inteiro nasceu pra fechar, com outra bandeira.
    //
    // Sobra CIF (letra de tipo + 7 dígitos + controle) e NIE (X/Y/Z + 7 +
    // letra). O NIE é de pessoa física residente, mas é o que um autónomo
    // usa pra operar — e é o `showsVenueTaxId('es')` que decide publicar ou
    // não, que continua false justamente por isso.
    if (!/^[ABCDEFGHJNPQRSUVW]\d{7}[A-Z0-9]$|^[XYZ]\d{7}[A-Z]$/.test(nif)) {
      return { ok: false, code: 'tax_id_invalid' };
    }
    return { ok: true, valor: nif };
  }

  // SÓ PONTUAÇÃO CANÔNICA — a mesma regra do `formatTaxId`, e pelo mesmo
  // motivo. `isValidCpfCnpj` joga fora tudo que não é dígito, então
  // `CNPJ em analise 11222333000181` passava por ele: a ressalva sumia e o
  // número era aceito como conferido. Escrever a validação em cima de um
  // extrator é validar outra coisa que não o que o usuário mandou.
  if (!/^[\d.\-/\s]+$/.test(texto)) return { ok: false, code: 'tax_id_invalid' };
  // CNPJ, não "CPF ou CNPJ": ver o cabeçalho.
  if (docKind(texto) !== 'cnpj') return { ok: false, code: 'tax_id_invalid' };
  if (!isValidCNPJ(texto)) return { ok: false, code: 'tax_id_invalid' };
  return { ok: true, valor: onlyDigits(texto) };
}

/**
 * O documento da casa pode SAIR pro cliente, com este valor?
 *
 * `showsVenueTaxId` responde pelo MERCADO; isto responde pelo VALOR. Os dois
 * são precisos: a política de mercado não sabe o que está guardado na coluna,
 * e linhas antigas foram escritas antes do portão de escrita existir. Onze
 * dígitos na coluna de uma casa brasileira é CPF de alguém, e não sai daqui —
 * a migração 0002 já tinha decidido que documento errado num recibo é pior
 * que a ausência dele.
 *
 * NORMALIZA ANTES DE CONFERIR. A primeira versão testava `/^\d{14}$/` contra o
 * valor cru, e antes do portão de escrita existir o `POST /api/venues`
 * guardava o que viesse — inclusive `65.087.663/0001-30`, que é o que a
 * máscara do `Admin.tsx` produz. Toda casa piloto cujo dono digitou a
 * pontuação ficaria com o recibo SEM documento, em silêncio e pra sempre (não
 * há rota que reescreva o campo). Falha fechada, mas fechada contra o cliente
 * certo. Achado pela revisão de segurança de 2026-09-13.
 *
 * E O MERCADO É LIDO. O parâmetro estava na assinatura e não era usado: a
 * regra dos catorze dígitos é do Brasil. A Espanha só está a salvo hoje porque
 * `showsVenueTaxId('es')` é false — no dia em que for true, um NIF perfeito
 * seria silenciosamente apagado do recibo por uma regra brasileira.
 */
function documentoPublicavelDaCasa(marketCode, valor, mostraNesteMercado) {
  if (!mostraNesteMercado || !valor) return null;
  const texto = String(valor).trim();
  if (marketCode === 'es') {
    const nif = texto.replace(/[.\-\s]/g, '').toUpperCase();
    // A MESMA forma do portão de escrita — CIF ou NIE, nunca DNI. Estava
    // mais frouxa que a vizinha quarenta linhas acima, que recusa
    // `^\d{8}[A-Z]$` pelo nome ("documento de casa é documento de empresa"):
    // o lado que ESCREVE recusava e o lado que PUBLICA imprimiria. E agora
    // esta função também decide se a gorjeta corre. Um predicado, dois usos.
    return /^[ABCDEFGHJNPQRSUVW]\d{7}[A-Z0-9]$|^[XYZ]\d{7}[A-Z]$/.test(nif) ? nif : null;
  }
  const digitos = onlyDigits(texto);
  // Confere o DOCUMENTO, não a forma da string: catorze dígitos que não passam
  // no verificador não são um CNPJ, e pontuar isso no recibo é dar autoridade
  // a um número que ninguém checou.
  return isValidCNPJ(digitos) ? digitos : null;
}

/**
 * A DECISÃO do `POST /api/psp/recipient`, como função pura.
 *
 * Morava inline na rota, e por isso só dava pra "testar" com grep — o teste
 * afirmava que a string `recipient_doc_mismatch` existia no arquivo, e trocar
 * `!==` por `===` o deixava verde. O comentário do próprio teste dizia que
 * grep apresentado como invariante tinha sido o achado da rodada anterior.
 * Aqui a regra é executável, e o teste roda a regra.
 *
 * Três saídas, e a do meio é a que impede o portão de nascer desarmado:
 *   · documento inválido pro mercado da casa → recusa;
 *   · casa SEM documento → aceita e manda HERDAR, pra que o comprovante e a
 *     liquidação passem a ser o mesmo documento por construção;
 *   · casa COM documento → tem que ser o mesmo, comparado NORMALIZADO dos dois
 *     lados (no mercado espanhol o valor carrega letra, e `onlyDigits` de um
 *     lado só dava divergência eterna).
 */
function decidirDocumentoDoRecebedor({ enviado, venue }) {
  const market = (venue && venue.market) || 'br';
  const doc = normalizarDocumentoDaCasa(enviado, market);
  if (!doc.ok || !doc.valor) return { ok: false, code: 'tax_id_invalid' };
  if (!venue || !venue.cnpj) return { ok: true, valor: doc.valor, herdar: true };
  const guardado = normalizarDocumentoDaCasa(venue.cnpj, market);
  // O QUE ESTÁ GUARDADO PODE NÃO NORMALIZAR — e as linhas assim são
  // exatamente a população que este módulo diz existir: escritas antes do
  // portão de escrita, quando a rota guardava o que viesse. CPF, ressalva,
  // dígito trocado, espaço em branco.
  //
  // A versão anterior era `if (guardado.ok && guardado.valor && …)`: a forma
  // `if (thing && !ok)`. Com lixo na coluna a comparação não rodava e a
  // função devolvia `ok: true, herdar: false` — o controle que existe pra
  // impedir "o CPF de um garçom, o de um gerente" virar o alvo da liquidação
  // ficava DESLIGADO justamente nas linhas pra que foi escrito, e `herdar:
  // false` deixava o lixo lá, então a casa nunca saía desse estado. Regressão
  // que o conserto do mercado espanhol abriu no brasileiro. Achado pela
  // revisão de segurança de 2026-09-13.
  //
  // Agora HERDA por cima: o que estava guardado não era documento, então não
  // há com o que comparar, e o documento conferido do recebedor passa a ser o
  // da casa. Fecha o estado em vez de recusar pra sempre uma casa que não tem
  // como se consertar sozinha.
  if (!guardado.ok || !guardado.valor) return { ok: true, valor: doc.valor, herdar: true };
  if (doc.valor !== guardado.valor) return { ok: false, code: 'recipient_doc_mismatch' };
  return { ok: true, valor: doc.valor, herdar: false };
}

module.exports = {
  onlyDigits, isValidCPF, isValidCNPJ, docKind, isValidCpfCnpj,
  normalizarDocumentoDaCasa, documentoPublicavelDaCasa, decidirDocumentoDoRecebedor,
};
