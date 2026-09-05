// Minimal fal.ai runner: queue → poll → download. Prints cost-relevant info.
const KEY = process.env.FAL_KEY;
const H = { 'Authorization': `Key ${KEY}`, 'Content-Type': 'application/json' };

export async function run(model, input) {
  const q = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST', headers: H, body: JSON.stringify(input),
  });
  if (!q.ok) throw new Error(`${model} queue ${q.status}: ${await q.text()}`);
  const { status_url, response_url } = await q.json();
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await (await fetch(status_url, { headers: H })).json();
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED' || s.error) throw new Error(`failed: ${JSON.stringify(s).slice(0, 400)}`);
    if (i === 299) throw new Error('timeout');
  }
  return (await fetch(response_url, { headers: H })).json();
}

export async function save(url, path) {
  const r = await fetch(url);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, Buffer.from(await r.arrayBuffer()));
  return path;
}

export async function balance() {
  const r = await fetch('https://rest.alpha.fal.ai/billing/user_balance', { headers: H });
  return parseFloat(await r.text());
}
