export const STYLE = [
  'Authentic Brazilian cordel xilogravura: a relief woodcut PRINTED from a carved block onto cream paper.',
  'CRITICAL: the object is a SOLID BLACK SILHOUETTE, filled completely with ink.',
  'There is NO white inside the object and NO thin outline around it.',
  'Every detail is WHITE PAPER GOUGED OUT of that black mass with a V-tool:',
  'short chopped parallel strokes, uneven, chunky, visibly hand-cut, breaking at the ends.',
  'Rough inking, slight over-inking at the edges, coarse and primitive.',
  'Folk art of Juazeiro do Norte, tradition of J. Borges.',
  'Absolutely no grey, no gradients, no pencil, no pen hatching, no vector cleanliness.',
  'No signature, no name, no text, no letters, no numbers, no border, no frame, no plate under it unless asked.',
].join(' ');
export const frame = (subject) =>
  `A single ${subject}, alone, centred on plain cream paper with generous empty margin all around it. ${STYLE}`;
export const OPTS = { image_size: 'square_hd', num_inference_steps: 45, guidance_scale: 6.0, seed: 71317 };
