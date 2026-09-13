'use strict';
/**
 * Gera `ios/Racha/Agent/ClaimPatterns.swift` a partir do `claims.json`.
 *
 * Os dois guardas da mesma política — o censo de build (Node) e a revisão de
 * runtime (Swift) — precisam dos MESMOS padrões, e a v3 os tinha escrito duas
 * vezes à mão. Já tinham divergido em quatro tokens no commit cujo teste dizia
 * impedir isso: `couvert art` e `\bmoço` só no JSON, `sai por folha` e a
 * alternativa do `CNPJ` só no JSON — e o efeito não é simétrico. Uma frase
 * pegada no build e não no runtime passa viva pro cliente; uma frase exempta
 * no build e acusada no runtime faz o guarda REESCREVER texto correto.
 *
 * Um teste comparando comportamento não fecharia isso (NSRegularExpression e
 * RegExp divergem em construções), então o Swift deixa de ter cópia: ele é
 * gerado, e o `claims.test.js` falha se o arquivo no disco não for o que este
 * script produz — a mesma forma da reprodutibilidade do `racha-ios.html`.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const G = JSON.parse(fs.readFileSync(path.join(RAIZ, 'docs', 'compliance', 'claims.json'), 'utf8')).gorjeta_destino;

/** Literal de string Swift, com as barras e aspas escapadas. */
const lit = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function gerar() {
  return `// GERADO por scripts/gen-claim-patterns.js — NÃO EDITE À MÃO.
//
// A fonte é docs/compliance/claims.json. O censo de build e este guarda de
// runtime têm que aplicar a MESMA regra; escrever os padrões duas vezes já os
// fez divergir em quatro tokens, e a divergência não é simétrica — o que o
// build pega e o runtime não, chega ao cliente.
//
// Pra mudar a regra: edite o JSON e rode \`node scripts/gen-claim-patterns.js\`.
// O \`api/__tests__/claims.test.js\` falha se este arquivo sair de sincronia.

import Foundation

enum ClaimPatterns {
    static let substantivoGorjeta = ${lit(G.substantivo_gorjeta)}
    static let substantivoDestinatario = ${lit(G.substantivo_destinatario)}
    /// Mais curta: sem os pronomes que, na mesa, querem dizer os CLIENTES.
    /// Ver \`_porque_lista_runtime\` no claims.json.
    static let destinatarioRuntime = ${lit(G.substantivo_destinatario_runtime)}
    static let distribuidorComSujeito = ${lit(G.distribuidor_com_sujeito)}
    static let revogaDispensa = ${lit(G.revoga_dispensa)}
    /// Alta precisão, baixa cobertura. Oráculo de teste: ver claims.json.
    static let formaDirecional = ${lit(G.gatilho_forma_direcional)}
    /// A frase que o produto diz. Não é uma variação.
    static let sancionada = ${lit(G.frase_sancionada)}
}
`;
}

const ALVO = path.join(RAIZ, 'ios', 'Racha', 'Agent', 'ClaimPatterns.swift');
module.exports = { gerar, ALVO };
if (require.main === module) {
  fs.writeFileSync(ALVO, gerar());
  console.log('gerado', path.relative(RAIZ, ALVO));
}
