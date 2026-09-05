#!/usr/bin/env python3
"""
Turn a generated cream-paper print into a shippable asset: an ALPHA MASK.

Why a mask and not the PNG as generated: the app's night theme is cream ink on
near-black umbra (decision #27). A baked cream background would be a pale
rectangle sitting on a dark screen. So the paper becomes transparent and the ink
becomes alpha — then Palette paints it, and the same file works cream-on-umbra
and black-on-cream. This is the same logic food.js already uses with
destination-out: paper is where ink is not.

Also normalises scale: every subject is fitted to one box by INK MASS, not by
bounding box, so a skewer on the diagonal and a mound of farofa print at the
same weight — the way a set of stamps does. (Ported from fitOf() in food.js.)
"""
import sys, pathlib
from PIL import Image, ImageOps
import numpy as np
from scipy import ndimage

BOX = 0.74          # fraction of the canvas the ink may occupy
OUT = 512
TARGET_MASS = 0.078     # measured median of the set at scale 1; the stamp-book weight

def alpha_of(path):
    im = Image.open(path).convert('L')
    a = np.asarray(im).astype(np.float32) / 255.0
    # Paper is the bright mode; take it from the border, which is always margin.
    edge = np.concatenate([a[:8].ravel(), a[-8:].ravel(), a[:, :8].ravel(), a[:, -8:].ravel()])
    paper = float(np.median(edge))
    # A one-block relief print is BIMODAL by construction: the block either
    # touched the paper or it did not. Measured, these come back with true ink
    # at L<0.15 and a separate bump at L~0.45-0.52 — that bump is the cast
    # shadow the model invented, which the process cannot make. So the ramp is
    # steep and sits low: full ink well under the shadow's luminance, zero above
    # it. Real antialiased ink edges cross that band in a pixel or two and keep
    # their soft edge; a broad mid-grey shadow lands entirely on zero.
    ink = np.clip((paper * 0.42 - a) / (paper * 0.22), 0.0, 1.0)
    ink[ink < 0.06] = 0.0
    # Drop specks: a stray dot near the frame edge drags the bounding box out
    # and the subject shrinks to nothing. Keep only blobs worth a gouge.
    lab, n = ndimage.label(ink > 0.35)
    if n:
        keep = np.zeros(n + 1, bool)
        sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        keep[1:] = sizes >= max(ink.size * 2.5e-4, 24)
        ink = ink * keep[lab]
    return ink

def fit(ink):
    ys, xs = np.nonzero(ink > 0.35)
    if len(xs) == 0:
        raise SystemExit('nada de tinta na imagem')
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    crop = ink[y0:y1, x0:x1]
    h, w = crop.shape
    side = max(h, w)
    sq = np.zeros((side, side), np.float32)
    sq[(side - h) // 2:(side - h) // 2 + h, (side - w) // 2:(side - w) // 2 + w] = crop
    # Equal-MASS correction, not equal-bounding-box. A skewer laid on the
    # diagonal fills its box with mostly paper; a pudim fills it with ink. Fit
    # by box alone and the set reads as one big blob next to one thin scratch —
    # which is exactly what the raws did (2.6% ink vs 20%). Coverage goes with
    # area, so the scale that moves coverage c to the target is sqrt(t/c). It is
    # CLAMPED: a genuinely light subject is allowed to stay lighter than a
    # genuinely heavy one, or the skewer would grow off the plate to earn mass.
    # Coverage of the fitted square at scale 1, in the SAME units as
    # TARGET_MASS (fraction of the whole canvas).
    at1 = float(np.asarray(Image.fromarray((sq * 255).astype(np.uint8))
                           .resize((OUT, OUT), Image.LANCZOS)).mean()) / 255.0 * BOX ** 2
    # Coverage goes with area, so the scale that moves at1 to the target is
    # sqrt(t/at1). Clamped both ways: a thin skewer must not grow off the plate
    # to earn mass, and a solid salad bowl is allowed to stay the heaviest thing
    # in the book. Never past the canvas — scaling past it silently CROPS, which
    # is what made five of these come out at an identical 4.3%.
    s = min(max((TARGET_MASS / max(at1, 1e-4)) ** 0.5, 0.70), 1.0 / BOX)
    inner = min(int(round(OUT * BOX * s)), OUT)
    small = Image.fromarray((sq * 255).astype(np.uint8)).resize((inner, inner), Image.LANCZOS)
    out = Image.new('L', (OUT, OUT), 0)
    out.paste(small, ((OUT - inner) // 2, (OUT - inner) // 2))
    return out

def main(src, dst):
    mask = fit(alpha_of(src))
    # Ink colour is decided by the app; the file carries only coverage.
    rgba = Image.merge('RGBA', [Image.new('L', mask.size, 0)] * 3 + [mask])
    pathlib.Path(dst).parent.mkdir(parents=True, exist_ok=True)
    rgba.save(dst, optimize=True)
    cover = np.asarray(mask).astype(np.float32).mean() / 255.0
    print(f'{pathlib.Path(dst).name}: massa de tinta {cover*100:.1f}%')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
