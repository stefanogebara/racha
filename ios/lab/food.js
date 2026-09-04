/* ═══════════════════════════════════════════════════════════════════════════
   FOOD — one drawing language, drawn as an engraving.

   Every subject in this app is the same kind of picture: a single-weight ink
   line on paper, seen in flat side elevation, sitting on a common baseline at
   a common cap-height. No gradient, no drop shadow, no specular. Tone — where
   a subject needs any — comes from parallel hatch at one angle and one gap,
   the way a woodcut gets its greys.

   That constraint is the point. A fish, a steak and a glass of beer have
   nothing in common as objects; they become siblings only if the hand that
   drew them never changes. The previous version shaded each dish with its own
   little lighting model and they read as clip art from four different packs.

   The drawing space is the unit square. The caller scales it. Detail is
   dropped by level so that the same recipe survives from a 38px row avatar to
   a 340px hero without either turning to mush or looking bare.
   ═══════════════════════════════════════════════════════════════════════════ */

export const INK   = '#2A231B';
export const PAPER = '#F9F5EC';

/* Optical frame. Every recipe draws its subject to touch BASE at the bottom
   and to reach no higher than CAP, so a row of them shares a horizon.        */
export const CAP = 0.20, BASE = 0.855;

/* ── deterministic randomness ─────────────────────────────────────────────
   Same dish, same picture, forever.                                         */
export const fnv = s => { let h = 0x811c9dc5; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ── the two weights ──────────────────────────────────────────────────────
   An engraving has a contour and a hatch, and that is all. Two weights, in
   fixed ratio, on every subject at every size.                              */
const CONTOUR = 0.0165, DETAIL_RATIO = 0.60;

/* Level of detail. Below ~64px a hatch becomes a grey smudge and a hairline
   disappears, so the drawing simplifies to a contour at a heavier weight —
   the same subject, told with fewer words.                                   */
function lodFor(S) { return S < 64 ? 0 : S < 132 ? 1 : 2; }

/* ── primitives ───────────────────────────────────────────────────────────
   All in unit coordinates. `c` arrives pre-scaled, so a lineWidth set here is
   in unit terms too.                                                        */

function W(c, k = 1) { c.lineWidth = c.__cw * k; }

export function poly(c, pts, close = false) {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  if (close) c.closePath();
}

/** Catmull-Rom through the points, converted to cubics. Organic contours. */
export function curve(c, pts, close = false) {
  const p = close ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  c.beginPath(); c.moveTo(p[1][0], p[1][1]);
  for (let i = 1; i < p.length - 2; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i], [x2, y2] = p[i + 1], [x3, y3] = p[i + 2];
    c.bezierCurveTo(x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6,
                    x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6, x2, y2);
  }
  if (close) c.closePath();
}

export function ell(c, cx, cy, rx, ry, rot = 0) {
  c.beginPath(); c.ellipse(cx, cy, rx, ry, rot, 0, 6.28319);
}

export function rrect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);         c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Solid subject: knock the paper out first so overlapping shapes occlude,
    then lay the contour on top. This is how a subject reads as opaque
    without a single fill of ink. */
export function body(c, shape) { shape(c); c.fillStyle = c.__paper; c.fill(); swell(c, shape); }

/** Contour only — for lines that sit inside an already-knocked-out body. */
export function line(c, shape) { shape(c); W(c); c.stroke(); }

/** The contour, stroked twice: once at weight, then again — heavier — clipped
    to the side of the form that turns away from the light.

    This is the one thing a cut line does that a vector stroke does not. A
    gouge in a block is wider where the blade digs in and finer where it lifts,
    so a woodcut's outline swells along the shadowed edge and thins along the
    lit one. A perfectly uniform stroke around every object is the single
    clearest sign that nobody's hand was involved; the same drawing with the
    weight moving through it reads as cut rather than as generated. The light
    is fixed for the whole set, so the swelling always falls the same way. */
/** A detail line: the second and only other weight. Dropped at lod 0. */
export function detail(c, shape) {
  if (c.__lod < 1) return;
  shape(c); W(c, DETAIL_RATIO); c.stroke();
}

/** Hatch: parallel rules at the house angle, clipped to `shape`.

    Deliberately rationed. Hatching every solid — meat, rice, a sack, a car —
    is filler standing in for observed form, and it is the loudest tell that a
    drawing set was generated rather than drawn. Here it means exactly one
    thing: liquid seen through glass, which is what parallel rules have meant
    in an engraving for three hundred years. Everything else is pure contour,
    and the shapes have to earn their read without it. */
export function hatch(c, shape, { gap = 0.052, band = null, ang = -0.6 } = {}) {
  if (c.__lod < 2) return;
  c.save();
  shape(c); c.clip();
  if (band) { const [x0, y0, x1, y1] = band; c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip(); }
  c.translate(0.5, 0.5); c.rotate(ang); c.translate(-0.5, -0.5);
  c.beginPath();
  for (let x = -0.7; x < 1.8; x += gap) { c.moveTo(x, -0.7); c.lineTo(x, 1.8); }
  W(c, DETAIL_RATIO); c.stroke();
  c.restore();
}

/** Stipple — the hatch's dotted cousin, for crumb and grain. */
export function stipple(c, shape, R, n, r = 0.008) {
  if (c.__lod < 2) return;
  c.save(); shape(c); c.clip();
  c.fillStyle = c.__ink;
  for (let i = 0; i < n; i++) {
    c.beginPath(); c.arc(R(), R(), r * (0.6 + R() * 0.8), 0, 6.283); c.fill();
  }
  c.restore();
}

/** A filled ink mark — an eye, a seed, a pip. The only place ink is solid. */
export function mark(c, shape) { shape(c); c.fillStyle = c.__ink; c.fill(); }

/** The ground. Every subject stands on the same rule, at the same baseline,
    at the same length. That shared horizon is most of what makes fourteen
    unrelated objects read as one set rather than as fourteen stickers. */
export function ground(c) { line(c, k => poly(k, [[0.10, BASE], [0.90, BASE]])); }

export function swell(c, shape) {
  W(c); shape(c); c.stroke();
  if (c.__lod < 1) return;
  c.save();
  // The shadowed side is the half-plane below and right of the terminator,
  // which runs lower-left to upper-right because the light is upper-left.
  // LIGHT is fixed for the whole set, so the weight always moves the same way.
  c.beginPath();
  c.moveTo(-0.8, 1.65); c.lineTo(1.65, -0.8);
  c.lineTo(2.6, -0.8); c.lineTo(2.6, 2.6); c.lineTo(-0.8, 2.6);
  c.closePath(); c.clip();
  W(c, 1.9); shape(c); c.stroke();
  c.restore();
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE RECIPES

   Each one is a side elevation, standing on BASE, reaching no higher than CAP,
   no wider than 0.78 of the frame. Read them as a set: the only differences
   between two subjects should be the differences between the objects.
   ═══════════════════════════════════════════════════════════════════════════ */

const RECIPES = {};

/** Picanha — the fat cap is the identity of the cut, so it is the one line
    that gets drawn twice. Side view on a board. */
RECIPES.picanha = (c, R) => {
  // The espeto, not the raw cut. A steak in elevation is a loaf of bread; three
  // pieces on a skewer is unmistakably a churrasco, and it is the thing a
  // Brazilian table actually sees.
  const x0 = 0.175, y0 = BASE - 0.055, x1 = 0.845, y1 = CAP + 0.045;
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const at = (t, o = 0) => [x0 + ux * L * t + nx * o, y0 + uy * L * t + ny * o];
  // the spit, drawn first and occluded by the meat
  line(c, k => poly(k, [at(-0.03), at(1.03)]));
  [0.24, 0.50, 0.76].forEach((t, i) => {
    const [cx, cy] = at(t);
    const w = 0.108 - i * 0.004, h = 0.082;
    const cut = k => { k.save(); k.translate(cx, cy); k.rotate(Math.atan2(dy, dx));
      curve(k, [[-w, 0.004], [-w * 0.72, -h], [0, -h * 1.14],
                [w * 0.74, -h * 0.92], [w, 0.010],
                [w * 0.70, h * 0.96], [0, h * 1.12], [-w * 0.70, h * 0.94]], true);
      k.restore(); };
    body(c, cut);
    // the fat cap on the upper edge of each piece
    detail(c, k => { k.save(); k.translate(cx, cy); k.rotate(Math.atan2(dy, dx));
      curve(k, [[-w * 0.70, -h * 0.52], [0, -h * 0.66], [w * 0.72, -h * 0.46]]);
      k.restore(); });
  });
  ground(c);
};

/** Chopp — a straight tumbler. The head is the only curved line in it. */
RECIPES.chopp = (c, R) => {
  const top = CAP + 0.045, bot = BASE, hw = 0.152, hwT = 0.182;
  const glass = k => poly(k, [
    [0.5 - hwT, top], [0.5 + hwT, top], [0.5 + hw, bot], [0.5 - hw, bot]], true);
  body(c, glass);
  // The head sits inside the glass with clear air above it, so the rim stays a
  // straight line. A scallop that meets the rim reads as broken glass.
  const foamY = top + 0.135;
  const w = k => 0.5 - hwT + (hwT - hw) * ((k - top) / (bot - top));
  if (c.__lod === 0) { ground(c); return; }   // the small cut: glass and fill only
  line(c, k => curve(k, [
    [w(foamY) + 0.004, foamY - 0.005], [0.5 - 0.095, foamY - 0.042],
    [0.5 - 0.025, foamY + 0.004], [0.5 + 0.055, foamY - 0.038],
    [0.5 + 0.115, foamY + 0.006], [1 - w(foamY) - 0.004, foamY - 0.010]]));
  const beer = k => poly(k, [
    [w(foamY) + 0.014, foamY + 0.020], [1 - w(foamY) - 0.014, foamY + 0.020],
    [0.5 + hw - 0.014, bot - 0.014], [0.5 - hw + 0.014, bot - 0.014]], true);
  hatch(c, beer, { gap: 0.062 });
  if (c.__lod >= 2) [[0.42, 0.30], [0.57, 0.46], [0.47, 0.62], [0.61, 0.72]]
    .forEach(([bx, bt]) => detail(c, k => ell(k, bx, foamY + 0.06 + bt * 0.28, 0.011, 0.011)));
  ground(c);
};

/** Caipirinha — a rocks glass. Lime as two wedges, ice as two squares. */
RECIPES.caipirinha = (c, R) => {
  const top = CAP + 0.115, bot = BASE, hw = 0.150, hwT = 0.172;
  const glass = k => poly(k, [
    [0.5 - hwT, top], [0.5 + hwT, top], [0.5 + hw, bot], [0.5 - hw, bot]], true);
  body(c, glass);
  const fill = top + 0.070;
  line(c, k => poly(k, [[0.5 - hwT + 0.007, fill], [0.5 + hwT - 0.007, fill]]));
  hatch(c, k => poly(k, [
    [0.5 - hwT + 0.012, fill], [0.5 + hwT - 0.012, fill],
    [0.5 + hw - 0.012, bot - 0.012], [0.5 - hw + 0.012, bot - 0.012]], true), { gap: 0.062 });
  if (c.__lod > 0) {
    // ice: two cubes breaking the fill line, which is what makes it read as ice
    body(c, k => rrect(k, 0.402, fill - 0.028, 0.098, 0.098, 0.013));
    body(c, k => rrect(k, 0.512, fill + 0.052, 0.090, 0.090, 0.013));
    // lime wedge straddling the rim, kept clear of the frame
    const lx = 0.5 + hwT - 0.050, ly = top;
    body(c, k => { k.beginPath(); k.arc(lx, ly, 0.088, Math.PI, 0); k.closePath(); });
    detail(c, k => { k.beginPath();
      for (let i = 1; i < 4; i++) { const a = Math.PI * i / 4;
        k.moveTo(lx, ly); k.lineTo(lx - Math.cos(a) * 0.080, ly - Math.sin(a) * 0.080); } });
  }
  ground(c);
};

/** Farofa — a mound in a shallow bowl. Grain by stipple, nothing else. */
RECIPES.farofa = (c, R) => {
  const rim = 0.575, bot = BASE - 0.02, hw = 0.30;
  const mound = k => curve(k, [
    [0.5 - hw + 0.03, rim], [0.5 - 0.16, rim - 0.115], [0.5 - 0.02, rim - 0.165],
    [0.5 + 0.15, rim - 0.10], [0.5 + hw - 0.03, rim]], false);
  body(c, k => { mound(k); k.closePath(); });
  stipple(c, k => { mound(k); k.closePath(); }, R, 190, 0.0075);
  const bowl = k => { k.beginPath(); k.moveTo(0.5 - hw, rim);
    k.bezierCurveTo(0.5 - hw + 0.01, bot, 0.5 + hw - 0.01, bot, 0.5 + hw, rim); };
  body(c, k => { bowl(k); k.closePath(); });
  line(c, k => poly(k, [[0.5 - hw - 0.035, rim], [0.5 + hw + 0.035, rim]]));
  ground(c);
};

/** Vinagrete — dice in a shallow dish. Cubes seen in the same elevation. */
RECIPES.vinagrete = (c, R) => {
  const rim = 0.60, bot = BASE - 0.02, hw = 0.315;
  const dish = k => { k.beginPath(); k.moveTo(0.5 - hw, rim);
    k.bezierCurveTo(0.5 - hw + 0.02, bot, 0.5 + hw - 0.02, bot, 0.5 + hw, rim); k.closePath(); };
  // heap of dice above the rim
  const heap = [];
  const N = c.__lod === 0 ? 5 : 11;   // eleven dice at 33px is grey mush
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    heap.push([0.5 + (t - 0.5) * 0.50 + (R() - 0.5) * 0.03,
               rim - 0.045 - Math.cos((t - 0.5) * 2.6) * 0.085 + (R() - 0.5) * 0.04,
               0.052 + R() * 0.016]);
  }
  heap.sort((a, b) => a[1] - b[1]);
  heap.forEach(([x, y, s]) => body(c, k => rrect(k, x - s / 2, y - s / 2, s, s, 0.008)));
  body(c, dish);
  line(c, k => poly(k, [[0.5 - hw - 0.035, rim], [0.5 + hw + 0.035, rim]]));
  ground(c);
};

/** Linguiça — a coil on a grill. Two concentric contours and the links. */
RECIPES.linguica = (c, R) => {
  // Two links, side on. The coil was the one drawing seen from above, and at
  // small sizes it read as a lens or an eye rather than as a sausage.
  const link = (x0, y0, x1, y1, t) => {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const P = (u, o) => [x0 + ux * L * u + nx * o, y0 + uy * L * u + ny * o];
    body(c, k => curve(k, [
      P(0, 0), P(0.10, -t * 1.05), P(0.5, -t * 1.16), P(0.90, -t * 1.05),
      P(1, 0), P(0.90, t * 1.05), P(0.5, t * 1.16), P(0.10, t * 1.05)], true));
    // the tie at each end
    detail(c, k => poly(k, [P(0.085, -t * 0.86), P(0.085, t * 0.86)]));
    detail(c, k => poly(k, [P(0.915, -t * 0.86), P(0.915, t * 0.86)]));
  };
  link(0.135, BASE - 0.060, 0.800, BASE - 0.250, 0.058);
  link(0.175, BASE - 0.032, 0.845, BASE - 0.092, 0.055);
  ground(c);
};

/** Pudim — a truncated cone with the hole through it, and the caramel run. */
RECIPES.pudim = (c, R) => {
  const top = CAP + 0.075, bot = BASE - 0.055, rT = 0.185, rB = 0.30;
  const side = k => { k.beginPath();
    k.moveTo(0.5 - rT, top); k.lineTo(0.5 - rB, bot);
    k.ellipse(0.5, bot, rB, rB * 0.20, 0, Math.PI, 0, true);
    k.lineTo(0.5 + rT, top); k.closePath(); };
  body(c, side);
  // the top face and the hole
  body(c, k => ell(k, 0.5, top, rT, rT * 0.26));
  body(c, k => ell(k, 0.5, top, 0.055, 0.055 * 0.26));
  // caramel running down two sides
  detail(c, k => curve(k, [[0.5 - rT + 0.02, top + 0.035], [0.5 - rT - 0.015, top + 0.13],
                           [0.5 - rB + 0.055, top + 0.235]]));
  detail(c, k => curve(k, [[0.5 + rT - 0.055, top + 0.03], [0.5 + rT - 0.005, top + 0.115],
                           [0.5 + rB - 0.075, top + 0.20]]));
  ground(c);
};

/** Peixe — a whole fish on the plate, nose left, in strict elevation. */
RECIPES.peixe = (c, R) => {
  const cy = 0.545, L = 0.315, h = 0.145;
  const fish = k => curve(k, [
    [0.5 - L, cy + 0.012], [0.5 - L * 0.45, cy - h], [0.5 + L * 0.22, cy - h * 0.86],
    [0.5 + L * 0.66, cy - h * 0.40], [0.5 + L * 0.66, cy + h * 0.40],
    [0.5 + L * 0.22, cy + h * 0.86], [0.5 - L * 0.45, cy + h],
  ], true);
  body(c, fish);
  // tail
  body(c, k => poly(k, [[0.5 + L * 0.63, cy], [0.5 + L, cy - h * 0.72],
                        [0.5 + L * 0.90, cy], [0.5 + L, cy + h * 0.72]], true));
  // dorsal
  detail(c, k => poly(k, [[0.5 - L * 0.22, cy - h * 0.93], [0.5 - L * 0.05, cy - h * 1.35],
                          [0.5 + L * 0.24, cy - h * 0.88]]));
  // gill and eye
  detail(c, k => { k.beginPath(); k.arc(0.5 - L * 0.60, cy, h * 0.62, -1.05, 1.05); });
  mark(c, k => ell(k, 0.5 - L * 0.78, cy - h * 0.22, 0.017, 0.017));
  ground(c);
};

/** Prato — a plate with a fork and knife laid across it. The generic subject:
    used whenever a dish has no drawing of its own, so it has to be the most
    neutral and the best-drawn of the set. */
RECIPES.prato = (c, R) => {
  // Front elevation, like everything else in the set. A plate drawn from above
  // is a different camera, and one different camera in fourteen drawings is
  // enough to break the whole thing back into fourteen stickers.
  const ry = BASE - 0.085, w = 0.235;
  // the food on it, first, so the plate's rim knocks out over the base of it
  body(c, k => curve(k, [
    [0.5 - w * 0.72, ry - 0.004], [0.5 - w * 0.42, ry - 0.115],
    [0.5 + 0.01, ry - 0.152], [0.5 + w * 0.46, ry - 0.108],
    [0.5 + w * 0.74, ry - 0.004]], true));
  // the plate: a shallow dish seen edge-on, with its foot
  body(c, k => { k.beginPath();
    k.moveTo(0.5 - w - 0.075, ry);
    k.bezierCurveTo(0.5 - w, ry + 0.072, 0.5 + w, ry + 0.072, 0.5 + w + 0.075, ry);
    k.closePath(); });
  detail(c, k => poly(k, [[0.5 - 0.072, ry + 0.062], [0.5 - 0.072, BASE],
                          [0.5 + 0.072, BASE], [0.5 + 0.072, ry + 0.062]]));
  // fork and knife standing either side, at the plate's own height
  const top = ry - 0.235;
  const fx = 0.5 - w - 0.145;
  body(c, k => { k.beginPath();
    k.moveTo(fx - 0.028, top); k.lineTo(fx - 0.028, top + 0.100);
    k.bezierCurveTo(fx - 0.028, top + 0.146, fx - 0.013, top + 0.156, fx - 0.013, top + 0.184);
    k.lineTo(fx - 0.013, BASE); k.lineTo(fx + 0.013, BASE);
    k.lineTo(fx + 0.013, top + 0.184);
    k.bezierCurveTo(fx + 0.013, top + 0.156, fx + 0.028, top + 0.146, fx + 0.028, top + 0.100);
    k.lineTo(fx + 0.028, top); k.closePath(); });
  detail(c, k => poly(k, [[fx, top], [fx, top + 0.088]]));
  const kx = 0.5 + w + 0.145;
  body(c, k => { k.beginPath();
    k.moveTo(kx - 0.024, top + 0.028);
    k.bezierCurveTo(kx - 0.028, top, kx + 0.024, top - 0.004, kx + 0.024, top + 0.046);
    k.lineTo(kx + 0.024, top + 0.176); k.lineTo(kx + 0.012, top + 0.196);
    k.lineTo(kx + 0.012, BASE); k.lineTo(kx - 0.012, BASE);
    k.lineTo(kx - 0.012, top + 0.196); k.lineTo(kx - 0.024, top + 0.176); k.closePath(); });
  ground(c);
};

/* ── non-food subjects ────────────────────────────────────────────────────
   A racha is not always a meal. These follow exactly the same rules.        */

/** Chave — a key. Rent, the flat, the beach house. */
RECIPES.chave = (c, R) => {
  const cy = 0.53;
  body(c, k => ell(k, 0.275, cy, 0.115, 0.115));
  body(c, k => ell(k, 0.275, cy, 0.048, 0.048));
  body(c, k => poly(k, [[0.385, cy - 0.036], [0.795, cy - 0.036],
                        [0.795, cy + 0.036], [0.385, cy + 0.036]], true));
  body(c, k => poly(k, [[0.635, cy + 0.036], [0.675, cy + 0.036],
                        [0.675, cy + 0.125], [0.635, cy + 0.125]], true));
  body(c, k => poly(k, [[0.725, cy + 0.036], [0.765, cy + 0.036],
                        [0.765, cy + 0.10], [0.725, cy + 0.10]], true));
  ground(c);
};

/** Ingresso — a ticket, with the tear notches and the perforation. */
RECIPES.ingresso = (c, R) => {
  const x = 0.145, y = 0.335, w = 0.71, h = 0.33, n = 0.045;
  const tick = k => { k.beginPath();
    k.moveTo(x, y); k.lineTo(x + w, y);
    k.lineTo(x + w, y + h / 2 - n); k.arc(x + w, y + h / 2, n, -Math.PI / 2, Math.PI / 2, true);
    k.lineTo(x + w, y + h); k.lineTo(x, y + h);
    k.lineTo(x, y + h / 2 + n); k.arc(x, y + h / 2, n, Math.PI / 2, -Math.PI / 2, true);
    k.closePath(); };
  body(c, tick);
  // perforation
  detail(c, k => { k.beginPath(); const px = x + w * 0.68;
    for (let yy = y + 0.028; yy < y + h - 0.02; yy += 0.042) { k.moveTo(px, yy); k.lineTo(px, yy + 0.021); } });
  // two rules standing in for the print
  detail(c, k => poly(k, [[x + 0.05, y + 0.115], [x + w * 0.60, y + 0.115]]));
  detail(c, k => poly(k, [[x + 0.05, y + 0.185], [x + w * 0.44, y + 0.185]]));
  ground(c);
};

/** Fardo — a sack. Groceries, the market run, the crate of beer. */
RECIPES.fardo = (c, R) => {
  const top = CAP + 0.085, bot = BASE - 0.01, hw = 0.245;
  const sack = k => curve(k, [
    [0.5 - hw * 0.55, top + 0.045], [0.5 - hw, top + 0.19], [0.5 - hw * 0.96, bot - 0.03],
    [0.5, bot + 0.01], [0.5 + hw * 0.96, bot - 0.03], [0.5 + hw, top + 0.19],
    [0.5 + hw * 0.55, top + 0.045],
  ], true);
  body(c, sack);
  // the gathered neck
  body(c, k => curve(k, [[0.5 - hw * 0.56, top + 0.05], [0.5 - hw * 0.30, top],
                         [0.5, top - 0.028], [0.5 + hw * 0.30, top],
                         [0.5 + hw * 0.56, top + 0.05]], true));
  detail(c, k => poly(k, [[0.5 - hw * 0.58, top + 0.055], [0.5 + hw * 0.58, top + 0.055]]));
  ground(c);
};

/** Carro — a car in strict side elevation. The road trip, the Uber home. */
RECIPES.carro = (c, R) => {
  const gy = BASE - 0.035, wr = 0.062;
  const shell = k => curve(k, [
    [0.115, gy - 0.02], [0.12, gy - 0.10], [0.235, gy - 0.125],
    [0.325, gy - 0.245], [0.62, gy - 0.255], [0.735, gy - 0.128],
    [0.875, gy - 0.10], [0.885, gy - 0.02],
  ], true);
  body(c, shell);
  // glasshouse
  detail(c, k => poly(k, [[0.345, gy - 0.132], [0.395, gy - 0.225],
                          [0.505, gy - 0.228], [0.505, gy - 0.132]], true));
  detail(c, k => poly(k, [[0.535, gy - 0.132], [0.535, gy - 0.228],
                          [0.615, gy - 0.222], [0.685, gy - 0.132]], true));
  body(c, k => ell(k, 0.295, gy, wr, wr));
  body(c, k => ell(k, 0.715, gy, wr, wr));
  detail(c, k => ell(k, 0.295, gy, wr * 0.42, wr * 0.42));
  detail(c, k => ell(k, 0.715, gy, wr * 0.42, wr * 0.42));
  ground(c);
};

/** Carvão — three chunks on a heap. Facets, no roundness anywhere. */
RECIPES.carvao = (c, R) => {
  const chunk = (cx, cy, s, rot) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * 6.283 + rot, rr = s * (0.78 + R() * 0.34);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.86]);
    }
    body(c, k => poly(k, pts, true));
    // one facet crease, so it reads as broken rather than as a pebble
    detail(c, k => poly(k, [pts[0], [cx + (R() - 0.5) * s * 0.3, cy], pts[3]]));
  };
  chunk(0.325, BASE - 0.105, 0.135, 0.4);
  chunk(0.675, BASE - 0.095, 0.125, 1.1);
  chunk(0.505, BASE - 0.235, 0.150, 0.15);
  ground(c);
};

/* ── which drawing for which word ────────────────────────────────────────── */

const KEYS = [
  [/picanh|carne|churrasc|contra|file|bife|costel|alcatr/i, 'picanha'],
  [/chopp|cervej|beer|brahma|heineken|breja|long ?neck/i,   'chopp'],
  [/caipir|drink|cocktail|gin|vodka|whisk|dose|batida/i,    'caipirinha'],
  [/farofa|arroz|feijao|feijão|purê|pure|polenta/i,         'farofa'],
  [/vinagr|salada|salad|tomate|guacamol|antepast/i,         'vinagrete'],
  [/lingui|linguí|salsich|chouri|sausage/i,                 'linguica'],
  [/pudim|sobremes|doce|brigadeir|pave|pavê|mousse|bolo/i,  'pudim'],
  [/peixe|fish|salmao|salmão|tilapi|camarao|camarão|moqueca/i, 'peixe'],
  [/alugue|casa|apart|airbnb|chave|hosped|hotel|pousada/i,  'chave'],
  [/ingress|show|cinema|teatro|balada|festa|ticket/i,       'ingresso'],
  [/mercad|compra|feira|superm|grocer|carvao|carvão|fardo/i,'fardo'],
  [/carro|uber|gasolin|combust|pedagio|pedágio|taxi|viagem/i,'carro'],
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
export function paint(c, name, S, seedKey = name, { paper = PAPER, ink = INK } = {}) {
  const lod = lodFor(S);
  c.save();
  c.scale(S, S);
  c.__lod = lod; c.__paper = paper; c.__ink = ink;
  // The contour thickens as the drawing shrinks, so it never fades out.
  c.__cw = Math.max(CONTOUR, 1.25 / S) * (lod === 0 ? 1.55 : lod === 1 ? 1.15 : 1);
  c.strokeStyle = ink; c.lineJoin = 'round'; c.lineCap = 'round'; c.miterLimit = 2;
  RECIPES[recipeFor(name)](c, rng(fnv(seedKey)));
  c.restore();
}

export const RECIPE_NAMES = Object.keys(RECIPES);

/* ── arrangements ─────────────────────────────────────────────────────────
   Several subjects on one baseline, the way a menu illustration groups them:
   no depth, no scaling by distance, no fading. They overlap and occlude, and
   that is the only cue that one is in front of another.                     */
export function drawStill(canvas, plan, W_, H_, seedKey = 'still', { paper = PAPER } = {}) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  canvas.width = Math.round(W_ * dpr); canvas.height = Math.round(H_ * dpr);
  canvas.style.width = W_ + 'px'; canvas.style.height = H_ + 'px';
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W_, H_);
  // Back to front by z, so nearer subjects knock out the ones behind.
  [...plan].sort((a, b) => a.z - b.z).forEach((item, i) => {
    const side = Math.min(W_, H_) * item.s;
    c.save();
    c.translate(item.x * W_ - side / 2, item.y * H_ - side / 2);
    paint(c, item.name, side, seedKey + '|' + item.name + '|' + i, { paper });
    c.restore();
  });
}
