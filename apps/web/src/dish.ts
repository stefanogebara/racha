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

/**
 * As palavras são de DUAS cozinhas.
 *
 * Os catorze blocos da decisão #33 não são brasileiros — são carne, peixe,
 * massa, tapa, salada, café. O que era brasileiro eram as palavras-chave, e
 * numa mesa de Madrid isso significava uma conta sem ilustração nenhuma:
 * "Jamón ibérico", "Croquetas", "Caña" não casam com nada em português.
 * Visto na tela, com a conta espanhola inteira sem figura.
 *
 * Então as listas ganharam o espanhol ao lado do português, na MESMA categoria
 * — não um segundo conjunto de blocos. `petisco` recebe "tapa" e "croqueta",
 * `cerveja` recebe "caña", `couvert` recebe "cubierto" e "pan". É o mesmo
 * desenho servindo as duas casas, que é o ponto de um conjunto entalhado.
 */
const KEYWORDS: [Carved, string[]][] = [
  ['carne', ['picanha', 'fraldinha', 'alcatra', 'contra file', 'maminha', 'cupim', 'costela',
             'linguica', 'bife', 'file mignon', 'churrasco', 'hamburguer', 'burger', 'frango',
             'bacon', 'carne', 'parmegiana', 'espetinho', 'porco', 'pernil', 'steak',
           // espanhol
           'jamon', 'jamon iberico', 'chuleton', 'solomillo', 'lomo', 'chorizo', 'morcilla', 'albondigas', 'ternera', 'cerdo', 'cordero', 'pollo', 'entrecot', 'secreto', 'presa iberica', 'carrillera', 'rabo de toro']],
  ['peixe', ['salmao', 'tilapia', 'bacalhau', 'camarao', 'polvo', 'lula', 'sushi', 'sashimi',
             'temaki', 'peixe', 'moqueca', 'ostra', 'atum', 'ceviche', 'robalo',
           // espanhol
           'pulpo', 'gambas', 'boquerones', 'anchoas', 'bacalao', 'merluza', 'dorada', 'lubina', 'calamares', 'chipirones', 'mejillones', 'almejas', 'marisco', 'atun', 'salmon', 'pescado', 'sardinas']],
  ['massa', ['pizza', 'massa', 'macarrao', 'espaguete', 'spaghetti', 'nhoque', 'gnocchi',
             'lasanha', 'ravioli', 'penne', 'risoto', 'risotto', 'talharim',
           // espanhol
           'paella', 'fideua', 'arroz negro', 'pasta', 'canelones', 'macarrones']],
  ['petisco', ['pastel', 'coxinha', 'bolinho', 'porcao', 'isca', 'batata frita', 'batata rustica',
               'batata', 'onion rings', 'petisco', 'tabua', 'bruschetta', 'croquete', 'dadinho',
               'torresmo', 'calabresa', 'aperitivo', 'fritas',
             // espanhol
             'tapa', 'tapas', 'racion', 'croqueta', 'croquetas', 'tortilla', 'patatas bravas', 'patatas', 'pimientos', 'pincho', 'pinchos', 'montadito', 'empanadilla', 'aceitunas', 'tabla', 'queso']],
  ['salada', ['salada', 'caesar', 'rucula', 'caprese', 'folhas', 'tabule',
            // espanhol
            'ensalada', 'ensaladilla', 'gazpacho', 'salmorejo', 'pipirrana']],
  ['acompanhamento', ['arroz', 'feijao', 'farofa', 'vinagrete', 'pure', 'mandioca', 'aipim',
                      'polenta', 'pao de alho', 'guarnicao', 'queijo coalho',
                    // espanhol
                    'guarnicion', 'pan con tomate', 'alioli', 'verduras', 'setas', 'pimientos de padron']],
  ['sobremesa', ['sobremesa', 'pudim', 'petit gateau', 'brownie', 'sorvete', 'acai', 'mousse',
                 'cheesecake', 'torta', 'bolo', 'doce', 'brigadeiro', 'banoffee',
               // espanhol
               'postre', 'flan', 'crema catalana', 'tarta', 'churros', 'helado', 'natillas', 'arroz con leche', 'torrija']],
  ['cerveja', ['chopp', 'chope', 'cerveja', 'brahma', 'heineken', 'budweiser', 'spaten', 'ipa',
               'pilsen', 'lager', 'long neck', 'longneck', 'stella', 'corona', 'beer',
             // espanhol
             'cana', 'canas', 'tercio', 'jarra', 'clara', 'mahou', 'estrella', 'alhambra', 'cruzcampo']],
  ['drink', ['caipirinha', 'caipiroska', 'gin', 'tonica', 'drink', 'coquetel', 'cocktail',
             'whisky', 'vodka', 'aperol', 'spritz', 'negroni', 'moscow mule', 'margarita',
             'cachaca', 'dose', 'shot', 'mojito', 'batida', 'rum', 'tequila',
           // espanhol
           'copa', 'cubata', 'ginebra', 'vermut', 'vermuth', 'chupito', 'sangria', 'tinto de verano', 'ron', 'orujo', 'pacharan']],
  ['vinho', ['vinho', 'malbec', 'cabernet', 'merlot', 'chardonnay', 'sauvignon', 'espumante',
             'prosecco', 'champagne', 'tannat', 'rose',
           // espanhol
           'rioja', 'ribera', 'albarino', 'verdejo', 'tempranillo', 'cava', 'jerez', 'fino', 'manzanilla', 'tinto', 'blanco', 'vino']],
  ['refrigerante', ['coca', 'guarana', 'refrigerante', 'sprite', 'fanta', 'agua com gas',
                    'agua', 'h2oh', 'soda', 'tonica lata',
                  // espanhol
                  'refresco', 'agua mineral', 'gaseosa', 'aquarius', 'nestea', 'con gas', 'sin gas']],
  ['cafe', ['cafe', 'espresso', 'expresso', 'cappuccino', 'latte', 'macchiato', 'cortado', 'cha',
          // espanhol
          'cafe con leche', 'cortado', 'carajillo', 'descafeinado', 'te', 'infusion']],
  ['suco', ['suco', 'vitamina', 'smoothie', 'limonada', 'agua de coco', 'laranja',
          // espanhol
          'zumo', 'zumo de naranja', 'batido', 'granizado']],
  ['couvert', ['couvert', 'pao', 'entrada',
             // espanhol
             'cubierto', 'pan', 'aperitivo de la casa']],
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
