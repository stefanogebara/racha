import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * UMA PALAVRA NÃO PODE APARECER ACENTUADA NUM LUGAR E CRUA NO OUTRO.
 *
 * Eu escrevi duas frases de erro em português e espanhol SEM acento — "Nao
 * conseguimos falar com o servico de login", "No se perdio nada" — porque as
 * estava passando por um script de shell e os acentos davam trabalho. Elas
 * ficaram no meio de seiscentas frases corretamente acentuadas, num produto
 * pago, e nada na suíte percebeu. Quem percebeu foi a revisão de compliance de
 * 2026-09-16 (LOW-A).
 *
 * ── POR QUE ESTE CENSO E NÃO UMA LISTA DE "PALAVRAS QUE TÊM ACENTO" ─────────
 * Uma lista dessas envelhece e é interminável. Este teste usa o próprio arquivo
 * como autoridade: agrupa as palavras pela forma SEM acento e reclama quando a
 * mesma palavra aparece das duas maneiras. "serviço" aparece dezenas de vezes
 * acentuado; um "servico" solto é erro de digitação por definição, e a prova
 * está no arquivo.
 *
 * Duas coisas tiveram que sair da conta pra ele valer alguma coisa:
 *
 *  · **Os marcadores.** `{bonus}` não é uma palavra; sem tirá-los, o censo
 *    acusava "bônus / bonus" por causa de `{paid} (pago) + {bonus} (bônus)`.
 *  · **Os pares mínimos de verdade.** Português e espanhol têm pares em que as
 *    duas formas são palavras diferentes e ambas certas — `a/à`, `está/esta`,
 *    `pago/pagó`. Ficam listados abaixo, um a um. Não é silêncio: é uma lista
 *    curta, fechada e legível, e um par novo obriga alguém a olhar e decidir.
 *
 * LIMITE DECLARADO: só pega palavra que JÁ existe acentuada em algum lugar. Uma
 * frase nova com uma palavra nova e sem acento passa — pra isso não há atalho.
 * O que ele garante é que o vocabulário do produto seja consistente consigo
 * mesmo, que é onde este erro nasce.
 */

const DICT = readFileSync(join(import.meta.dirname, '..', 'src', 'i18n.ts'), 'utf8');

/**
 * Os pares em que as DUAS formas são palavras legítimas.
 *
 * Português: artigo/crase, conjunção/verbo, pronome/advérbio interrogativo.
 * Espanhol: pretérito (`pagó`) contra substantivo (`pago`), e os interrogativos
 * com til diacrítico (`qué`, `dónde`, `quién`).
 */
const PARES_LEGITIMOS: Record<'pt' | 'es', string[]> = {
  pt: ['a', 'as', 'da', 'e', 'esta', 'pode', 'que', 'tem'],
  es: ['abono', 'cambio', 'cargo', 'cobro', 'como', 'completo', 'corto', 'donde',
    'el', 'esta', 'este', 'pago', 'paso', 'que', 'quien', 'registro', 'si'],
};

/** As frases de cada idioma, lidas das entradas `pt: '…'` / `es: '…'`. */
function frasesDe(lang: 'pt' | 'es'): string[] {
  const fora: string[] = [];
  for (const m of DICT.matchAll(new RegExp(`\\b${lang}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))) fora.push(m[1]);
  return fora;
}

/** A palavra sem os diacríticos — a chave do agrupamento. */
const semAcento = (p: string) => p.normalize('NFD').replace(/\p{M}/gu, '');
const temAcento = (p: string) => semAcento(p) !== p;

/** chave sem acento → formas encontradas. Marcadores `{…}` não são palavras. */
function formasPorChave(frases: string[]): Map<string, Set<string>> {
  const formas = new Map<string, Set<string>>();
  for (const frase of frases) {
    // `\p{L}`, e NÃO `[^\W\d_]`: em JavaScript o `\w` continua sendo ASCII
    // mesmo sob a flag `u`, então `[^\W\d_]` quebra "serviço" em "servi" e "o"
    // — e o censo passava a absolver justamente as palavras acentuadas que ele
    // existe pra vigiar. (Em Python o mesmo padrão é unicode-aware, que foi como
    // eu o escrevi errado aqui: a sonda que usei pra montar a lista de isenções
    // era em Python e encontrava os pares.)
    for (const palavra of frase.replace(/\{[^}]*\}/g, ' ').toLowerCase().match(/\p{L}+/gu) ?? []) {
      const chave = semAcento(palavra);
      if (!formas.has(chave)) formas.set(chave, new Set());
      formas.get(chave)!.add(palavra);
    }
  }
  return formas;
}

function divergentes(formas: Map<string, Set<string>>, isentos: string[]): string[] {
  const fora: string[] = [];
  for (const [chave, vistas] of formas) {
    if (isentos.includes(chave)) continue;
    if ([...vistas].some(temAcento) && [...vistas].some((p) => !temAcento(p))) {
      fora.push(`${chave}: ${[...vistas].sort().join(' / ')}`);
    }
  }
  return fora.sort();
}

for (const lang of ['pt', 'es'] as const) {
  test(`${lang}: nenhuma palavra aparece acentuada num lugar e crua no outro`, () => {
    const frases = frasesDe(lang);
    // O censo tem que ENXERGAR: um regex quebrado daria zero frases e ✓ sobre
    // nada. O dicionário tem centenas de entradas em cada idioma.
    assert.ok(frases.length > 200, `${lang}: só ${frases.length} frases lidas`);
    assert.deepEqual(divergentes(formasPorChave(frases), PARES_LEGITIMOS[lang]), []);
  });

  test(`${lang}: toda isenção é USADA — uma isenção órfã é uma regra que ninguém lê`, () => {
    // Se uma frase sumir e o par deixar de existir, a isenção vira folclore.
    const formas = formasPorChave(frasesDe(lang));
    const orfas = PARES_LEGITIMOS[lang].filter((chave) => {
      const vistas = formas.get(chave);
      return !vistas || ![...vistas].some(temAcento) || ![...vistas].some((p) => !temAcento(p));
    });
    assert.deepEqual(orfas, [], `isenções que não correspondem a par nenhum em ${lang}`);
  });
}

test('o censo ACUSA — medido sobre frase sintética, não plantada no arquivo', () => {
  // Plantar no arquivo de verdade e esquecer de tirar é como se desliga uma
  // guarda sem querer. Aqui a mesma conta roda sobre um par construído: é a
  // forma exata do erro que originou este arquivo.
  const achadas = divergentes(
    formasPorChave(['O serviço da equipe', 'Nao conseguimos falar com o servico de login']),
    PARES_LEGITIMOS.pt,
  );
  assert.deepEqual(achadas, ['servico: servico / serviço']);
});

test('e ABSOLVE um marcador com nome de palavra acentuada', () => {
  // `{bonus}` não é uma palavra; sem tirar os marcadores, o censo acusava
  // "bônus / bonus" por causa de `{paid} (pago) + {bonus} (bônus)`.
  const achadas = divergentes(formasPorChave(['Bônus promocional', '{paid} + {bonus} (bônus)']), []);
  assert.deepEqual(achadas, []);
});
