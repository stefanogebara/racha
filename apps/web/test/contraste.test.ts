import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * O CENSO QUE OLHA PRA FORA — e o único que muda o futuro em vez do presente.
 *
 * `tokens.test.ts` prova que a folha é consistente CONSIGO MESMA: toda `var()`
 * tem declaração, toda declaração tem leitor. Ele passaria inteiro com a paleta
 * trocada por outra: nada nele sabe de onde os valores vieram, nem o que eles
 * prometem a quem lê a tela.
 *
 * Este arquivo prende as duas coisas que a folha AFIRMA em prosa e que, até
 * aqui, só a prosa segurava:
 *
 *  1. "Presence — os mesmos valores do `presence-system.css`" (styles.css:53).
 *     Dezoito tokens são cópia literal de outro repositório. Cópia sem censo
 *     não é sistema compartilhado, é coincidência com prazo de validade: o dia
 *     em que alguém ajustar um cinza aqui, os dois produtos divergem em
 *     silêncio e ninguém descobre até ver as duas telas lado a lado.
 *
 *  2. As RAZÕES de contraste escritas nos comentários — "3,54:1", "5,2:1",
 *     "3,98:1", "3,3:1". Elas justificam cada divergência deliberada do
 *     Presence, e eram números digitados à mão dentro de um comentário. Um
 *     comentário não reprova build. Aqui eles são CALCULADOS do valor que está
 *     na folha, contra a superfície onde a cor é de fato desenhada.
 *
 * O que este censo NÃO faz, dito porque a omissão importa: ele não descobre um
 * token NOVO que apareça no `presence-system.css`. A tabela abaixo é um
 * retrato, com data e caminho. Quando o arquivo original está na máquina, o
 * retrato é conferido contra ele; no CI não está, e aí a tabela responde
 * sozinha pelo que afirma.
 */

// ── Presence, retrato de 2026-09-21 ─────────────────────────────────────────
// Origem: ~/code/twin-me/src/styles/presence-system.css (bloco `:root`, 20
// tokens). Valores em minúsculas, como no original.
const PRESENCE: Record<string, string> = {
  '--ps-paper': '#f2f0eb',
  '--ps-raised': '#f8f7f3',
  '--ps-ink': '#161714',
  '--ps-graphite': '#666761',
  '--ps-faint': '#92938d',
  '--ps-rule': '#d4d2cb',
  '--ps-rule-strong': '#a6a59f',
  '--ps-blue': '#2f35ff',
  '--ps-blue-soft': '#e7e8ff',
  '--ps-coral': '#d75d45',
  '--ps-coral-soft': '#f4ded8',
  '--ps-moss': '#66745d',
  '--ps-font-ui': "'Manrope', 'Inter', system-ui, sans-serif",
  '--ps-font-story': "'Newsreader', Georgia, serif",
  '--ps-radius-control': '10px',
  '--ps-radius-field': '16px',
  '--ps-radius-card': '24px',
  '--ps-radius-panel': '28px',
  '--ps-radius-pill': '999px',
  '--ps-ease': 'cubic-bezier(.4, 0, .2, 1)',
};

/** Racha → Presence: o token daqui é cópia literal do token de lá. */
const ESPELHA: Record<string, string> = {
  '--papel': '--ps-paper',
  '--papel-alto': '--ps-raised',
  '--ink': '--ps-ink',
  '--grafite': '--ps-graphite',
  '--fio': '--ps-rule',
  '--fio-forte': '--ps-rule-strong',
  '--azul': '--ps-blue',
  '--azul-suave': '--ps-blue-soft',
  '--coral': '--ps-coral',
  '--coral-suave': '--ps-coral-soft',
  '--musgo': '--ps-moss',
  '--rad-s': '--ps-radius-control',
  '--rad-c': '--ps-radius-field',
  '--rad': '--ps-radius-card',
  '--rad-p': '--ps-radius-panel',
  '--rad-pill': '--ps-radius-pill',
  '--mola': '--ps-ease',
};

/**
 * AS DIVERGÊNCIAS, cada uma com o motivo e o número que a sustenta.
 *
 * Divergir do Presence é legítimo — o Racha usa estas cores em tamanhos e
 * papéis que o Presence não tem (uma frase que recusa um pagamento não é um
 * acento de 9px). O que não é legítimo é divergir em silêncio: sem esta lista,
 * "cópia literal" e "mudei e não contei" têm exatamente a mesma aparência.
 */
const DIVERGE: Record<string, string> = {
  '--faint':
    'escurecido de #92938d (2,72:1 sobre o papel, reprova em toda superfície) '
    + 'até 3,3:1 — o suficiente pro que a régua de componente cobre',
  '--fio-controle':
    'não existe no Presence: lá o campo tem preenchimento próprio, aqui a '
    + 'moldura é a única coisa que diz onde se digita (WCAG 1.4.11)',
  '--coral-texto':
    'o coral do Presence é acento de 9-10px; aqui carrega a frase que recusa '
    + 'um pagamento, e a régua vira a de texto (4,5:1)',
  '--musgo-texto': 'mesma razão do coral-texto, na pílula "paga"',
  '--musgo-suave': 'não existe no Presence: o fundo da pílula de recebido',
  '--fundo2': 'não existe no Presence: o chão do controle desativado',
  '--serif': 'mesma família do `--ps-font-story`, com a pilha escrita na forma daqui',
  '--ui': 'mesma família do `--ps-font-ui`, com a pilha escrita na forma daqui',
  '--erro': 'semântico: aponta pra `--coral-texto`', '--erro-fio': 'semântico: aponta pra `--coral`',
  '--erro-bg': 'semântico: aponta pra `--coral-suave`', '--ok': 'semântico: aponta pra `--musgo-texto`',
  '--ok-fio': 'semântico: aponta pra `--musgo`', '--ok-bg': 'semântico: aponta pra `--musgo-suave`',
  '--emcurso': 'semântico: aponta pra `--azul`', '--emcurso-bg': 'semântico: aponta pra `--azul-suave`',
};

// ── a folha ────────────────────────────────────────────────────────────────
const RAIZ = join(import.meta.dirname, '..', 'src');
const CSS = readFileSync(join(RAIZ, 'styles.css'), 'utf8');
const semComentario = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * As declarações de UM bloco, achado pelo token que só ele declara.
 *
 * Não é `:root` dos dois lados: o Presence declara os dele em
 * `.ps-system, .presence-shell` — o sistema de lá é uma casca que se veste,
 * o daqui é a página inteira. Procurar pelo token em vez de pelo seletor é o
 * que faz esta varredura sobreviver a essa diferença, e à próxima.
 */
function tokensDoBloco(css: string, marcador: string): Map<string, string> {
  const limpo = semComentario(css);
  const i = limpo.indexOf(marcador);
  assert.ok(i > 0, `\`${marcador}\` não encontrado`);
  const abre = limpo.lastIndexOf('{', i);
  const fecha = limpo.indexOf('}', i);
  assert.ok(abre > 0 && fecha > abre, `bloco de \`${marcador}\` malformado`);
  const m = new Map<string, string>();
  for (const l of limpo.slice(abre, fecha).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    m.set(l[1], l[2].trim());
  }
  return m;
}

/** `var(--x)` resolvido até chegar num valor literal. */
function resolve(tok: string, m: Map<string, string>, vistos = new Set<string>()): string {
  const v = m.get(tok);
  assert.ok(v !== undefined, `${tok} não é declarado no \`:root\``);
  const alvo = v.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/);
  if (!alvo) return v;
  assert.ok(!vistos.has(tok), `ciclo de \`var()\` em ${tok}`);
  vistos.add(tok);
  return resolve(alvo[1], m, vistos);
}

const RAIZ_TOKENS = tokensDoBloco(CSS, '--papel:');

// ── contraste, calculado ───────────────────────────────────────────────────
const canal = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function luminancia(hex: string): number {
  const p = hex.trim().replace('#', '').match(/../g);
  assert.ok(p && p.length === 3, `não é cor hexadecimal de 6 dígitos: ${hex}`);
  const [r, g, b] = p.map((x) => canal(parseInt(x, 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2.x, relação de contraste entre duas cores opacas. */
function razao(a: string, b: string): number {
  const [claro, escuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (claro + 0.05) / (escuro + 0.05);
}
const cor = (tok: string) => resolve(tok, RAIZ_TOKENS);
const entre = (a: string, b: string) => razao(cor(a), cor(b));

// ═══════════════════════════════════════════════════════════════════════════

test('todo token espelhado tem o valor exato do Presence', () => {
  const fora: string[] = [];
  for (const [aqui, la] of Object.entries(ESPELHA)) {
    const esperado = PRESENCE[la];
    assert.ok(esperado !== undefined, `${la} não está no retrato do Presence`);
    const tem = resolve(aqui, RAIZ_TOKENS);
    const igual = /^#/.test(esperado)
      ? tem.toLowerCase() === esperado.toLowerCase()
      : tem.replace(/["']/g, "'").replace(/\s+/g, ' ') === esperado.replace(/\s+/g, ' ');
    if (!igual) fora.push(`${aqui}: a folha tem \`${tem}\`, o Presence tem \`${esperado}\` (${la})`);
  }
  assert.deepEqual(fora, [],
    `\n${fora.join('\n')}\n\nOu o valor daqui voltou pro do Presence, ou a divergência é `
    + 'deliberada e entra em DIVERGE com o motivo. Divergir em silêncio é como os dois '
    + 'produtos param de ser o mesmo sistema.\n');
});

test('todo token da raiz é espelho OU divergência declarada', () => {
  const orfaos = [...RAIZ_TOKENS.keys()]
    .filter((t) => !(t in ESPELHA) && !(t in DIVERGE))
    .sort();
  assert.deepEqual(orfaos, [],
    `\n${orfaos.join('\n')}\nToken novo na raiz: diga de qual token do Presence ele é cópia `
    + '(ESPELHA) ou por que ele diverge (DIVERGE). O silêncio é a única resposta proibida.\n');
});

test('o retrato do Presence bate com o arquivo, quando ele está na máquina', () => {
  // No CI o twin-me não existe, e aí a tabela responde sozinha pelo que afirma.
  // Na máquina de quem edita, ela é conferida — que é onde a divergência nasce.
  const p = join(homedir(), 'code', 'twin-me', 'src', 'styles', 'presence-system.css');
  if (!existsSync(p)) {
    console.log('  › presence-system.css fora da máquina: retrato não conferido (esperado no CI)');
    assert.equal(Object.keys(PRESENCE).length, 20, 'o retrato encolheu sem ninguém ver');
    return;
  }
  const raiz = tokensDoBloco(readFileSync(p, 'utf8'), '--ps-paper:');
  const fora: string[] = [];
  for (const [t, v] of Object.entries(PRESENCE)) {
    const tem = raiz.get(t);
    if (tem === undefined) fora.push(`${t}: sumiu do presence-system.css`);
    else if (tem.replace(/\s+/g, ' ') !== v.replace(/\s+/g, ' ')) fora.push(`${t}: lá é \`${tem}\`, o retrato diz \`${v}\``);
  }
  const novos = [...raiz.keys()].filter((t) => !(t in PRESENCE));
  assert.deepEqual([...fora, ...novos.map((t) => `${t}: token NOVO no Presence, fora do retrato`)], [],
    '\nO Presence mudou. Atualize o retrato (e decida, por token, se o Racha acompanha).\n');
});

/**
 * AS RAZÕES QUE OS COMENTÁRIOS AFIRMAM, calculadas.
 *
 * Cada linha é um par que existe de verdade na tela, com a régua que se aplica
 * a ele — texto pequeno 4,5:1 (WCAG 1.4.3), componente e texto grande 3:1
 * (1.4.11 / 1.4.3). Onde o comentário cita um número, o número está aqui.
 */
const PARES: Array<[string, string, number, string]> = [
  // texto
  ['--ink', '--papel', 4.5, 'o texto da tela'],
  ['--ink', '--papel-alto', 4.5, 'o texto dentro do cartão'],
  ['--grafite', '--papel', 4.5, 'metadado e rótulo de campo'],
  ['--grafite', '--papel-alto', 4.5, 'rótulo dentro do cartão'],
  ['--coral-texto', '--papel-alto', 4.5, 'a frase que recusa um pagamento'],
  ['--coral-texto', '--coral-suave', 4.5, 'o erro dentro da própria pílula'],
  ['--musgo-texto', '--musgo-suave', 4.5, 'a pílula "paga" — o que o dono lê'],
  ['--emcurso', '--emcurso-bg', 4.5, 'a pílula do passo em curso'],
  // componente
  ['--fio-controle', '--papel', 3, 'a moldura do campo, por dentro'],
  ['--fio-controle', '--papel-alto', 3, 'a moldura do campo, contra o cartão'],
  ['--fio-controle', '--fundo2', 3, 'a moldura do campo sobre o chão desativado'],
  ['--faint', '--papel-alto', 3, 'o tique de uma caixa não marcada'],
  ['--erro-fio', '--papel', 3, 'a moldura de um campo inválido'],
  ['--erro-fio', '--papel-alto', 3, 'a moldura de um campo inválido, no cartão'],
  ['--azul', '--papel', 3, 'o foco do teclado'],
  ['--azul', '--papel-alto', 3, 'o foco do teclado, no cartão'],
];

test('cada par que existe na tela passa a régua que se aplica a ele', () => {
  const falhas = PARES
    .map(([a, b, min, quem]) => ({ a, b, min, quem, r: entre(a, b) }))
    .filter(({ r, min }) => r < min)
    .map(({ a, b, min, quem, r }) => `${a} sobre ${b} = ${r.toFixed(2)}:1, precisa de ${min}:1 — ${quem}`);
  assert.deepEqual(falhas, [],
    `\n${falhas.join('\n')}\n\nCalculado do valor que está na folha. Mudar a cor sem mudar `
    + 'este número não é uma opção — é por isso que ele não mora num comentário.\n');
});

/**
 * E O TEXTO MAIS BAIXO NÃO ENCOSTA NO DE CIMA.
 *
 * A escala tem três degraus (`--ink`, `--grafite`, `--faint`) e o motivo de o
 * `--faint` não ter subido até 4,5:1 está escrito na folha: subir encostaria
 * ele no grafite e a escala morreria. Isso também é verificável.
 */
test('a escala de três degraus continua tendo três degraus', () => {
  assert.ok(entre('--grafite', '--faint') >= 1.4,
    `--grafite e --faint estão a ${entre('--grafite', '--faint').toFixed(2)}:1 um do outro — `
    + 'a essa distância são a mesma cor com dois nomes, e a escala virou de dois degraus.');
});

/**
 * O FIO DE CAMPO É DE CAMPO, e o censo derruba quem esquecer.
 *
 * Esta é a regra que o conserto de 2026-09-21 instituiu, e sem esta varredura
 * ela vale só pros quatro seletores que existiam naquele dia: o quinto campo
 * nasceria com `--fio`, invisível a 1,33:1, e nada acusaria.
 *
 * `cursor: text` é como esta folha marca "aqui se digita" — a varredura usa o
 * que a própria folha já diz, em vez de uma lista paralela que envelhece.
 */
test('todo campo usa o fio regulado, e nenhum usa o decorativo', () => {
  const regras = [...semComentario(CSS).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), corpo: m[2] }));
  const campos = regras.filter(({ sel, corpo }) =>
    !sel.startsWith('@') && !/^\.landing/.test(sel)
    && (/cursor:\s*text/.test(corpo) || /^\.namefield\b/.test(sel)));
  assert.ok(campos.length >= 4, `só ${campos.length} campos achados — a varredura quebrou`);
  const erradas = campos
    .filter(({ corpo }) => /border:[^;]*var\(--fio\)/.test(corpo))
    .map(({ sel }) => sel);
  assert.deepEqual(erradas, [],
    `\n${erradas.join('\n')}\nCampo com \`--fio\`: 1,33:1 sobre o papel, e a moldura é a única `
    + 'coisa que diz onde se digita. Use `--fio-controle`.\n');
});

// ═══════════════════════════════════════════════════════════════════════════

test('o censo ENXERGA — medido sobre fonte sintética', () => {
  // Sem isto, um erro de recorte absolveria a folha inteira em silêncio, que é
  // a forma que este repositório já achou três vezes.
  assert.ok(RAIZ_TOKENS.size > 25, `só ${RAIZ_TOKENS.size} tokens na raiz — o recorte do bloco quebrou`);
  assert.equal(RAIZ_TOKENS.get('--fio'), '#D4D2CB');
  // o `resolve` atravessa apelido
  assert.equal(cor('--fio-controle'), cor('--faint'));
  assert.equal(cor('--erro'), cor('--coral-texto'));
  // a conta de contraste bate com os extremos conhecidos
  assert.equal(razao('#000000', '#ffffff').toFixed(0), '21');
  assert.equal(razao('#777777', '#777777').toFixed(0), '1');
  // e ACUSA: o valor que a folha tinha antes do conserto reprovava
  assert.ok(razao('#D4D2CB', '#F8F7F3') < 3, 'o `--fio` de antes passaria — a conta está errada');
  // a varredura de campo vê um campo plantado com o fio errado
  const plantado = '.campo-novo { border: 1px solid var(--fio); cursor: text; }';
  const achou = [...plantado.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /cursor:\s*text/.test(m[2]) && /border:[^;]*var\(--fio\)/.test(m[2]));
  assert.equal(achou.length, 1, 'a varredura de campo não vê um campo com o fio decorativo');
});
