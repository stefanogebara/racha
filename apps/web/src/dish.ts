/**
 * De uma linha da conta pro bloco entalhado que a ilustra.
 *
 * Porte enxuto do `ItemCategorizer` do app iOS: mesmas palavras-chave, mesma
 * regra de desempate (a mais LONGA ganha, senão "água" engole "água de coco").
 * As máscaras são as mesmas 14 da decisão #33, servidas de `/carved/`.
 *
 * Sem bloco não é erro: `servico`, `taxa` e o que não casa não têm figura, e
 * inventar uma seria decoração. A linha simplesmente vem sem ilustração.
 */

export const CARVED = [
  'carne', 'peixe', 'massa', 'petisco', 'salada', 'acompanhamento', 'sobremesa',
  'cerveja', 'drink', 'vinho', 'refrigerante', 'cafe', 'suco', 'couvert',
] as const;
export type Carved = (typeof CARVED)[number];

const KEYWORDS: [Carved, string[]][] = [
  ['carne', ['picanha', 'fraldinha', 'alcatra', 'contra file', 'maminha', 'cupim', 'costela',
             'linguica', 'bife', 'file mignon', 'churrasco', 'hamburguer', 'burger', 'frango',
             'bacon', 'carne', 'parmegiana', 'espetinho', 'porco', 'pernil', 'steak']],
  ['peixe', ['salmao', 'tilapia', 'bacalhau', 'camarao', 'polvo', 'lula', 'sushi', 'sashimi',
             'temaki', 'peixe', 'moqueca', 'ostra', 'atum', 'ceviche', 'robalo']],
  ['massa', ['pizza', 'massa', 'macarrao', 'espaguete', 'spaghetti', 'nhoque', 'gnocchi',
             'lasanha', 'ravioli', 'penne', 'risoto', 'risotto', 'talharim']],
  ['petisco', ['pastel', 'coxinha', 'bolinho', 'porcao', 'isca', 'batata frita', 'batata rustica',
               'batata', 'onion rings', 'petisco', 'tabua', 'bruschetta', 'croquete', 'dadinho',
               'torresmo', 'calabresa', 'aperitivo', 'fritas']],
  ['salada', ['salada', 'caesar', 'rucula', 'caprese', 'folhas', 'tabule']],
  ['acompanhamento', ['arroz', 'feijao', 'farofa', 'vinagrete', 'pure', 'mandioca', 'aipim',
                      'polenta', 'pao de alho', 'guarnicao', 'queijo coalho']],
  ['sobremesa', ['sobremesa', 'pudim', 'petit gateau', 'brownie', 'sorvete', 'acai', 'mousse',
                 'cheesecake', 'torta', 'bolo', 'doce', 'brigadeiro', 'banoffee']],
  ['cerveja', ['chopp', 'chope', 'cerveja', 'brahma', 'heineken', 'budweiser', 'spaten', 'ipa',
               'pilsen', 'lager', 'long neck', 'longneck', 'stella', 'corona', 'beer']],
  ['drink', ['caipirinha', 'caipiroska', 'gin', 'tonica', 'drink', 'coquetel', 'cocktail',
             'whisky', 'vodka', 'aperol', 'spritz', 'negroni', 'moscow mule', 'margarita',
             'cachaca', 'dose', 'shot', 'mojito', 'batida', 'rum', 'tequila']],
  ['vinho', ['vinho', 'malbec', 'cabernet', 'merlot', 'chardonnay', 'sauvignon', 'espumante',
             'prosecco', 'champagne', 'tannat', 'rose']],
  ['refrigerante', ['coca', 'guarana', 'refrigerante', 'sprite', 'fanta', 'agua com gas',
                    'agua', 'h2oh', 'soda', 'tonica lata']],
  ['cafe', ['cafe', 'espresso', 'expresso', 'cappuccino', 'latte', 'macchiato', 'cortado', 'cha']],
  ['suco', ['suco', 'vitamina', 'smoothie', 'limonada', 'agua de coco', 'laranja']],
  ['couvert', ['couvert', 'pao', 'entrada']],
];

/** Sem acento e em minúscula: "Picanha na Chapa" e "picanha na chapa" casam igual. */
export function fold(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Palavra mais longa primeiro — "batata frita" tem que ganhar de "batata". */
const RANKED: [string, Carved][] = KEYWORDS
  .flatMap(([cat, words]) => words.map((w) => [fold(w), cat] as [string, Carved]))
  .sort((a, b) => b[0].length - a[0].length);

/** O bloco de uma linha, ou null quando não há figura honesta pra ela. */
export function dishFor(name: string): Carved | null {
  const n = fold(name);
  if (!n) return null;
  for (const [word, cat] of RANKED) if (n.includes(word)) return cat;
  return null;
}

/** A máscara é aplicada por CSS mask, então a tinta vem do texto ao redor. */
export function dishMask(cat: Carved): React.CSSProperties {
  const url = `url(/carved/${cat}.png)`;
  return { WebkitMaskImage: url, maskImage: url };
}
