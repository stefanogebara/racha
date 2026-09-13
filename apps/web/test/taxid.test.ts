import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatTaxId, isValidCpfCnpj, docKind } from '../src/br.ts';

/**
 * O documento da casa chega ao cliente LEGÍVEL.
 *
 * O comprovante e o aviso de privacidade imprimiam `65087663000130` — catorze
 * dígitos crus, num papel que a pessoa pode guardar. A landing mostrava o mesmo
 * documento formatado, e só porque alguém tinha digitado os pontos à mão: não
 * existia formatador no repositório inteiro. Achado testando a plataforma no
 * navegador, 2026-09-13.
 */

test('CNPJ e CPF ganham a pontuação que um humano escreve', () => {
  assert.equal(formatTaxId('65087663000130'), '65.087.663/0001-30');
  assert.equal(formatTaxId('52998224725'), '529.982.247-25');
  // Já pontuado não duplica pontuação.
  assert.equal(formatTaxId('65.087.663/0001-30'), '65.087.663/0001-30');
});

test('INCOMPLETO volta cru — a máscara do br.ts é progressiva e aqui isso é errado', () => {
  // `maskCpfCnpj` formata entrada parcial de propósito: é máscara de CAMPO.
  // Num recibo, `65.087.663/0001` (doze dígitos) pareceria um documento de
  // verdade. A política daqui só deixa passar o que está completo.
  assert.equal(formatTaxId('650876630001'), '650876630001');
  assert.equal(formatTaxId('5299822472'), '5299822472');
});

test('o que não se reconhece volta como veio — nunca meio formatado', () => {
  // Documento mal formatado num recibo é pior que documento sem pontos, e a
  // migração 0002 já decidiu que documento de MENTIRA é pior que a ausência.
  for (const estranho of ['123', '', '  ', 'abc']) {
    assert.equal(formatTaxId(estranho), estranho.trim() ? estranho.trim() : '');
  }
  assert.equal(formatTaxId(null), '');
  assert.equal(formatTaxId(undefined), '');
});

test('o MERCADO decide o formato, não o idioma de quem lê', () => {
  // Na Espanha o NIF é `B12345678`: letra e oito dígitos, sem pontuação.
  // Pontuá-lo seria inventar um formato que o país não usa.
  assert.equal(formatTaxId('b12345678', 'es'), 'B12345678');
  assert.equal(formatTaxId('65087663000130', 'br'), '65.087.663/0001-30');
});

/**
 * ── O CENSO ────────────────────────────────────────────────────────────────
 *
 * A primeira versão deste censo casava com A LINHA QUE EU TINHA ACABADO DE
 * CONSERTAR, não com a classe. A revisão de segurança provou por mutação: sete
 * ofensores diferentes passavam verdes. Os mecanismos, todos da mesma família:
 *
 *   · `!/\w+=\{/` era de LINHA, não de POSIÇÃO — qualquer atributo com chaves
 *     em qualquer lugar da linha (`style={{…}}`) desligava a regra inteira. A
 *     dispensa pra "passar adiante como prop" dispensava também IMPRIMIR;
 *   · o padrão fixava `{taxId}`/`{venue.taxId}`, e `{venue?.taxId}` — o idioma
 *     que este próprio arquivo usa noutro lugar — não casava. Nem apelido;
 *   · `readdirSync` não era recursivo: o primeiro `src/components/` levava o
 *     censo inteiro embora, em silêncio;
 *   · `i18n.ts` era pulado INTEIRO, e o CLAUDE.md manda toda string de usuário
 *     passar por lá. O censo era cego exatamente onde o próximo ofensor está
 *     instruído a morar;
 *   · a dispensa de `exemplo|placeholder` também era de linha: bastava a
 *     palavra num comentário JSX ao lado;
 *   · e só conhecia a forma do CNPJ — um CPF pontuado à mão não era da classe,
 *     embora o `formatTaxId` prometa cuidar dele.
 *
 * O conserto é estrutural em três pontos: as dispensas viraram POSICIONAIS
 * (recorta-se o vão do atributo antes de olhar o resto), o censo virou uma
 * FUNÇÃO PURA, e essa função é exercitada contra um corpo de ofensores
 * conhecidos — não só contra a árvore de hoje, que passa por construção. Uma
 * mutação de controle prova que o assert está ligado; ela não prova que o
 * padrão cobre a classe.
 */

/** Vãos de atributo: `className={…}`, `style={{…}}`, `taxId={venue.taxId}`. */
const VAO_DE_ATRIBUTO = /\w+=\{(?:[^{}]|\{[^{}]*\})*\}/g;
/** Literais de string — em `i18n.ts` TUDO é literal, e `{taxId}` lá é buraco de frase. */
const LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const CNPJ_PONTUADO = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
const CPF_PONTUADO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/;

function semComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * O censo, como função. `arquivo` só entra na mensagem — a regra não olha o
 * nome de arquivo nenhum, que é justamente o que a versão anterior fazia.
 */
/**
 * O que NÃO é impressão, embora se escreva com chaves.
 *
 * TypeScript usa `{}` pra três coisas que não põem nada na tela: anotação de
 * tipo (`{ taxId?: string | null }`), desestruturação de parâmetro
 * (`{ venue, taxId, market }`) e chave escapada dentro de um literal de regex
 * (`/\(\{taxId\}\)/`, no `PrivacyNotice`, que REMOVE o buraco da frase). Um
 * censo que confunde tipo com JSX é um censo que vai ser desligado por quem
 * cansar dele — e censo desligado é a origem de metade desta lista.
 */
function naoEImpressao(trecho: string, antes: string): boolean {
  if (/\\/.test(trecho)) return true;                    // `\{taxId\}` — literal de regex
  if (/;/.test(trecho)) return true;                      // `{ a: string; b: number }`
  if (/:\s*(string|number|boolean|null|undefined|unknown|any)\b/.test(trecho)) return true;
  if (/^\{[\s\w]+,[\s\w,]*\}$/.test(trecho)) return true;   // `{ venue, taxId, market }`
  if (/[(,=]\s*$/.test(antes)) return true;                // posição de parâmetro/atribuição
  return false;
}

export function ofensoresEm(arquivo: string, bruto: string): string[] {
  const achados: string[] = [];
  const linhas = semComentarios(bruto).split('\n');
  linhas.forEach((linha, i) => {
    const onde = `${arquivo}:${i + 1}`;
    // Recorta o vão do atributo PRIMEIRO: o que sobra é posição de texto.
    const fora = linha.replace(VAO_DE_ATRIBUTO, ' ');

    // A. IMPRESSÃO. Interpolação em posição de texto que leia `taxId` tem que
    //    passar pelo formatador. Literais são mascarados: `{taxId}` dentro de
    //    uma frase do dicionário é o buraco que o chamador preenche.
    const emTexto = fora.replace(LITERAL, (m) => ' '.repeat(m.length));
    for (const m of emTexto.matchAll(/\{[^{}]*\btaxId\b[^{}]*\}/g)) {
      if (naoEImpressao(m[0], emTexto.slice(0, m.index))) continue;
      if (!/formatTaxId/.test(m[0])) achados.push(`${onde} imprime cru: ${m[0].slice(0, 60)}`);
    }

    // B. APELIDO. `const doc = venue.taxId` e depois `{doc}` escapava da regra
    //    A inteira — a impressão não menciona `taxId`. Então a leitura é que
    //    tem que passar pelo formatador. Guarda de verdade (`venue.taxId &&`)
    //    não é atribuição e não cai aqui.
    //
    //    A janela é de três linhas porque a atribuição pode ser um ternário
    //    quebrado (é o caso do `PrivacyNotice`: o `const` numa linha, o
    //    `formatTaxId` na seguinte). Linha a linha, isso era falso positivo —
    //    e o jeito de tirar um falso positivo é dispensar a CLASSE inteira,
    //    que é como os buracos entram.
    const apelido = /\b(?:const|let|var)\s+[\w\s,:]+=\s*[^=;]*\btaxId\b/.exec(fora);
    const janela = linhas.slice(i, i + 3).join('\n');
    if (apelido && !/formatTaxId/.test(janela)) {
      achados.push(`${onde} apelida sem formatar: ${apelido[0].trim().slice(0, 60)}`);
    }

    // C. DOCUMENTO PONTUADO À MÃO. A dispensa é POSICIONAL: só vale se o
    //    documento estiver DENTRO de um `placeholder=`, que ensina o formato.
    //    A versão anterior aceitava a palavra "exemplo" em qualquer lugar da
    //    linha, comentário JSX ao lado inclusive.
    const semPlaceholder = linha.replace(/placeholder=(?:"[^"]*"|'[^']*'|\{[^{}]*\})/g, ' ');
    if (CNPJ_PONTUADO.test(semPlaceholder)) achados.push(`${onde} CNPJ pontuado à mão`);
    if (CPF_PONTUADO.test(semPlaceholder)) achados.push(`${onde} CPF pontuado à mão`);
  });
  return achados;
}

function todosOsFontes(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...todosOsFontes(p, base));
    else if (/\.tsx?$/.test(e.name)) out.push(p.slice(base.length + 1));
  }
  return out;
}

test('o censo reconhece os sete desvios que a revisão provou por mutação', () => {
  // Cada um destes PASSAVA VERDE na versão anterior. Se algum voltar a passar,
  // o padrão encolheu de volta pra linha que eu estava olhando.
  const desvios = [
    ['atributo na linha desliga a regra', '<span style={{ fontWeight: 600 }}>{venue.taxId}</span>'],
    ['encadeamento opcional', '      {venue?.taxId}'],
    ['apelido', '  const doc = venue.taxId;'],
    ['CPF à mão', '      <p>Racha · CPF 529.982.247-25</p>'],
    ['CNPJ à mão numa frase do dicionário', "  'foot.cnpj': { en: 'CNPJ 65.087.663/0001-30', pt: 'CNPJ 65.087.663/0001-30' },"],
    ['a palavra exemplo num comentário ao lado', '  Racha · CNPJ 65.087.663/0001-30 {/* exemplo do rodapé */}'],
    ['cru e simples', '      {taxId}'],
  ];
  for (const [nome, linha] of desvios) {
    assert.ok(ofensoresEm('mutante.tsx', linha).length > 0, `desvio não pego: ${nome} → ${linha}`);
  }
});

test('o censo absolve o que é legítimo — dispensa não é buraco', () => {
  const legitimos = [
    ['prop passada adiante', '      <PrivacyNotice taxId={venue.taxId} market={venue.market} />'],
    ['formatado em posição de texto', '        <p className="muted small center">{formatTaxId(venue.taxId, venue.market)}</p>'],
    ['guarda de verdade', '      {venue.taxId && ('],
    ['buraco de frase no dicionário', "  'priv.doc': { en: 'CNPJ {taxId}', pt: 'CNPJ {taxId}', es: 'NIF {taxId}' },"],
    ['formato ENSINADO num placeholder', '        <input placeholder="00.000.000/0000-00" inputMode="numeric" />'],
    ['declaração de tipo', '  taxId: string | null;'],
  ];
  for (const [nome, linha] of legitimos) {
    assert.deepEqual(ofensoresEm('ok.tsx', linha), [], `falso positivo: ${nome}`);
  }
});

test('nenhuma tela imprime o documento da casa sem passar pelo formatador', () => {
  const src = join(import.meta.dirname, '..', 'src');
  // `i18n.ts` NÃO é pulado: o CLAUDE.md manda toda string de usuário morar lá,
  // e o censo tem que enxergar onde o próximo ofensor está instruído a nascer.
  const arquivos = todosOsFontes(src);
  // Um censo que anda em zero arquivos passa calado. E a recursão é o ponto:
  // o primeiro `src/components/` levava a versão anterior embora.
  assert.ok(arquivos.length > 10, `só ${arquivos.length} arquivos — o censo parou de andar`);
  const ofensores = arquivos.flatMap((f) => ofensoresEm(f, readFileSync(join(src, f), 'utf8')));
  assert.deepEqual(ofensores, [], `\n${ofensores.join('\n')}\n`);
});

test('servidor e cliente conferem o MESMO documento', () => {
  // A conferência de CPF/CNPJ existe dos dois lados e os runtimes não
  // compartilham módulo (CommonJS × TS/ESM). O que impede a divergência é o
  // fixture: os dois testes rodam contra ele. Ver api/_lib/br/documento.js.
  const fixture = JSON.parse(readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'api', '_lib', 'br', 'documentos.fixture.json'), 'utf8'));
  for (const v of fixture.validos) {
    assert.ok(isValidCpfCnpj(v.doc), `${v.doc} devia ser válido no cliente também`);
    assert.equal(docKind(v.doc), v.tipo, `${v.doc}: tipo divergente`);
  }
  for (const v of fixture.invalidos) {
    assert.ok(!isValidCpfCnpj(v.doc), `${v.doc} devia ser recusado no cliente também (${v.porque})`);
  }
  assert.ok(fixture.validos.length >= 6 && fixture.invalidos.length >= 6);
});
