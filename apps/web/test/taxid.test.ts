import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatTaxId, isValidCpfCnpj, docKind } from '../src/br.ts';
// O censo mora em módulo próprio pra poder ser importado e MUTADO de fora —
// dentro do teste, importá-lo rodava a suíte. Ver o cabeçalho de lá.
import { ofensoresEm } from './censo-taxid.ts';

function todosOsFontes(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...todosOsFontes(p, base));
    else if (/\.tsx?$/.test(e.name)) out.push(p.slice(base.length + 1));
  }
  return out;
}

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

test('o censo reconhece os desvios que as revisões provaram por mutação', () => {
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
    // A SEGUNDA rodada. Os quatro primeiros foram ABERTOS pelo conserto dos
    // sete de cima: mascarar literais pra deixar o `i18n.ts` entrar no censo
    // apagou junto a única forma de literal que imprime.
    ['literal de crase', '      <p className="muted small">{`CNPJ ${taxId}`}</p>'],
    ['atributo de EXIBIÇÃO, não de passagem', '      <input className="doc" readOnly value={taxId ?? \'\'} />'],
    ['title=, que o navegador pinta', '      <abbr title={taxId ?? \'\'}>doc</abbr>'],
    ['ternário: tem `: null` e parecia anotação de tipo', '      <p>{taxId ? taxId : null}</p>'],
    ['contrabarra desligava a regra inteira', "      <p>{String(taxId).replace(/\\D/g, '')}</p>"],
    // Declaração MAIS leitura: a constante sozinha não imprime nada, e a regra
    // D segue o NOME justamente porque no `Home.tsx` real a declaração e o
    // `formatTaxId` estão a cem linhas de distância.
    ['documento cru em constante, lido sem formatar',
     "const RACHA_CNPJ = '65087663000130';\nexport const Rodape = () => <span>CNPJ {RACHA_CNPJ}</span>;"],
    ['documento cru escrito direto no JSX', '      <p className="legal">Racha · CNPJ 65087663000130</p>'],
    // A TERCEIRA rodada. As duas primeiras foram ABERTAS por consertos: a
    // máscara de literais (pra deixar o i18n.ts entrar) apagou a crase, e a
    // dispensa de "posição de parâmetro" era testada contra a linha crua —
    // então qualquer vírgula ou parêntese do TEXTO JSX a desarmava.
    ['vírgula no texto JSX desarmava a regra', '      <p>{venue.name}, {venue.taxId}</p>'],
    ['parêntese no texto JSX', '      <p>Racha ({venue.taxId})</p>'],
    ['expressão quebrada pelo prettier', '      <span>{\n        venue.taxId\n      }</span>'],
    ['`??` quebrado em duas linhas', "      <p>{venue.taxId ??\n        ''}</p>"],
    ['defaultValue — pinta e era tratado como passagem de prop', '      <input defaultValue={taxId} />'],
    ['placeholder DINÂMICO (o estático ensina; este afirma)', '      <input placeholder={venue.taxId} />'],
  ];
  for (const [nome, linha] of desvios) {
    assert.ok(ofensoresEm('mutante.tsx', linha).length > 0, `desvio não pego: ${nome} → ${linha}`);
  }
});

test('o produto cartesiano: todo PREFIXO × toda forma de IMPRIMIR é pego', () => {
  // NOVE fugas já foram consertadas uma a uma neste arquivo, e a décima e a
  // décima-primeira estavam a uma vírgula e um dois-pontos da nona. Corrigir
  // a string exata do último escape nunca fecha a classe; enumerar o produto
  // cartesiano fecha. É a diferença entre remendar o lexema demonstrado e
  // cobrir a construção que o permite.
  // FATORADO em dois eixos independentes. A versão anterior misturava os dois
  // no mesmo `prefixos` — `'CNPJ: '` carregava o separador, `'{venue.name}, '`
  // carregava a interpolação irmã — e por isso o produto nunca os cruzava.
  // A décima-segunda fuga estava exatamente no cruzamento: uma interpolação
  // irmã desarmava o antídoto de JSX e o separador então dispensava a linha.
  // Misturar eixos num produto cartesiano é ter um produto de mentira.
  const irmaos = ['', '{venue.name}', "t('rcpt.docLabel')", '<b>{venue.name}</b>', '{fmt(venue.name)}'];
  const separadores = [' ', ': ', ':', ', ', ' = ', ') · ', ' · ', ' — '];
  const impressoes = [
    '{venue.taxId}', '{taxId}', '{venue?.taxId}', "{venue.taxId ?? ''}",
    '{`${venue.taxId}`}', '{String(venue.taxId)}',
  ];
  const escaparam: string[] = [];
  for (const irmao of irmaos) {
    for (const sep of separadores) {
      for (const imp of impressoes) {
        const linha = `      <p className="legal">${irmao}${sep}${imp}</p>`;
        if (!ofensoresEm('Rodape.tsx', linha).length) escaparam.push(linha.trim());
      }
    }
  }
  assert.deepEqual(escaparam, [],
    `\n${escaparam.length} de ${irmaos.length * separadores.length * impressoes.length} combinações escaparam:\n${escaparam.join('\n')}\n`);
});

test('o censo absolve o que é legítimo — dispensa não é buraco', () => {
  const legitimos = [
    ['prop passada adiante', '      <PrivacyNotice taxId={venue.taxId} market={venue.market} />'],
    ['formatado em posição de texto', '        <p className="muted small center">{formatTaxId(venue.taxId, venue.market)}</p>'],
    ['guarda de verdade', '      {venue.taxId && ('],
    ['buraco de frase no dicionário', "  'priv.doc': { en: 'CNPJ {taxId}', pt: 'CNPJ {taxId}', es: 'NIF {taxId}' },"],
    ['formato ENSINADO num placeholder', '        <input placeholder="00.000.000/0000-00" inputMode="numeric" />'],
    ['declaração de tipo', '  taxId: string | null;'],
    ['literal de regex que REMOVE o buraco', "    : t('priv.who', { venue }).replace(/\\s*\\(\\{taxId\\}\\)/, ''),"],
    ['crase sem taxId nenhum', '      <p>{`Mesa ${table.label}`}</p>'],
    ['o documento formatado, em crase', '      <p>{`CNPJ ${formatTaxId(venue.taxId)}`}</p>'],
    ['placeholder ESTÁTICO continua ensinando o formato', '        <input placeholder="00.000.000/0000-00" inputMode="numeric" />'],
    ['constante declarada e SEMPRE formatada (o Home.tsx de verdade)',
     "const RACHA_CNPJ = '65087663000130';\nexport const Rodape = () => <span>CNPJ {formatTaxId(RACHA_CNPJ)}</span>;"],
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

test('a política de PONTUAÇÃO é testada — sem isto, a regressão inteira volta em uma expressão', () => {
  // A revisão de segurança reverteu `br.ts` pro comportamento antigo
  // (`limpo.replace(/[^0-9]/g,'')`) e os oito testes deste arquivo passaram
  // verdes, com `CNPJ em analise 11222333000181` voltando a sair como
  // `11.222.333/0001-81`. Os casos de ressalva moravam no fixture, numa seção
  // que só o teste do SERVIDOR lia. O `'abc'` do teste acima passa nas duas
  // implementações — parecia cobertura e não era.
  const fixture = JSON.parse(readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'api', '_lib', 'br', 'documentos.fixture.json'), 'utf8'));
  const cruas: string[] = fixture.exibicao_nao_pontua.entradas;
  assert.ok(cruas.length >= 5);
  for (const entrada of cruas) {
    assert.equal(formatTaxId(entrada), entrada.trim(),
      `${JSON.stringify(entrada)} devia voltar cru — pontuar apaga a ressalva e veste o número de documento conferido`);
  }
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
