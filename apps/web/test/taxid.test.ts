import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatTaxId } from '../src/br.ts';

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

test('nenhuma tela imprime o documento da casa sem passar pelo formatador', () => {
  // O censo que fecha a classe. `{venue.taxId}` cru numa tela é o defeito
  // original; a landing tinha a variante pior, com os pontos digitados no JSX.
  const src = join(import.meta.dirname, '..', 'src');
  const ofensores: string[] = [];
  for (const f of readdirSync(src).filter((f) => /\.tsx?$/.test(f))) {
    // O DICIONÁRIO tem `{taxId}` de propósito: é o buraco que o chamador
    // preenche, e é lá que o formatador entra. Excluí-lo é o que separa "a
    // frase tem um buraco" de "a tela imprime o cru".
    if (f === 'i18n.ts') continue;
    const texto = readFileSync(join(src, f), 'utf8');
    texto.split('\n').forEach((linha, i) => {
      const semComentario = linha.replace(/(^|[^:])\/\/.*$/, '$1');
      const t = semComentario.trim();
      // Comentário de bloco também: `/** Máscara: 00.000.000/0000-00 */`
      // DESCREVE o formato, não afirma um documento.
      if (!t || t.startsWith('*') || t.startsWith('/*')) return;
      // Interpolação numa POSIÇÃO DE TEXTO — não em atributo. `taxId={...}`
      // passando adiante como prop é legítimo: quem recebe é que formata.
      const emTexto = /(^|[>}\s])\{\s*(?:venue\.)?taxId\s*\}/.test(semComentario)
        && !/\w+=\{/.test(semComentario);
      if (emTexto && !/formatTaxId/.test(semComentario)) {
        ofensores.push(`${f}:${i + 1} ${semComentario.trim().slice(0, 70)}`);
      }
      // Documento pontuado escrito à mão numa tela. Exemplo de formato em
      // placeholder é outra coisa — ele ENSINA o formato, não afirma um
      // documento.
      if (/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(semComentario)
          && !/placeholder|ex\.:|e\.g\.|exemplo/i.test(semComentario)) {
        ofensores.push(`${f}:${i + 1} documento pontuado à mão`);
      }
    });
  }
  assert.deepEqual(ofensores, [], `\n${ofensores.join('\n')}\n`);
});
