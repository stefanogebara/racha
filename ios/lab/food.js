/* ═══════════════════════════════════════════════════════════════════════════
   XILOGRAVURA — the subjects, cut in relief.

   Twelve rounds of blind critique called the drawings the weakest thing here
   and, five times, the clearest sign of a machine. The last version answered
   that by tightening the line: one weight, one horizon, one viewpoint. It was
   better and it was still a line drawing, which is the form a generator
   reaches for by default. So this version changes the form.

   A woodcut is not a drawing of a thing; it is what survives after the block
   is cut away. That inverts everything below. A subject is a solid mass of
   ink. Detail is not added to it in black — it is *removed* from it in white,
   because a gouge takes ink away. Tone is not fine hatching but a run of
   chunky parallel gouges. The contour is faceted rather than smooth, because
   a blade travels in straight pushes and the block chips where it turns. And
   the ink never lays down perfectly, so a little of the paper comes through.

   That is also why it is the right form for this product specifically. The
   xilogravura of the Northeast is the folk print of cordel — the pamphlet
   literature sold at fairs — and a bar tab in Brazil belongs to the same
   world of cheap, printed, everyday paper as the cordel cover does. The
   previous set could have been drawn for a hotel in Copenhagen. This one
   could not.

   Everything is drawn in the unit square. The caller scales it. Detail drops
   by level, so the same recipe survives from a 38px row to a 340px plate.
   ═══════════════════════════════════════════════════════════════════════════ */

export const INK   = '#241E17';
export const PAPER = '#F9F5EC';

/* Optical frame. Every subject stands on BASE and reaches no higher than CAP,
   so a row of them shares a horizon.                                        */
export const CAP = 0.20, BASE = 0.850;

/* ── deterministic randomness ─────────────────────────────────────────────
   Same dish, same block, forever.                                          */
export const fnv = s => { let h = 0x811c9dc5; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* Level of detail. Below ~64px a gouge narrower than a pixel closes up and the
   block turns to a blot, so the small cut is the silhouette and the two or
   three gouges that carry the subject's identity — which is exactly what a
   printer cutting a small block would do.                                   */
function lodFor(S) { return S < 64 ? 0 : S < 200 ? 1 : 2; }

/* ── the block edge ───────────────────────────────────────────────────────
   Contours are faceted and slightly irregular. A blade cuts in straight
   pushes and the block chips where it turns, so a woodcut contour is a chain
   of short segments that do not quite line up — never a bezier. Every path
   below goes through `emit`, which densifies it and walks the points with
   `lineTo`, displacing each one along its normal by a deterministic wobble.  */

function emit(c, pts, close) {
  const a = c.__chip;
  const k = (c.__k = (c.__k | 0) + 1) * 2.399;
  c.beginPath();
  for (let i = 0; i < pts.length; i++) {
    let [x, y] = pts[i];
    if (a > 0) {
      const p = pts[(i - 1 + pts.length) % pts.length], n = pts[(i + 1) % pts.length];
      let dx = n[0] - p[0], dy = n[1] - p[1];
      const L = Math.hypot(dx, dy) || 1;
      // two octaves, so the wobble reads as grain rather than as a sine wave
      const w = Math.sin(i * 1.77 + k) * 0.62 + Math.sin(i * 0.53 + k * 1.9) * 0.38;
      x += (-dy / L) * w * a; y += (dx / L) * w * a;
    }
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  if (close) c.closePath();
}

/** Straight run, densified so the chip has somewhere to land. */
export function poly(c, pts, close = false) {
  const out = [];
  for (let i = 0; i < pts.length - (close ? 0 : 1); i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 26));
    for (let j = 0; j < n; j++) out.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]);
  }
  if (!close) out.push(pts[pts.length - 1]);
  emit(c, out, close);
}

/** Catmull-Rom, sampled to points — the curve is a guide, the cut is faceted. */
export function curve(c, pts, close = false) {
  const p = close ? [pts[pts.length - 1], ...pts, pts[0], pts[1]]
                  : [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  for (let i = 1; i < p.length - 2; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i], [x2, y2] = p[i + 1], [x3, y3] = p[i + 2];
    const n = Math.max(4, Math.round(Math.hypot(x2 - x1, y2 - y1) * 30));
    for (let j = 0; j < n; j++) {
      const t = j / n, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * x1) + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
        0.5 * ((2 * y1) + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3)]);
    }
  }
  emit(c, out, close);
}

export function ell(c, cx, cy, rx, ry, rot = 0) {
  const out = [], N = 76, cs = Math.cos(rot), sn = Math.sin(rot);
  for (let i = 0; i < N; i++) {
    const t = i / N * 6.28319, x = Math.cos(t) * rx, y = Math.sin(t) * ry;
    out.push([cx + x * cs - y * sn, cy + x * sn + y * cs]);
  }
  emit(c, out, true);
}

export function rrect(c, x, y, w, h, r) {
  const pts = [], arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= 5; i++) { const a = a0 + (a1 - a0) * i / 5;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  arc(x + w - r, y + r, -1.5708, 0); arc(x + w - r, y + h - r, 0, 1.5708);
  arc(x + r, y + h - r, 1.5708, 3.1416); arc(x + r, y + r, 3.1416, 4.7124);
  emit(c, pts, true);
}

/* ── the four marks ───────────────────────────────────────────────────────
   A relief block affords exactly these: ink left standing, ink taken away by
   a gouge, ink taken away in parallel runs, and ink that failed to transfer.  */

/** Ink left standing. The paper halo is the uncut channel a printer leaves
    between two forms so they do not run together on the sheet. */
/* Paper is not a colour: it is where the ink is not. Every mark that takes ink
   away erases the canvas, so whatever the block is printed on shows through.
   On cream stock this changes nothing; on a dark table it is the difference
   between a print and a sticker with a white halo around it. */
function erase(c, fn) { c.save(); c.globalCompositeOperation = 'destination-out'; fn(); c.restore(); }
const PAPER_FILL = '#000';   // any opaque colour: with destination-out only its alpha matters

export function block(c, shape) {
  shape(c);
  erase(c, () => { c.strokeStyle = PAPER_FILL; c.lineWidth = c.__cw * 4.2; c.stroke(); });
  c.fillStyle = c.__ink; c.fill();
}

/** A gouge: ink taken away. This is where detail lives now — a white line
    through the black, not a black line on the white. */
export function gouge(c, shape, k = 1) {
  if (c.__lod < 1) return;
  shape(c);
  erase(c, () => { c.strokeStyle = PAPER_FILL; c.lineWidth = c.__cw * 1.15 * k; c.lineCap = 'round'; c.stroke(); });
}

/** A gouge that survives the small cut, for the two or three lines that carry
    the subject's identity. */
export function keyGouge(c, shape, k = 1) {
  shape(c);
  erase(c, () => { c.strokeStyle = PAPER_FILL; c.lineWidth = c.__cw * 1.25 * k; c.lineCap = 'round'; c.stroke(); });
}

/** Tone: parallel gouges, clipped to a shape. Chunky and slightly uneven —
    the fine, even hatching of an engraving is a different tool entirely, and
    at this scale it is also the texture that reads as generated. */
export function cut(c, shape, { band = null } = {}) {
  if (c.__lod < 2) return;
  // One grammar for tone across the whole set: one gap, one angle, one width.
  // A recipe may say where the tone goes (the band); never what it looks like.
  const gap = 0.072, ang = -0.62, k = 1;
  c.save();
  shape(c); c.clip();
  if (band) { const [x0, y0, x1, y1] = band; c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip(); }
  c.translate(0.5, 0.5); c.rotate(ang); c.translate(-0.5, -0.5);
  c.globalCompositeOperation = 'destination-out'; c.strokeStyle = PAPER_FILL; c.lineCap = 'butt';
  let i = 0;
  for (let x = -0.7; x < 1.8; x += gap, i++) {
    // the run is not perfectly even: the blade wanders and the gouges vary
    const w = c.__cw * k * (0.78 + 0.5 * Math.abs(Math.sin(i * 2.3)));
    const j = Math.sin(i * 1.31) * gap * 0.13;
    c.lineWidth = w;
    c.beginPath(); c.moveTo(x + j, -0.7); c.lineTo(x - j, 1.8); c.stroke();
  }
  c.restore();
}

/** Ink that did not take. A few specks of paper coming through a black mass —
    the thing that says a block was pressed onto a sheet by hand. */
export function speck(c, shape, R, n = 26) {
  if (c.__lod < 2) return;
  c.save(); shape(c); c.clip();
  c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
  for (let i = 0; i < n; i++) {
    const x = R(), y = R(), r = 0.004 + R() * 0.008;
    c.beginPath();
    for (let j = 0; j < 5; j++) {                 // angular, not round
      const a = j / 5 * 6.283, rr = r * (0.6 + R() * 0.8);
      j ? c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr)
        : c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    c.closePath(); c.fill();
  }
  c.restore();
}

/** The ground: a bar, not a hairline. Every subject stands on the same one, at
    the same length — that shared horizon is most of what makes fourteen
    unrelated objects read as one set. */
export function ground(c) {
  if (c.__fit) return;             // paint() draws it after the subject is fitted
  c.fillStyle = c.__ink;
  const h = c.__cw * 1.5;
  c.fillRect(0.10, BASE - h / 2, 0.80, h);
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE BLOCKS

   Each is a side elevation standing on BASE, reaching no higher than CAP, no
   wider than 0.80 of the frame. Read them as a set: the only differences
   between two subjects should be the differences between the objects.
   ═══════════════════════════════════════════════════════════════════════════ */

const RECIPES = {};

/** Espetinho — three pieces on a skewer. The churrasco a Brazilian table
    actually sees, and unmistakable at any size. */
RECIPES.picanha = (c, R) => {
  const x0 = 0.165, y0 = BASE - 0.075, x1 = 0.855, y1 = CAP + 0.040;
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux, ang = Math.atan2(dy, dx);
  const at = (t, o = 0) => [x0 + ux * L * t + nx * o, y0 + uy * L * t + ny * o];
  // the spit, laid down first and buried by the meat
  block(c, k => poly(k, [at(-0.02, -0.011), at(1.02, -0.011),
                         at(1.02, 0.011), at(-0.02, 0.011)], true));
  [0.235, 0.500, 0.765].forEach((t, i) => {
    const [cx, cy] = at(t), w = 0.112 - i * 0.005, h = 0.086;
    const piece = k => { k.save(); k.translate(cx, cy); k.rotate(ang);
      curve(k, [[-w, 0], [-w * 0.70, -h], [0, -h * 1.16], [w * 0.72, -h * 0.94],
                [w, 0.008], [w * 0.68, h * 0.98], [0, h * 1.14], [-w * 0.70, h * 0.96]], true);
      k.restore(); };
    block(c, piece);
    // the fat cap, cut out of the top edge of each piece
    keyGouge(c, k => { k.save(); k.translate(cx, cy); k.rotate(ang);
      curve(k, [[-w * 0.66, -h * 0.56], [0, -h * 0.72], [w * 0.68, -h * 0.50]]);
      k.restore(); }, 1.3);
    cut(c, piece, { gap: 0.055, band: [cx - 0.02, cy - 0.005, 1, 1], k: 0.8 });
    speck(c, piece, R, 10);
  });
  ground(c);
};

/** Chopp — the beer is the black mass, the head is the paper. */
RECIPES.chopp = (c, R) => {
  const top = CAP + 0.045, bot = BASE - 0.012, hw = 0.150, hwT = 0.180;
  const glass = k => poly(k, [[0.5 - hwT, top], [0.5 + hwT, top],
                              [0.5 + hw, bot], [0.5 - hw, bot]], true);
  block(c, glass);
  const wAt = y => hwT + (hw - hwT) * ((y - top) / (bot - top));
  const foam = top + 0.150;
  // the head, taken out of the glass in one wide sweep — a gouge, not a shape
  if (c.__lod > 0) {
    c.save(); glass(c); c.clip(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
    const p = [[0.5 - hwT, top + 0.020], [0.5 + hwT, top + 0.020]];
    curve(c, [[0.5 + wAt(foam), foam - 0.010], [0.5 + 0.070, foam - 0.044],
              [0.5 - 0.010, foam + 0.006], [0.5 - 0.085, foam - 0.040],
              [0.5 - wAt(foam), foam - 0.006],
              [0.5 - hwT, top + 0.022], [0.5 + hwT, top + 0.022]], true);
    c.fill(); c.restore();
  }
  // the rim: a standing bar the head does not reach
  block(c, k => poly(k, [[0.5 - hwT, top], [0.5 + hwT, top],
                         [0.5 + hwT - 0.004, top + 0.026], [0.5 - hwT + 0.004, top + 0.026]], true));
  if (c.__lod >= 2) [[0.43, 0.28], [0.57, 0.44], [0.46, 0.60], [0.61, 0.74]]
    .forEach(([bx, bt]) => gouge(c, k => ell(k, bx, foam + 0.07 + bt * 0.24, 0.014, 0.014), 0.9));
  speck(c, glass, R, 16);
  ground(c);
};

/** Caipirinha — ice and lime cut white out of the drink. */
RECIPES.caipirinha = (c, R) => {
  const top = CAP + 0.115, bot = BASE - 0.012, hw = 0.148, hwT = 0.170;
  const glass = k => poly(k, [[0.5 - hwT, top], [0.5 + hwT, top],
                              [0.5 + hw, bot], [0.5 - hw, bot]], true);
  block(c, glass);
  const fill = top + 0.086;
  if (c.__lod > 0) {
    c.save(); glass(c); c.clip(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
    // the air above the drink
    poly(c, [[0.5 - hwT - 0.02, top + 0.024], [0.5 + hwT + 0.02, top + 0.024],
             [0.5 + hwT + 0.02, fill], [0.5 - hwT - 0.02, fill]], true); c.fill();
    // ice, gouged out of the drink
    rrect(c, 0.396, fill + 0.034, 0.102, 0.102, 0.012); c.fill();
    rrect(c, 0.512, fill + 0.126, 0.094, 0.094, 0.012); c.fill();
    c.restore();
    // the rim the air did not reach
    block(c, k => poly(k, [[0.5 - hwT, top], [0.5 + hwT, top],
                           [0.5 + hwT - 0.004, top + 0.026], [0.5 - hwT + 0.004, top + 0.026]], true));
    // lime straddling the rim: a black half-disc with its segments cut white
    const lx = 0.5 + hwT - 0.052, ly = top + 0.012;
    block(c, k => { const p = [];
      for (let i = 0; i <= 22; i++) { const a = Math.PI + Math.PI * i / 22;
        p.push([lx + Math.cos(a) * 0.092, ly + Math.sin(a) * 0.092]); }
      poly(k, p, true); });
    for (let i = 1; i < 4; i++) { const a = Math.PI * i / 4;
      gouge(c, k => poly(k, [[lx, ly], [lx - Math.cos(a) * 0.084, ly - Math.sin(a) * 0.084]]), 0.8);
    }
  }
  speck(c, glass, R, 12);
  ground(c);
};

/** Farofa — a mound in a bowl, the grain gouged out of the black. */
RECIPES.farofa = (c, R) => {
  const rim = 0.590, bot = BASE - 0.014, hw = 0.300;
  // bowl and mound cut as one silhouette; the rim is a gouge across it
  const whole = k => { const p = [
      [0.5 - hw + 0.026, rim - 0.004], [0.5 - 0.155, rim - 0.118],
      [0.5 - 0.015, rim - 0.170], [0.5 + 0.150, rim - 0.104],
      [0.5 + hw - 0.026, rim - 0.004], [0.5 + hw, rim]];
    for (let i = 1; i <= 24; i++) { const t = i / 24;
      p.push([0.5 + hw - 2 * hw * t, rim + Math.sin(Math.PI * t) * (bot - rim)]); }
    curve(k, p, true); };
  block(c, whole);
  keyGouge(c, k => poly(k, [[0.5 - hw + 0.014, rim + 0.006], [0.5 + hw - 0.014, rim + 0.006]]), 1.5);
  speck(c, k => { const p = [
      [0.5 - hw + 0.030, rim - 0.006], [0.5 - 0.155, rim - 0.118],
      [0.5 - 0.015, rim - 0.170], [0.5 + 0.150, rim - 0.104],
      [0.5 + hw - 0.030, rim - 0.006]];
    curve(k, p, true); }, R, 60);
  cut(c, whole, { gap: 0.062, band: [0.5, rim + 0.020, 1, bot], k: 0.85 });
  ground(c);
};

/** Vinagrete — the dice are gouges, which is exactly what a relief block does
    with small repeated shapes. */
RECIPES.vinagrete = (c, R) => {
  const rim = 0.605, bot = BASE - 0.014, hw = 0.308;
  const N = c.__lod === 0 ? 5 : 10;
  const heap = [];
  for (let i = 0; i < N; i++) {
    const t = N === 1 ? 0.5 : i / (N - 1);
    heap.push([0.5 + (t - 0.5) * 0.48 + (R() - 0.5) * 0.03,
               rim - 0.052 - Math.cos((t - 0.5) * 2.5) * 0.078 + (R() - 0.5) * 0.034,
               0.062 + R() * 0.014]);
  }
  const whole = k => { const p = [];
    for (let i = 0; i <= 26; i++) { const t = i / 26;
      p.push([0.5 - hw + 0.026 + (2 * hw - 0.052) * t,
              rim - 0.012 - Math.cos((t - 0.5) * 2.4) * 0.100]); }
    p.push([0.5 + hw, rim]);
    for (let i = 1; i <= 24; i++) { const t = i / 24;
      p.push([0.5 + hw - 2 * hw * t, rim + Math.sin(Math.PI * t) * (bot - rim)]); }
    poly(k, p, true); };
  block(c, whole);
  if (c.__lod > 0) {                       // the dice, cut back out of the heap
    c.save(); whole(c); c.clip(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
    heap.forEach(([x, y, s]) => { rrect(c, x - s / 2, y - s / 2, s * 0.72, s * 0.72, 0.005); c.fill(); });
    c.restore();
  }
  keyGouge(c, k => poly(k, [[0.5 - hw + 0.014, rim + 0.006], [0.5 + hw - 0.014, rim + 0.006]]), 1.5);
  cut(c, whole, { gap: 0.062, band: [0.5, rim + 0.020, 1, bot], k: 0.85 });
  ground(c);
};

/** Linguiça — two links, the ties gouged across them. */
RECIPES.linguica = (c, R) => {
  const link = (x0, y0, x1, y1, t) => {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const P = (u, o) => [x0 + ux * L * u + nx * o, y0 + uy * L * u + ny * o];
    const body = k => curve(k, [
      P(0, 0), P(0.10, -t * 1.05), P(0.5, -t * 1.16), P(0.90, -t * 1.05),
      P(1, 0), P(0.90, t * 1.05), P(0.5, t * 1.16), P(0.10, t * 1.05)], true);
    block(c, body);
    keyGouge(c, k => poly(k, [P(0.085, -t * 0.84), P(0.085, t * 0.84)]));
    keyGouge(c, k => poly(k, [P(0.915, -t * 0.84), P(0.915, t * 0.84)]));
    cut(c, body, { gap: 0.058, band: [0, (y0 + y1) / 2, 1, 1], k: 0.8 });
  };
  link(0.140, BASE - 0.072, 0.800, BASE - 0.258, 0.060);
  link(0.178, BASE - 0.042, 0.848, BASE - 0.100, 0.057);
  ground(c);
};

/** Pudim — the caramel runs are gouges down the black. */
RECIPES.pudim = (c, R) => {
  const top = CAP + 0.085, bot = BASE - 0.052, rT = 0.180, rB = 0.295;
  const side = k => { const p = [[0.5 - rT, top], [0.5 - rB, bot]];
    for (let i = 1; i < 22; i++) { const a = Math.PI - Math.PI * i / 22;
      p.push([0.5 + Math.cos(a) * rB, bot - Math.sin(a) * rB * 0.20]); }
    p.push([0.5 + rB, bot], [0.5 + rT, top]);
    poly(k, p, true); };
  block(c, side);
  // the top face and the hole through it
  block(c, k => ell(k, 0.5, top, rT, rT * 0.26));
  if (c.__lod > 0) { c.save(); ell(c, 0.5, top, 0.052, 0.052 * 0.28);
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL; c.fill(); c.restore(); }
  keyGouge(c, k => ell(k, 0.5, top, rT * 0.995, rT * 0.26), 0.7);
  gouge(c, k => curve(k, [[0.5 - rT + 0.024, top + 0.040], [0.5 - rT - 0.010, top + 0.132],
                          [0.5 - rB + 0.058, top + 0.240]]), 1.5);
  gouge(c, k => curve(k, [[0.5 + rT - 0.052, top + 0.034], [0.5 + rT - 0.002, top + 0.118],
                          [0.5 + rB - 0.078, top + 0.206]]), 1.5);
  cut(c, side, { gap: 0.066, band: [0.56, top, 1, bot + 0.05], k: 0.85 });
  speck(c, side, R, 16);
  ground(c);
};

/** Peixe — the scales and the gill are cut, the eye is a hole. */
RECIPES.peixe = (c, R) => {
  const cy = 0.535, L = 0.310, h = 0.148;
  const fish = k => curve(k, [
    [0.5 - L, cy + 0.010], [0.5 - L * 0.45, cy - h], [0.5 + L * 0.22, cy - h * 0.86],
    [0.5 + L * 0.66, cy - h * 0.40], [0.5 + L * 0.66, cy + h * 0.40],
    [0.5 + L * 0.22, cy + h * 0.86], [0.5 - L * 0.45, cy + h]], true);
  block(c, fish);
  block(c, k => poly(k, [[0.5 + L * 0.62, cy], [0.5 + L, cy - h * 0.74],
                         [0.5 + L * 0.90, cy], [0.5 + L, cy + h * 0.74]], true));
  block(c, k => poly(k, [[0.5 - L * 0.22, cy - h * 0.92], [0.5 - L * 0.04, cy - h * 1.38],
                         [0.5 + L * 0.24, cy - h * 0.86]], true));
  // gill
  keyGouge(c, k => { const p = [];
    for (let i = 0; i <= 14; i++) { const a = -1.05 + 2.10 * i / 14;
      p.push([0.5 - L * 0.60 + Math.cos(a) * h * 0.62, cy + Math.sin(a) * h * 0.62]); }
    poly(k, p); }, 1.2);
  // the belly takes the set's one tone; scales are a second vocabulary
  cut(c, fish, { band: [0.5 - L * 0.50, cy + h * 0.05, 0.5 + L * 0.60, 1] });
  // the eye is a hole in the block
  if (c.__lod > 0) { c.save(); ell(c, 0.5 - L * 0.78, cy - h * 0.20, 0.020, 0.020);
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL; c.fill(); c.restore(); }
  ground(c);
};

/** Prato — a place setting, front elevation. The fallback drawing, so it has
    to be the cleanest in the set. */
RECIPES.prato = (c, R) => {
  // A place setting, front elevation. Plate, food and foot are one block; the
  // knife and fork stand either side of it. The fallback drawing, so it has to
  // be the cleanest in the set.
  const ry = BASE - 0.100, w = 0.238;
  const whole = k => { const p = [
      [0.5 - w - 0.082, ry - 0.006], [0.5 - w * 0.62, ry - 0.020],
      [0.5 - w * 0.38, ry - 0.122], [0.5 + 0.010, ry - 0.160],
      [0.5 + w * 0.44, ry - 0.116], [0.5 + w * 0.64, ry - 0.020],
      [0.5 + w + 0.082, ry - 0.006]];
    const q = [...p];
    for (let i = 1; i <= 22; i++) { const t = i / 22;
      q.push([0.5 + w + 0.082 - (2 * w + 0.164) * t, ry + Math.sin(Math.PI * t) * 0.104]); }
    curve(k, q, true); };
  block(c, whole);
  // the rim: one gouge separating the food from the dish
  keyGouge(c, k => poly(k, [[0.5 - w - 0.040, ry + 0.010], [0.5 + w + 0.040, ry + 0.010]]), 1.0);
  speck(c, k => curve(k, [
    [0.5 - w * 0.60, ry - 0.024], [0.5 - w * 0.38, ry - 0.122],
    [0.5 + 0.010, ry - 0.160], [0.5 + w * 0.44, ry - 0.116],
    [0.5 + w * 0.62, ry - 0.024]], true), R, 20);
  block(c, k => poly(k, [[0.5 - 0.086, ry + 0.086], [0.5 + 0.086, ry + 0.086],
                         [0.5 + 0.068, BASE], [0.5 - 0.068, BASE]], true));
  const top = ry - 0.246;
  const fx = 0.5 - w - 0.152;
  block(c, k => poly(k, [[fx - 0.034, top], [fx + 0.034, top],
                         [fx + 0.034, top + 0.104], [fx + 0.017, top + 0.192],
                         [fx + 0.017, BASE], [fx - 0.017, BASE],
                         [fx - 0.017, top + 0.192], [fx - 0.034, top + 0.104]], true));
  gouge(c, k => poly(k, [[fx, top + 0.014], [fx, top + 0.094]]), 0.85);
  const kx = 0.5 + w + 0.152;
  block(c, k => poly(k, [[kx - 0.030, top + 0.028], [kx + 0.030, top + 0.052],
                         [kx + 0.030, top + 0.182], [kx + 0.016, top + 0.202],
                         [kx + 0.016, BASE], [kx - 0.016, BASE],
                         [kx - 0.016, top + 0.202], [kx - 0.030, top + 0.182]], true));
  ground(c);
};

/* ── non-food subjects ────────────────────────────────────────────────────
   A racha is not always a meal. Same block, same rules.                     */

/** Chave — rent, the flat, the beach house. */
RECIPES.chave = (c, R) => {
  const cy = 0.520;
  block(c, k => ell(k, 0.272, cy, 0.118, 0.118));
  c.save(); ell(c, 0.272, cy, 0.054, 0.054); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL; c.fill(); c.restore();
  block(c, k => poly(k, [[0.382, cy - 0.038], [0.796, cy - 0.038],
                         [0.796, cy + 0.038], [0.382, cy + 0.038]], true));
  block(c, k => poly(k, [[0.634, cy + 0.038], [0.676, cy + 0.038],
                         [0.676, cy + 0.128], [0.634, cy + 0.128]], true));
  block(c, k => poly(k, [[0.724, cy + 0.038], [0.766, cy + 0.038],
                         [0.766, cy + 0.102], [0.724, cy + 0.102]], true));
  ground(c);
};

/** Ingresso — show, cinema, the ticket in a pocket. */
RECIPES.ingresso = (c, R) => {
  const x = 0.150, y = 0.330, w = 0.700, h = 0.330, n = 0.046, t = 0.030;
  const tick = k => { const p = [[x, y], [x + w, y]];
    for (let i = 0; i <= 14; i++) { const a = -1.5708 + Math.PI * i / 14;
      p.push([x + w - Math.cos(a) * n, y + h / 2 + Math.sin(a) * n]); }
    p.push([x + w, y + h], [x, y + h]);
    for (let i = 0; i <= 14; i++) { const a = 1.5708 + Math.PI * i / 14;
      p.push([x + Math.cos(a) * -n, y + h / 2 - Math.sin(a) * n]); }
    poly(k, p, true); };
  block(c, tick);
  if (c.__lod > 0) {
    // the field of the ticket is the paper it is printed on
    c.save(); tick(c); c.clip(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
    const q = [[x + t, y + t], [x + w - t, y + t]];
    for (let i = 0; i <= 12; i++) { const a = -1.5708 + Math.PI * i / 12;
      q.push([x + w - t - Math.cos(a) * n * 0.82, y + h / 2 + Math.sin(a) * n * 0.82]); }
    q.push([x + w - t, y + h - t], [x + t, y + h - t]);
    for (let i = 0; i <= 12; i++) { const a = 1.5708 + Math.PI * i / 12;
      q.push([x + t - Math.cos(a) * -n * 0.82, y + h / 2 - Math.sin(a) * n * 0.82]); }
    poly(c, q, true); c.fill(); c.restore();
    // the stub, and the two rules of print on the face
    block(c, k => poly(k, [[x + w * 0.70, y + t], [x + w - t, y + t],
                           [x + w - t, y + h - t], [x + w * 0.70, y + h - t]], true));
    block(c, k => poly(k, [[x + 0.056, y + 0.118], [x + w * 0.56, y + 0.118],
                           [x + w * 0.56, y + 0.150], [x + 0.056, y + 0.150]], true));
    block(c, k => poly(k, [[x + 0.056, y + 0.192], [x + w * 0.42, y + 0.192],
                           [x + w * 0.42, y + 0.224], [x + 0.056, y + 0.224]], true));
    keyGouge(c, k => { const p = [], px = x + w * 0.665;
      for (let yy = y + 0.030; yy < y + h - 0.022; yy += 0.048) p.push([px, yy], [px, yy + 0.024]);
      poly(k, p); }, 1.0);
  }
  ground(c);
};

/** Fardo — the market run, the crate of beer. */
RECIPES.fardo = (c, R) => {
  const top = CAP + 0.090, bot = BASE - 0.012, hw = 0.240;
  const sack = k => curve(k, [
    [0.5 - hw * 0.55, top + 0.048], [0.5 - hw, top + 0.196], [0.5 - hw * 0.96, bot - 0.030],
    [0.5, bot], [0.5 + hw * 0.96, bot - 0.030], [0.5 + hw, top + 0.196],
    [0.5 + hw * 0.55, top + 0.048]], true);
  block(c, sack);
  block(c, k => curve(k, [[0.5 - hw * 0.56, top + 0.052], [0.5 - hw * 0.30, top],
                          [0.5, top - 0.030], [0.5 + hw * 0.30, top],
                          [0.5 + hw * 0.56, top + 0.052]], true));
  keyGouge(c, k => poly(k, [[0.5 - hw * 0.60, top + 0.058], [0.5 + hw * 0.60, top + 0.058]]), 1.3);
  cut(c, sack, { gap: 0.066, band: [0.54, top + 0.10, 1, 1], k: 0.85 });
  speck(c, sack, R, 20);
  ground(c);
};

/** Carro — the road trip, the ride home. */
RECIPES.carro = (c, R) => {
  const gy = BASE - 0.042, wr = 0.064;
  const shell = k => curve(k, [
    [0.112, gy - 0.018], [0.118, gy - 0.100], [0.232, gy - 0.126],
    [0.322, gy - 0.248], [0.618, gy - 0.258], [0.734, gy - 0.130],
    [0.876, gy - 0.100], [0.888, gy - 0.018]], true);
  block(c, shell);
  if (c.__lod > 0) { c.save(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
    poly(c, [[0.346, gy - 0.134], [0.396, gy - 0.226],
             [0.504, gy - 0.230], [0.504, gy - 0.134]], true); c.fill();
    poly(c, [[0.536, gy - 0.134], [0.536, gy - 0.230],
             [0.616, gy - 0.224], [0.686, gy - 0.134]], true); c.fill();
    c.restore(); }
  cut(c, shell, { gap: 0.062, band: [0.10, gy - 0.106, 0.92, 1], k: 0.8 });
  block(c, k => ell(k, 0.294, gy, wr, wr));
  block(c, k => ell(k, 0.716, gy, wr, wr));
  if (c.__lod > 0) { c.save(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
    ell(c, 0.294, gy, wr * 0.40, wr * 0.40); c.fill();
    ell(c, 0.716, gy, wr * 0.40, wr * 0.40); c.fill(); c.restore(); }
  ground(c);
};

/** Bonde — the Lisbon eléctrico, side elevation. A tall box on two wheels
    with a trolley pole; the windows are taken out of the block. */
RECIPES.bonde = (c, R) => {
  const gy = BASE - 0.046, wr = 0.052, top = BASE - 0.430, bot = BASE - 0.070;
  const body = k => rrect(k, 0.150, top, 0.700, bot - top, 0.055);
  // the pole first, so the body buries its foot
  block(c, k => poly(k, [[0.480, top + 0.010], [0.500, top - 0.006],
                         [0.664, CAP + 0.052], [0.648, CAP + 0.040]], true));
  block(c, k => ell(k, 0.658, CAP + 0.046, 0.016, 0.016));
  block(c, body);
  // the roof: a shallow slab set a little wider than the body
  block(c, k => poly(k, [[0.118, top + 0.012], [0.882, top + 0.012],
                         [0.862, top - 0.030], [0.138, top - 0.030]], true));
  if (c.__lod > 0) { c.save(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
    [0.205, 0.415, 0.625].forEach(x => { rrect(c, x, top + 0.066, 0.170, 0.170, 0.012); c.fill(); });
    c.restore(); }
  // the skirt takes the tone
  cut(c, body, { band: [0.15, top + 0.272, 0.85, 1] });
  block(c, k => ell(k, 0.300, gy, wr, wr));
  block(c, k => ell(k, 0.700, gy, wr, wr));
  if (c.__lod > 0) { c.save(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = PAPER_FILL;
    ell(c, 0.300, gy, wr * 0.38, wr * 0.38); c.fill();
    ell(c, 0.700, gy, wr * 0.38, wr * 0.38); c.fill();
    ell(c, 0.836, bot - 0.058, 0.017, 0.017); c.fill();          // the headlamp
    c.restore(); }
  ground(c);
};

/** Carvão — facets, no roundness anywhere. */
RECIPES.carvao = (c, R) => {
  const chunk = (cx, cy, s, rot) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * 6.283 + rot, rr = s * (0.78 + R() * 0.34);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.86]);
    }
    block(c, k => poly(k, pts, true));
    gouge(c, k => poly(k, [pts[0], [cx + (R() - 0.5) * s * 0.3, cy], pts[3]]), 1.2);
    cut(c, k => poly(k, pts, true), { gap: 0.058, band: [cx, cy, 1, 1], k: 0.8 });
  };
  chunk(0.322, BASE - 0.112, 0.138, 0.4);
  chunk(0.678, BASE - 0.100, 0.128, 1.1);
  chunk(0.502, BASE - 0.242, 0.152, 0.15);
  ground(c);
};

/* ── which block for which word ─────────────────────────────────────────── */

const KEYS = [
  [/picanh|carne|churrasc|contra|file|bife|costel|alcatr|espet/i, 'picanha'],
  [/chopp|cervej|beer|brahma|heineken|breja|long ?neck/i,   'chopp'],
  [/caipir|drink|cocktail|gin|vodka|whisk|dose|batida/i,    'caipirinha'],
  [/farofa|arroz|feijao|feijão|purê|pure|polenta/i,         'farofa'],
  [/vinagr|salada|salad|tomate|guacamol|antepast/i,         'vinagrete'],
  [/lingui|linguí|salsich|chouri|sausage/i,                 'linguica'],
  [/pudim|sobremes|doce|brigadeir|pave|pavê|mousse|bolo/i,  'pudim'],
  [/peixe|fish|salmao|salmão|tilapi|camarao|camarão|moqueca/i, 'peixe'],
  [/bonde|tram|el[eé]tric|lisboa/i,                        'bonde'],
  [/carro|uber|gasolin|combust|pedagio|pedágio|taxi|viagem/i,'carro'],
  [/alugue|casa|apart|airbnb|chave|hosped|hotel|pousada/i,  'chave'],
  [/ingress|show|cinema|teatro|balada|festa|ticket/i,       'ingresso'],
  [/mercad|compra|feira|superm|grocer|carvao|carvão|fardo/i,'fardo'],
];

export function recipeFor(name) {
  const n = String(name || '');
  if (RECIPES[n]) return n;
  for (const [re, key] of KEYS) if (re.test(n)) return key;
  return 'prato';
}

/* ── the entry points ─────────────────────────────────────────────────────── */

/** Draw `name` into `canvas` at logical size S. Transparent background. */
export function drawFood(canvas, name, S, seedKey = name, opts = {}) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  canvas.width = Math.round(S * dpr); canvas.height = Math.round(S * dpr);
  canvas.style.width = S + 'px'; canvas.style.height = S + 'px';
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, S, S);
  paint(c, name, S, seedKey, opts);
  return canvas;
}

/** Paint into an already-transformed context occupying [0,S]². */
/* Every subject is printed into the same box — 0.80 wide, from CAP down to
   BASE — bottom-anchored on the ground. Measured once per recipe from the
   drawing itself, so a skewer laid on the diagonal and a mound of farofa come
   out at one size, the way a set of stamps does. */
const FIT = new Map();
export function fitOf(recipe) {
  if (FIT.has(recipe)) return FIT.get(recipe);
  const S = 160, cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S)
    : Object.assign(document.createElement('canvas'), { width: S, height: S });
  const c = cv.getContext('2d');
  c.save(); c.scale(S, S);
  c.__lod = 2; c.__ink = '#000'; c.__k = 7; c.__cw = 0.0185; c.__chip = 0; c.__fit = true;
  RECIPES[recipe](c, rng(fnv(recipe)));
  c.restore();
  const d = c.getImageData(0, 0, S, S).data;
  let x0 = S, y0 = S, x1 = 0, y1 = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (d[(y * S + x) * 4 + 3] > 40) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) ink++;
  const box = x1 > x0 ? [x0 / S, y0 / S, (x1 + 1) / S, (y1 + 1) / S] : [0.1, CAP, 0.9, BASE];
  // How much of its own box the subject fills. A skewer on the diagonal fills a
  // third; a tram fills most. The sparse ones are printed a little larger than
  // the box says, so the set matches by mass and not only by extent.
  box.fill = ink / Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1));
  FIT.set(recipe, box); return box;
}

export function paint(c, name, S, seedKey = name, { paper = PAPER, ink = INK, fit = true, ground: withGround = true } = {}) {
  const lod = lodFor(S), recipe = recipeFor(name);
  c.save();
  c.scale(S, S);
  c.__lod = lod; c.__paper = paper; c.__ink = ink; c.__k = fnv(seedKey) & 63;
  // The gouge widens as the block shrinks, so it never closes up in the print.
  c.__cw = Math.max(0.0185, 1.35 / S) * (lod === 0 ? 1.5 : lod === 1 ? 1.15 : 1);
  // The block chips less on a small cut: there is no room for it to.
  c.__chip = lod === 0 ? 0 : lod === 1 ? 0.0014 : 0.0022;
  c.lineJoin = 'round'; c.lineCap = 'round'; c.miterLimit = 2;
  if (fit) {
    const fitted = fitOf(recipe), [x0, y0, x1, y1] = fitted, bw = x1 - x0, bh = y1 - y0;
    // Fit the box, then correct towards equal ink: the area a subject prints at
    // the fitted size, against one target for the whole set. A tram comes down,
    // a skewer comes up, and the fourteen blocks weigh the same on the page.
    const kFit = Math.min(0.80 / bw, (BASE - CAP) / bh);
    const area = (fitted.fill || 0.5) * bw * bh * kFit * kFit;
    const k = kFit * Math.min(1.18, Math.max(0.74, Math.sqrt(0.185 / Math.max(0.02, area))));
    c.save();
    c.translate(0.5 - (x0 + bw / 2) * k, BASE - y1 * k); c.scale(k, k);
    c.__cw /= k; c.__chip /= k; c.__fit = true;
    RECIPES[recipe](c, rng(fnv(seedKey)));
    c.restore();
    c.__fit = false;
    if (withGround) ground(c);
  } else {
    RECIPES[recipe](c, rng(fnv(seedKey)));
  }
  c.restore();
}

export const RECIPE_NAMES = Object.keys(RECIPES);

/* ── arrangements ─────────────────────────────────────────────────────────
   Several blocks on one baseline, the way a cordel cover groups them: no
   depth, no scaling by distance. They overlap, and the uncut channel of paper
   each one carries is the only cue that one is in front of another.         */
export function drawStill(canvas, plan, W_, H_, seedKey = 'still', { paper = PAPER, ink = INK } = {}) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  canvas.width = Math.round(W_ * dpr); canvas.height = Math.round(H_ * dpr);
  canvas.style.width = W_ + 'px'; canvas.style.height = H_ + 'px';
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W_, H_);
  let horizon = null, cw = 0;
  [...plan].sort((a, b) => a.z - b.z).forEach((item, i) => {
    const side = Math.min(W_, H_) * item.s, top = item.y * H_ - side / 2;
    c.save();
    c.translate(item.x * W_ - side / 2, top);
    paint(c, item.name, side, seedKey + '|' + item.name + '|' + i, { paper, ink, ground: false });
    c.restore();
    horizon = top + BASE * side; cw = Math.max(0.0185, 1.35 / side) * 1.5 * side;
  });
  // One ground under the whole table, not three short ones under three dishes.
  if (horizon !== null) {
    c.fillStyle = ink; c.fillRect(W_ * 0.04, horizon - cw / 2, W_ * 0.92, cw);
  }
}
