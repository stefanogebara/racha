import { run, save, balance } from './gen.mjs';
import { SUBJECTS } from './subjects.js';
import { STYLE } from './style.js';
const SP = process.env.SP;

// A relief print is stamped ink on flat paper: it has no cast shadow and no
// perspective ground. Saying so kills the drop shadow the chopp came back with.
const FLAT = 'The print is flat on the paper: NO cast shadow, NO drop shadow, NO ground, NO surface it sits on, NO perspective.';

const b0 = await balance();
const only = process.argv.slice(2);
const keys = only.length ? only : Object.keys(SUBJECTS);
for (const key of keys) {
  const out = await run('fal-ai/flux/dev', {
    prompt: `A single ${SUBJECTS[key]}, alone, centred on plain cream paper with a generous empty margin all around it. ${FLAT} ${STYLE}`,
    image_size: 'square_hd', num_inference_steps: 45, guidance_scale: 6.0, seed: 71317, num_images: 2,
  });
  for (const [i, img] of out.images.entries()) await save(img.url, `${SP}/fal/raw/${key}-${i}.png`);
  console.log('ok', key);
}
await new Promise(r => setTimeout(r, 15000));
console.log(`gasto: $${(b0 - await balance()).toFixed(3)} | saldo $${(await balance()).toFixed(3)}`);
